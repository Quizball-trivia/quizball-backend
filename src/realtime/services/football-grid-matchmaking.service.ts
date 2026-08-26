import { randomInt, randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import {
  trackFootballGridMatchFound,
  trackFootballGridQueueJoined,
  trackFootballGridQueueLeft,
} from '../../core/analytics/game-events.js';
import {
  footballGridRepo,
  footballGridService,
  FOOTBALL_GRID_HANDOFF_MS,
  type FootballGridState,
} from '../../modules/football-grid/index.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import { syntheticBotSelectionService } from '../../modules/synthetic-bots/synthetic-bot-selection.service.js';
import { syntheticBotsRepo } from '../../modules/synthetic-bots/synthetic-bots.repo.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { FootballGridSearchStatePayload } from '../socket.types.js';
import { footballGridRealtimeService } from './football-grid-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';

const QUEUE_KEY = 'football_grid:mm:queue';
const USER_MAP_KEY = 'football_grid:mm:user';
const SEARCH_PREFIX = 'football_grid:mm:search:';
const PAIRING_USER_PREFIX = 'session:pairing:user:';
const LOCK_KEY = 'lock:football_grid:mm';
const LOCK_TTL_MS = 12_000;
const SEARCH_TTL_SEC = 180;
const MAX_SEARCH_AGE_MS = SEARCH_TTL_SEC * 1_000;
const MATCH_SCAN_LIMIT = 100;
const MAX_CONCURRENT_HUMAN_PAIR_STARTS = 12;
const MAX_PAIR_START_FAILURES_PER_SWEEP = 3;
// One committed batch per lock cycle lets another replica acquire the next
// cycle while this replica performs its post-commit handoff delivery.
const MAX_HUMAN_PAIR_BATCHES_PER_SWEEP = 1;
const REPEAT_SOFT_LIMIT = 3;
const PAIR_COUNT_CACHE_TTL_SEC = 60;
const FALLBACK_TIMER_KIND = 'football_grid_matchmaking_fallback' as const;
const PAIRING_RECOVERY_INTERVAL_MS = 10_000;
const PAIRING_CLAIM_LEASE_MS = 90_000;
const PAIRING_HEARTBEAT_INTERVAL_MS = 15_000;
let pairingRecoveryTimer: NodeJS.Timeout | null = null;
let pairingRecoveryRunning = false;
let matchmakingSweepTimer: NodeJS.Timeout | null = null;
let matchmakingSweepRunning = false;

interface QueuedGridSearch {
  searchId: string;
  userId: string;
  displayName: string;
  locale: 'en' | 'ka';
  queuedAt: number;
  fallbackAt: number;
}

interface HumanPairStart {
  pairingToken: string;
  state: FootballGridState;
  searches: [QueuedGridSearch, QueuedGridSearch];
}

interface HumanPairBatch {
  startedPairs: HumanPairStart[];
  attemptedPairs: number;
  failedSearchIds: string[];
  failures: number;
}

interface BotPairStart {
  pairingToken: string;
  state: FootballGridState;
  search: QueuedGridSearch;
  botUserId: string;
}

function searchKey(searchId: string): string {
  return `${SEARCH_PREFIX}${searchId}`;
}

function pairingUserKey(userId: string): string {
  return `${PAIRING_USER_PREFIX}${userId}`;
}

function pairCountCacheKey(userAId: string, userBId: string): string {
  return `football_grid:mm:pair_count:${[userAId, userBId].sort().join(':')}`;
}

function searchExpiresAt(search: QueuedGridSearch): number {
  return search.queuedAt + MAX_SEARCH_AGE_MS;
}

function isSearchExpired(search: QueuedGridSearch, now = Date.now()): boolean {
  return now >= searchExpiresAt(search);
}

function nextFallbackAt(search: QueuedGridSearch, now = Date.now()): number {
  return Math.min(
    searchExpiresAt(search),
    now + harnessDelayMs(config.FOOTBALL_GRID_BOT_FALLBACK_MS, 1_000),
  );
}

async function withMatchmakingLock<T>(callback: () => Promise<T>): Promise<T | null> {
  const lock = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return null;
  const heartbeat = startLockHeartbeat(LOCK_KEY, lock.token, LOCK_TTL_MS);
  try {
    return await callback();
  } finally {
    heartbeat.stop();
    await releaseLock(LOCK_KEY, lock.token).catch(() => {});
  }
}

async function readSearch(searchId: string): Promise<QueuedGridSearch | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  const raw = await redis.get(searchKey(searchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QueuedGridSearch;
    return parsed.searchId === searchId && typeof parsed.userId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSearch(search: QueuedGridSearch): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) throw new Error('GRID_QUEUE_UNAVAILABLE');
  const remainingMs = searchExpiresAt(search) - Date.now();
  if (remainingMs <= 0) throw new Error('GRID_SEARCH_EXPIRED');
  await redis.multi()
    .set(searchKey(search.searchId), JSON.stringify(search), { EX: Math.max(1, Math.ceil(remainingMs / 1_000)) })
    .hSet(USER_MAP_KEY, search.userId, search.searchId)
    .zAdd(QUEUE_KEY, [{ score: search.queuedAt, value: search.searchId }])
    .exec();
}

async function removeSearch(search: QueuedGridSearch): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.multi()
    .zRem(QUEUE_KEY, search.searchId)
    .hDel(USER_MAP_KEY, search.userId)
    .del(searchKey(search.searchId))
    .exec();
  await cancelRealtimeTimer(FALLBACK_TIMER_KIND, search.searchId);
}

async function listSearches(io: QuizballServer): Promise<QueuedGridSearch[]> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return [];
  const ids = await redis.zRange(QUEUE_KEY, 0, MATCH_SCAN_LIMIT - 1);
  const searches = await Promise.all(ids.map(readSearch));
  const valid = searches.filter((entry): entry is QueuedGridSearch => entry !== null);
  const staleIds = ids.filter((id) => !valid.some((entry) => entry.searchId === id));
  if (staleIds.length > 0) await redis.zRem(QUEUE_KEY, staleIds);
  const expired = valid.filter((search) => isSearchExpired(search));
  for (const search of expired) {
    await expireSearch(io, search);
  }
  return valid
    .filter((search) => !isSearchExpired(search))
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

async function scheduleFallback(search: QueuedGridSearch): Promise<void> {
  await scheduleRealtimeTimer(
    FALLBACK_TIMER_KIND,
    search.searchId,
    new Date(search.fallbackAt),
    { kind: FALLBACK_TIMER_KIND, searchId: search.searchId, userId: search.userId },
  );
}

function parseSearchSnapshot(value: Record<string, unknown> | null): QueuedGridSearch | null {
  if (
    !value
    || typeof value.searchId !== 'string'
    || typeof value.userId !== 'string'
    || typeof value.displayName !== 'string'
    || (value.locale !== 'en' && value.locale !== 'ka')
    || typeof value.queuedAt !== 'number'
    || typeof value.fallbackAt !== 'number'
  ) return null;
  return value as unknown as QueuedGridSearch;
}

async function restoreSearch(io: QuizballServer, search: QueuedGridSearch): Promise<boolean> {
  if (isSearchExpired(search)) return false;
  const session = await userSessionGuardService.resolveState(search.userId);
  if (
    session.activeMatchId
    || session.openLobbyIds.length > 0
    || (session.queueSearchId !== null && session.queueSearchId !== search.searchId)
  ) return false;
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const currentSearchId = await redis.hGet(USER_MAP_KEY, search.userId);
  if (currentSearchId && currentSearchId !== search.searchId) return false;
  const restored: QueuedGridSearch = {
    ...search,
    fallbackAt: nextFallbackAt(search),
  };
  await writeSearch(restored);
  await scheduleFallback(restored);
  emitSearchState(io, restored.userId, {
    state: 'searching',
    searchId: restored.searchId,
    queuedAt: new Date(restored.queuedAt).toISOString(),
    fallbackAt: new Date(restored.fallbackAt).toISOString(),
  });
  return true;
}

async function restoreSearchOrIdle(io: QuizballServer, search: QueuedGridSearch): Promise<boolean> {
  const restored = await restoreSearch(io, search).catch((error) => {
    logger.warn({ error, searchId: search.searchId }, 'Football Grid search restoration failed');
    return false;
  });
  if (restored) return true;
  await removeSearch(search).catch(() => {});
  emitSearchState(io, search.userId, { state: 'idle', searchId: search.searchId });
  await userSessionGuardService.emitState(io, search.userId).catch(() => {});
  return false;
}

function emitSearchState(
  io: QuizballServer,
  userId: string,
  payload: FootballGridSearchStatePayload,
): void {
  io.to(`user:${userId}`).emit('grid:search_state', payload);
}

async function expireSearch(io: QuizballServer, search: QueuedGridSearch): Promise<void> {
  await removeSearch(search);
  trackFootballGridQueueLeft({
    userId: search.userId,
    searchId: search.searchId,
    reason: 'expired',
    queuedAt: new Date(search.queuedAt),
  });
  emitSearchState(io, search.userId, { state: 'idle', searchId: search.searchId });
  await userSessionGuardService.emitState(io, search.userId);
}

async function claimPairingUsers(userIds: string[], pairingToken: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const keys = [...new Set(userIds)].sort().map(pairingUserKey);
  const script = `
    for i = 1, #KEYS do
      if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
    end
    for i = 1, #KEYS do
      redis.call('SET', KEYS[i], ARGV[1], 'PX', ARGV[2])
    end
    return 1
  `;
  return await redis.eval(script, {
    keys,
    arguments: [pairingToken, String(PAIRING_CLAIM_LEASE_MS)],
  }) === 1;
}

async function releasePairingUsers(userIds: string[], pairingToken: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const keys = [...new Set(userIds)].sort().map(pairingUserKey);
  const script = `
    for i = 1, #KEYS do
      if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
    end
    return 1
  `;
  await redis.eval(script, { keys, arguments: [pairingToken] });
}

async function withPairingHeartbeat<T>(pairingToken: string, work: () => Promise<T>): Promise<T> {
  if (!await footballGridRepo.heartbeatPairing(pairingToken)) {
    throw new Error('GRID_PAIRING_CLAIM_LOST');
  }
  let active = true;
  let heartbeatRunning = false;
  const timer = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void footballGridRepo.heartbeatPairing(pairingToken)
      .then((renewed) => {
        if (!renewed && active) {
          logger.warn({ pairingToken }, 'Football Grid pairing heartbeat lost its claim');
        }
      })
      .catch((error) => {
        logger.warn({ error, pairingToken }, 'Football Grid pairing heartbeat failed');
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, PAIRING_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    active = false;
    clearInterval(timer);
  }
}

async function chooseOpponent(anchor: QueuedGridSearch, candidates: QueuedGridSearch[]): Promise<QueuedGridSearch | null> {
  const eligible = candidates.filter((candidate) => candidate.userId !== anchor.userId);
  const oldestFallback = eligible[0] ?? null;
  if (!oldestFallback) return null;
  const redis = getRedisClient();
  const cacheKeys = eligible.map((candidate) => pairCountCacheKey(anchor.userId, candidate.userId));
  const cached = redis?.isOpen ? await redis.mGet(cacheKeys) : cacheKeys.map(() => null);
  const missing = eligible.filter((_, index) => cached[index] === null);
  const fresh = await footballGridRepo.countRecentPairingsForCandidates(
    anchor.userId,
    missing.map((candidate) => candidate.userId),
  );
  if (redis?.isOpen && missing.length > 0) {
    await Promise.all(missing.map((candidate) => redis.set(
      pairCountCacheKey(anchor.userId, candidate.userId),
      String(fresh.get(candidate.userId) ?? 0),
      { EX: PAIR_COUNT_CACHE_TTL_SEC },
    )));
  }
  for (let index = 0; index < eligible.length; index += 1) {
    const recent = cached[index] === null
      ? fresh.get(eligible[index].userId) ?? 0
      : Number(cached[index]);
    if (recent < REPEAT_SOFT_LIMIT) return eligible[index];
  }
  return oldestFallback;
}

async function searchesStillExclusivelyQueued(searches: QueuedGridSearch[]): Promise<boolean> {
  if (searches.some((search) => isSearchExpired(search))) return false;
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const currentIds = await Promise.all(searches.map((search) => redis.hGet(USER_MAP_KEY, search.userId)));
  if (searches.some((search, index) => currentIds[index] !== search.searchId)) return false;
  const currentSearches = await Promise.all(searches.map((search) => readSearch(search.searchId)));
  if (currentSearches.some((search, index) => search?.userId !== searches[index].userId)) return false;
  const snapshots = await userSessionGuardService.resolveStates(searches.map((search) => search.userId));
  return searches.every((search) => {
    const snapshot = snapshots.get(search.userId);
    return snapshot?.state === 'IN_QUEUE'
      && snapshot.queueSearchId === search.searchId
      && snapshot.activeMatchId === null
      && snapshot.openLobbyIds.length === 0;
  });
}

async function startHumanPair(io: QuizballServer, a: QueuedGridSearch, b: QueuedGridSearch): Promise<HumanPairStart | null> {
  const paired = await userSessionGuardService.withUserSessionLocks(
    [a.userId, b.userId],
    async () => {
      if (!await searchesStillExclusivelyQueued([a, b])) return null;
      const pairingToken = randomUUID();
      if (!await claimPairingUsers([a.userId, b.userId], pairingToken)) return null;
      try {
        let state: FootballGridState;
        try {
          await footballGridRepo.createPairing({
            pairingToken,
            searchAId: a.searchId,
            searchBId: b.searchId,
            userAId: a.userId,
            userBId: b.userId,
            opponentType: 'human',
            searchASnapshot: { ...a },
            searchBSnapshot: { ...b },
          });
          emitSearchState(io, a.userId, { state: 'pairing', searchId: a.searchId });
          emitSearchState(io, b.userId, { state: 'pairing', searchId: b.searchId });
          await removeSearch(a);
          await removeSearch(b);
          const openerUserId = randomInt(2) === 0 ? a.userId : b.userId;
          state = (await withPairingHeartbeat(pairingToken, () => (
            footballGridService.createMatch({
              pairingToken,
              origin: 'random',
              players: [
                { userId: a.userId, seat: 1 },
                { userId: b.userId, seat: 2 },
              ],
              openerUserId,
            })
          ))).state;
        } catch (error) {
          logger.error({ error, pairingToken, userIds: [a.userId, b.userId] }, 'Football Grid human pairing failed');
          await footballGridRepo.markPairingFailed(pairingToken, error instanceof Error ? error.message : 'unknown').catch(() => {});
          await Promise.all([
            restoreSearchOrIdle(io, a),
            restoreSearchOrIdle(io, b),
          ]);
          return null;
        }
        return { pairingToken, state, searches: [a, b] as [QueuedGridSearch, QueuedGridSearch] };
      } finally {
        await releasePairingUsers([a.userId, b.userId], pairingToken).catch(() => {});
      }
    },
    { waitMs: 1_200 },
  );
  return paired ?? null;
}

async function deliverHumanPair(io: QuizballServer, result: HumanPairStart): Promise<void> {
  const { pairingToken, state, searches } = result;
  const [a, b] = searches;
  // This function is deliberately invoked only after the global matchmaking
  // lock has been released. The handoff recovery loop owns redelivery, so all
  // transport and analytics work is best-effort.
  try {
    emitSearchState(io, a.userId, { state: 'matched', searchId: a.searchId });
    emitSearchState(io, b.userId, { state: 'matched', searchId: b.searchId });
    await footballGridRealtimeService.emitMatchFound(io, state);
    appMetrics.footballGridMatches.add(1, { opponent_type: 'human', origin: 'random' });
    appMetrics.footballGridQueueWaitDuration.record(
      Date.now() - Math.min(a.queuedAt, b.queuedAt),
      { opponent_type: 'human' },
    );
    void Promise.all([
      userSessionGuardService.emitState(io, a.userId),
      userSessionGuardService.emitState(io, b.userId),
    ]).catch((error) => {
      logger.warn({ error, pairingToken, matchId: state.matchId }, 'Football Grid session-state refresh deferred');
    });
  } catch (error) {
    logger.warn({ error, pairingToken, matchId: state.matchId }, 'Football Grid human handoff deferred to recovery');
  }
  try {
    const deadlineMs = Date.parse(state.phaseDeadlineAt ?? '');
    const matchedAt = new Date(Number.isFinite(deadlineMs) ? deadlineMs - FOOTBALL_GRID_HANDOFF_MS : Date.now());
    for (const search of searches) {
      trackFootballGridQueueLeft({
        userId: search.userId,
        searchId: search.searchId,
        reason: 'matched',
        queuedAt: new Date(search.queuedAt),
        leftAt: matchedAt,
        opponentType: 'human',
      });
      trackFootballGridMatchFound({
        userId: search.userId,
        matchId: state.matchId,
        searchId: search.searchId,
        origin: 'random',
        opponentType: 'human',
        queueWaitMs: Math.max(0, matchedAt.getTime() - search.queuedAt),
        boardId: state.board.boardId,
        boardVersion: state.board.boardVersion,
        occurredAt: matchedAt,
      });
    }
  } catch (error) {
    logger.warn({ error, pairingToken, matchId: state.matchId }, 'Football Grid human pairing analytics failed');
  }
}

async function tryStartHumanPairBatchLocked(
  io: QuizballServer,
  excludedSearchIds: ReadonlySet<string>,
): Promise<HumanPairBatch> {
  const startedPairs: HumanPairStart[] = [];
  if (!config.FOOTBALL_GRID_QUEUE_ENABLED || !config.FOOTBALL_GRID_CONTENT_ENABLED) {
    return { startedPairs, attemptedPairs: 0, failedSearchIds: [], failures: 0 };
  }
  const searches = (await listSearches(io))
    .filter((search) => !excludedSearchIds.has(search.searchId));
  if (searches.length < 2) {
    return { startedPairs, attemptedPairs: 0, failedSearchIds: [], failures: 0 };
  }
  const remaining = [...searches];
  const pairs: Array<[QueuedGridSearch, QueuedGridSearch]> = [];
  while (remaining.length >= 2 && pairs.length < MAX_CONCURRENT_HUMAN_PAIR_STARTS) {
    const anchor = remaining.shift()!;
    const opponent = await chooseOpponent(anchor, remaining);
    if (!opponent) break;
    const opponentIndex = remaining.findIndex((candidate) => candidate.searchId === opponent.searchId);
    if (opponentIndex < 0) break;
    remaining.splice(opponentIndex, 1);
    pairs.push([anchor, opponent]);
  }
  if (pairs.length === 0) {
    return { startedPairs, attemptedPairs: 0, failedSearchIds: [], failures: 0 };
  }
  const outcomes = await Promise.all(pairs.map(([anchor, opponent]) => (
    startHumanPair(io, anchor, opponent)
  )));
  const failedSearchIds: string[] = [];
  let failures = 0;
  outcomes.forEach((outcome, index) => {
    if (outcome) {
      startedPairs.push(outcome);
      return;
    }
    failures += 1;
    failedSearchIds.push(pairs[index][0].searchId, pairs[index][1].searchId);
  });
  return { startedPairs, attemptedPairs: pairs.length, failedSearchIds, failures };
}

async function deliverHumanPairs(io: QuizballServer, pairs: HumanPairStart[]): Promise<void> {
  await Promise.allSettled(pairs.map((pair) => deliverHumanPair(io, pair)));
}

async function runHumanPairSweep(io: QuizballServer): Promise<boolean> {
  const failedSearchIds = new Set<string>();
  let failures = 0;
  let acquiredAtLeastOnce = false;
  for (let batchIndex = 0; batchIndex < MAX_HUMAN_PAIR_BATCHES_PER_SWEEP; batchIndex += 1) {
    const batch = await withMatchmakingLock(() => tryStartHumanPairBatchLocked(io, failedSearchIds));
    if (batch === null) return acquiredAtLeastOnce;
    acquiredAtLeastOnce = true;

    // Deliver every committed batch immediately after releasing the global
    // lock. Deferring all delivery until a multi-batch drain completed let the
    // 15-second handoff deadline expire before clients ever saw match_found.
    await deliverHumanPairs(io, batch.startedPairs);
    for (const searchId of batch.failedSearchIds) failedSearchIds.add(searchId);
    failures += batch.failures;
    if (batch.attemptedPairs === 0 || failures >= MAX_PAIR_START_FAILURES_PER_SWEEP) break;
  }
  return acquiredAtLeastOnce;
}

async function startBotPair(io: QuizballServer, search: QueuedGridSearch): Promise<BotPairStart | null> {
  if (isSearchExpired(search)) return null;
  if (!config.FOOTBALL_GRID_QUEUE_ENABLED || !config.FOOTBALL_GRID_CONTENT_ENABLED) return null;
  if (!config.FOOTBALL_GRID_BOTS_ENABLED || !reservationService.isEnabled()) return null;
  const humanProfile = await rankedService.ensureProfile(search.userId);
  const paired = await userSessionGuardService.withUserSessionLocks([search.userId], async () => {
    if (!await searchesStillExclusivelyQueued([search])) return null;
    const selected = await syntheticBotSelectionService.selectAndReserve({
      humanUserId: search.userId,
      humanProfile,
      lobbyId: search.searchId,
    });
    if (!selected) return null;
    const pairingToken = randomUUID();
    if (!await claimPairingUsers([search.userId], pairingToken)) {
      await reservationService.abortLobby(search.searchId, 'match_found_cancel');
      return null;
    }
    try {
      let state: FootballGridState;
      try {
        await footballGridRepo.createPairing({
          pairingToken,
          searchAId: search.searchId,
          userAId: search.userId,
          userBId: selected.bot.user_id,
          opponentType: 'bot',
          searchASnapshot: { ...search },
        });
        emitSearchState(io, search.userId, { state: 'pairing', searchId: search.searchId });
        await removeSearch(search);
        const openerUserId = randomInt(2) === 0 ? search.userId : selected.bot.user_id;
        const seed = randomInt(1, 2_147_483_647);
        state = (await withPairingHeartbeat(pairingToken, () => (
          footballGridService.createMatch({
            pairingToken,
            origin: 'random',
            players: [
              { userId: search.userId, seat: 1 },
              { userId: selected.bot.user_id, seat: 2, isBot: true },
            ],
            openerUserId,
            botReservationFence: selected.reservation.fence,
            botRp: selected.bot.rp,
            botTier: selected.bot.tier,
            botModelVersion: config.FOOTBALL_GRID_BOT_MODEL_VERSION,
            botConfigVersion: 1,
            botRngSeed: seed,
            afterCreateInTx: async (tx, matchId) => {
              const transferred = await reservationService.transferInTx(tx, {
                botUserId: selected.bot.user_id,
                lobbyId: search.searchId,
                matchId,
              });
              if (!transferred) throw new Error('GRID_BOT_RESERVATION_LOST');
              await syntheticBotsRepo.bumpMatchesTodayAndSelectedAtTx(tx, selected.bot.user_id);
            },
          })
        ))).state;
      } catch (error) {
        logger.error({ error, pairingToken, userId: search.userId, botUserId: selected.bot.user_id }, 'Football Grid bot pairing failed');
        await footballGridRepo.markPairingFailed(pairingToken, error instanceof Error ? error.message : 'unknown').catch(() => {});
        await reservationService.abortLobby(search.searchId, 'match_found_cancel');
        await restoreSearchOrIdle(io, search);
        return null;
      }
      return { pairingToken, state, search, botUserId: selected.bot.user_id };
    } finally {
      await releasePairingUsers([search.userId], pairingToken).catch(() => {});
    }
  }, { waitMs: 1_200 });
  return paired ?? null;
}

async function deliverBotPair(io: QuizballServer, result: BotPairStart): Promise<void> {
  const { pairingToken, state, search, botUserId } = result;
  try {
    await syntheticBotSelectionService.recordRecentlyFaced(search.userId, botUserId);
    emitSearchState(io, search.userId, { state: 'matched', searchId: search.searchId });
    await footballGridRealtimeService.emitMatchFound(io, state);
    appMetrics.footballGridMatches.add(1, { opponent_type: 'bot', origin: 'random' });
    appMetrics.footballGridQueueWaitDuration.record(Date.now() - search.queuedAt, { opponent_type: 'bot' });
    await userSessionGuardService.emitState(io, search.userId);
  } catch (error) {
    logger.warn({ error, pairingToken, matchId: state.matchId }, 'Football Grid bot handoff deferred to recovery');
  }
  try {
    const deadlineMs = Date.parse(state.phaseDeadlineAt ?? '');
    const matchedAt = new Date(Number.isFinite(deadlineMs) ? deadlineMs - FOOTBALL_GRID_HANDOFF_MS : Date.now());
    trackFootballGridQueueLeft({
      userId: search.userId,
      searchId: search.searchId,
      reason: 'matched',
      queuedAt: new Date(search.queuedAt),
      leftAt: matchedAt,
      opponentType: 'bot',
    });
    trackFootballGridMatchFound({
      userId: search.userId,
      matchId: state.matchId,
      searchId: search.searchId,
      origin: 'random',
      opponentType: 'bot',
      queueWaitMs: Math.max(0, matchedAt.getTime() - search.queuedAt),
      boardId: state.board.boardId,
      boardVersion: state.board.boardVersion,
      occurredAt: matchedAt,
    });
  } catch (error) {
    logger.warn({ error, pairingToken, matchId: state.matchId }, 'Football Grid bot pairing analytics failed');
  }
}

export const footballGridMatchmakingService = {
  async reconcileStalePairings(io: QuizballServer): Promise<void> {
    await withMatchmakingLock(async () => {
      const pairings = await footballGridRepo.listStaleClaimedPairings();
      for (const pairing of pairings) {
        const searchA = parseSearchSnapshot(pairing.searchASnapshot);
        const searchB = parseSearchSnapshot(pairing.searchBSnapshot);
        const humanSearches = [searchA, pairing.opponentType === 'human' ? searchB : null]
          .filter((search): search is QueuedGridSearch => search !== null);
        const userIds = humanSearches.map((search) => search.userId);
        if (!searchA || (pairing.opponentType === 'human' && !searchB)) {
          const failed = await footballGridRepo.markPairingFailed(pairing.pairingToken, 'missing_recovery_snapshot');
          appMetrics.footballGridPairingRecovery.add(1, { outcome: failed ? 'missing_snapshot' : 'claim_already_resolved' });
          await releasePairingUsers([pairing.userAId, pairing.userBId], pairing.pairingToken).catch(() => {});
          continue;
        }
        const recovered = await userSessionGuardService.withUserSessionLocks(userIds, async () => {
          const failed = await footballGridRepo.markPairingFailed(
            pairing.pairingToken,
            'recovered_after_interrupted_pairing',
          );
          // Creation may have committed after the stale list snapshot. A
          // matched/failed claim must never have its users restored to queue.
          if (!failed) return false;
          if (pairing.opponentType === 'bot') {
            await reservationService.abortLobby(searchA.searchId, 'match_found_cancel').catch((error) => {
              logger.warn({ error, searchId: searchA.searchId }, 'Football Grid stale bot reservation cleanup failed');
            });
          }
          let restoredCount = 0;
          for (const search of humanSearches) {
            const restored = await restoreSearchOrIdle(io, search);
            if (restored) restoredCount += 1;
          }
          appMetrics.footballGridPairingRecovery.add(1, {
            outcome: restoredCount === humanSearches.length ? 'requeued' : restoredCount === 0 ? 'idle' : 'partial_requeue',
          });
          return true;
        }, { waitMs: 1_200 });
        if (recovered === null) continue;
        if (!recovered) {
          await releasePairingUsers([pairing.userAId, pairing.userBId], pairing.pairingToken).catch(() => {});
          continue;
        }
        await releasePairingUsers([pairing.userAId, pairing.userBId], pairing.pairingToken).catch(() => {});
      }
    });
  },

  startRecovery(io: QuizballServer): void {
    if (pairingRecoveryTimer) return;
    const run = async () => {
      if (pairingRecoveryRunning) return;
      pairingRecoveryRunning = true;
      try {
        await this.reconcileStalePairings(io);
      } finally {
        pairingRecoveryRunning = false;
      }
    };
    pairingRecoveryTimer = setInterval(() => void run().catch((error) => {
      logger.warn({ error }, 'Football Grid pairing recovery failed');
    }), PAIRING_RECOVERY_INTERVAL_MS);
    pairingRecoveryTimer.unref?.();
    void run().catch((error) => logger.warn({ error }, 'Football Grid initial pairing recovery failed'));
  },

  startSweep(io: QuizballServer): void {
    if (matchmakingSweepTimer || config.FOOTBALL_GRID_MM_SWEEP_MS === 0) return;
    const run = async () => {
      if (matchmakingSweepRunning) return;
      matchmakingSweepRunning = true;
      try {
        // A busy distributed lock means another replica is already draining.
        // That is the expected steady-state path and is intentionally silent.
        await runHumanPairSweep(io);
      } finally {
        matchmakingSweepRunning = false;
      }
    };
    matchmakingSweepTimer = setInterval(() => void run().catch((error) => {
      logger.warn({ error }, 'Football Grid matchmaking sweep failed');
    }), config.FOOTBALL_GRID_MM_SWEEP_MS);
    matchmakingSweepTimer.unref?.();
    void run().catch((error) => logger.warn({ error }, 'Football Grid initial matchmaking sweep failed'));
  },

  stopSweep(): void {
    if (matchmakingSweepTimer) clearInterval(matchmakingSweepTimer);
    matchmakingSweepTimer = null;
    matchmakingSweepRunning = false;
  },

  async handleSearchStart(io: QuizballServer, socket: QuizballSocket, input: { locale: 'en' | 'ka' }): Promise<void> {
    const userId = socket.data.user.id;
    appMetrics.footballGridQueueJoins.add(1);
    if (!config.FOOTBALL_GRID_QUEUE_ENABLED || !config.FOOTBALL_GRID_CONTENT_ENABLED) {
      socket.emit('grid:error', { code: 'GRID_UNAVAILABLE', message: 'Football Tic Tac Toe is temporarily unavailable' });
      return;
    }
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      socket.emit('grid:error', { code: 'GRID_QUEUE_UNAVAILABLE', message: 'Matchmaking is temporarily unavailable' });
      return;
    }
    const activeMatchId = await footballGridRepo.getActiveMatchIdForUser(userId);
    if (activeMatchId) {
      const outcome = await footballGridService.resolveStaleMatchOnSearchStart({
        matchId: activeMatchId,
        userId,
      });
      if (outcome === 'resumable') {
        const state = await footballGridService.getState(activeMatchId, userId);
        // emitMatchFound re-reads authoritative state; when it reports the
        // match terminalized mid-flight we sweep and fall through to a fresh
        // search instead of leaving the player's request unanswered.
        const resumed = state.phase !== 'terminal'
          ? await footballGridRealtimeService.emitMatchFound(io, state)
          : false;
        if (resumed) return;
      }
      if (activeMatchId) {
        // Clear local replicas' stale bindings for the dead match. Sockets on
        // other replicas keep their binding, but disconnect cleanup now
        // consults the DB instead of trusting it.
        const sockets = await io.in(`user:${userId}`).fetchSockets().catch(() => []);
        for (const s of sockets) {
          if (s.data.gridMatchId === activeMatchId) s.data.gridMatchId = undefined;
          if (s.data.matchId === activeMatchId) s.data.matchId = undefined;
        }
      }
      // 'gone', cancelled, or resumable-but-terminalized: fresh search.
    }
    // Queue admission is per-user and does not need the global pairing lock.
    // Keeping it behind the global lock made a burst behave like a try-lock:
    // every caller except the current match creator was rejected instead of
    // being durably queued.
    const transitioned = await userSessionGuardService.withUserSessionLock(userId, async () => {
        const prepared = await userSessionGuardService.prepareForQueueJoin(io, userId, 'grid');
        if (!prepared.ok) {
          userSessionGuardService.emitBlocked(socket, {
            reason: prepared.reason ?? 'ACTIVE_MATCH',
            message: prepared.message ?? 'You are already in an active session',
            operation: 'grid:search_start',
            stateSnapshot: prepared.snapshot,
          });
          return false;
        }
        const existingId = await redis.hGet(USER_MAP_KEY, userId);
        if (existingId) {
          const existing = await readSearch(existingId);
          if (existing && !isSearchExpired(existing)) {
            emitSearchState(io, userId, {
              state: 'searching', searchId: existing.searchId,
              queuedAt: new Date(existing.queuedAt).toISOString(),
              fallbackAt: new Date(existing.fallbackAt).toISOString(),
            });
            await scheduleFallback(existing);
            return true;
          }
          if (existing) await removeSearch(existing);
          else await redis.hDel(USER_MAP_KEY, userId);
        }
        const now = Date.now();
        const search: QueuedGridSearch = {
          searchId: randomUUID(),
          userId,
          displayName: socket.data.user.nickname ?? 'Player',
          locale: input.locale,
          queuedAt: now,
          fallbackAt: Math.min(
            now + MAX_SEARCH_AGE_MS,
            now + harnessDelayMs(config.FOOTBALL_GRID_BOT_FALLBACK_MS, 1_000),
          ),
        };
        await writeSearch(search);
        await scheduleFallback(search);
        trackFootballGridQueueJoined({
          userId,
          searchId: search.searchId,
          locale: search.locale,
          queuedAt: new Date(search.queuedAt),
        });
        emitSearchState(io, userId, {
          state: 'searching', searchId: search.searchId,
          queuedAt: new Date(search.queuedAt).toISOString(),
          fallbackAt: new Date(search.fallbackAt).toISOString(),
        });
        return true;
    }, { waitMs: 1_200 });
    if (transitioned === null) {
      socket.emit('grid:error', { code: 'GRID_SEARCH_BUSY', message: 'Tic Tac Toe search is already changing. Please retry.' });
      return;
    }
    if (!transitioned) return;
    // A busy drainer is not an admission failure: this search is already in
    // Redis and its durable fallback timer will retry pairing.
    await runHumanPairSweep(io);
  },

  async handleSearchCancel(io: QuizballServer, socket: QuizballSocket, expectedSearchId: string): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    const userId = socket.data.user.id;
    const locked = await withMatchmakingLock(async () => {
      const transitioned = await userSessionGuardService.withUserSessionLock(userId, async () => {
        const searchId = await redis.hGet(USER_MAP_KEY, userId);
        if (searchId && searchId !== expectedSearchId) {
          const current = await readSearch(searchId);
          if (current) {
            emitSearchState(io, userId, {
              state: 'searching',
              searchId: current.searchId,
              queuedAt: new Date(current.queuedAt).toISOString(),
              fallbackAt: new Date(current.fallbackAt).toISOString(),
            });
          }
          return true;
        }
        const search = searchId ? await readSearch(searchId) : null;
        if (search) {
          await removeSearch(search);
          trackFootballGridQueueLeft({
            userId,
            searchId: search.searchId,
            reason: 'cancelled',
            queuedAt: new Date(search.queuedAt),
          });
        }
        emitSearchState(io, userId, { state: 'idle', searchId: expectedSearchId });
        await userSessionGuardService.emitState(io, userId);
        return true;
      }, { waitMs: 1_200 });
      if (transitioned === null) {
        socket.emit('grid:error', { code: 'GRID_SEARCH_BUSY', message: 'Tic Tac Toe search is already changing. Please retry.' });
      }
    });
    if (locked === null) socket.emit('grid:error', { code: 'GRID_SEARCH_BUSY', message: 'Matchmaking is busy. Please retry.' });
  },

  async handleFallbackTimer(io: QuizballServer, searchId: string, userId?: string): Promise<void> {
    // Give the periodic human drainer first refusal. It releases the global
    // lock and delivers after every batch, so a fallback cannot sit behind a
    // long undelivered handoff backlog.
    const drained = await runHumanPairSweep(io);
    if (!drained) {
      const retryUserId = userId ?? (await readSearch(searchId))?.userId;
      if (!retryUserId) return;
      await scheduleRealtimeTimer(
        FALLBACK_TIMER_KIND,
        searchId,
        new Date(Date.now() + 250),
        { kind: FALLBACK_TIMER_KIND, searchId, userId: retryUserId },
      );
      return;
    }
    let botPair: BotPairStart | null = null;
    const locked = await withMatchmakingLock(async () => {
      const search = await readSearch(searchId);
      if (!search) {
        if (userId) {
          const redis = getRedisClient();
          if (redis?.isOpen && await redis.hGet(USER_MAP_KEY, userId) === searchId) {
            await redis.multi().zRem(QUEUE_KEY, searchId).hDel(USER_MAP_KEY, userId).exec();
            emitSearchState(io, userId, { state: 'idle', searchId });
            await userSessionGuardService.emitState(io, userId);
          }
        }
        return;
      }
      if (isSearchExpired(search)) {
        await expireSearch(io, search);
        return;
      }
      const remaining = await readSearch(searchId);
      if (!remaining) return;
      if (isSearchExpired(remaining)) {
        await expireSearch(io, remaining);
        return;
      }
      // Never substitute a bot while another human pair can still be formed.
      // A later periodic pass will drain those searches in a fresh batch.
      if ((await listSearches(io)).length >= 2) {
        const rearmed = { ...remaining, fallbackAt: nextFallbackAt(remaining) };
        await writeSearch(rearmed);
        await scheduleFallback(rearmed);
        return;
      }
      botPair = await startBotPair(io, remaining);
      if (!botPair && await readSearch(searchId)) {
        if (isSearchExpired(remaining)) {
          await expireSearch(io, remaining);
          return;
        }
        const rearmed = { ...remaining, fallbackAt: nextFallbackAt(remaining) };
        await writeSearch(rearmed);
        await scheduleFallback(rearmed);
      }
    });
    if (locked !== null) {
      if (botPair) await deliverBotPair(io, botPair);
    }
    if (locked === null) {
      // The durable timer has fired and is now consumed. Re-arm a short retry
      // without rewriting queue state; if the search was paired meanwhile the
      // next callback simply observes that it is gone.
      const retryUserId = userId ?? (await readSearch(searchId))?.userId;
      if (!retryUserId) return;
      await scheduleRealtimeTimer(
        FALLBACK_TIMER_KIND,
        searchId,
        new Date(Date.now() + 250),
        { kind: FALLBACK_TIMER_KIND, searchId, userId: retryUserId },
      );
    }
  },

  async handleSocketDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    if (socket.data.lobbyId) return;
    // A stale gridMatchId (cancelled/gone match, possibly bound on another
    // replica we cannot mutate) must not skip search cleanup. Trust the
    // database, not the binding.
    if (socket.data.gridMatchId) {
      const bound = await footballGridRepo.loadState(socket.data.gridMatchId).catch(() => null);
      if (bound && bound.phase !== 'terminal') return;
    }
    const userId = socket.data.user.id;
    const others = await io.in(`user:${userId}`).fetchSockets().catch(() => []);
    if (others.some((candidate) => candidate.id !== socket.id)) return;
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    await withMatchmakingLock(async () => {
      await userSessionGuardService.withUserSessionLock(userId, async () => {
        const searchId = await redis.hGet(USER_MAP_KEY, userId);
        const search = searchId ? await readSearch(searchId) : null;
        if (search) await removeSearch(search);
        if (searchId) emitSearchState(io, userId, { state: 'idle', searchId });
      }, { waitMs: 1_200 });
    });
  },
};
