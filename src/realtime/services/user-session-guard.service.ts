import { transferHostIfNeeded, removeUserFromLobbySockets, emitClosedLobbyStateForMode } from './lobby-membership.helpers.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import type { LobbyWithJoinedAt } from '../../modules/lobbies/lobbies.types.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { trackMatchAbandoned, trackStaleLobbyHealed } from '../../core/analytics/game-events.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import { RANKED_MM_CANCEL_SEARCH_SCRIPT } from '../lua/ranked-matchmaking.scripts.js';
import type { SessionBlockedPayload, SessionStatePayload } from '../socket.types.js';
import { withSpan } from '../../core/tracing.js';
import {
  matchDisconnectKey,
  matchExitPendingKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchReconnectFenceKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import { rankedPairingInFlightKey } from '../ranked-matchmaking-keys.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { isUserDroppedFromPartyMatch } from '../party-quiz-state.js';
import { resolveOrphanPossessionMatchTerminal } from './match-orphan-resolver.service.js';
import { abandonMatchWithCompleteLock } from './match-terminal.service.js';
import { resolveMatchReplayEvidence } from './match-entry.service.js';
import { auctionStateStore } from '../../modules/auction/auction-state.store.js';
import { hasPendingRealtimeTimer } from '../realtime-timer-scheduler.js';

const SESSION_LOCK_TTL_MS = 4000;
const LOBBY_LOCK_TTL_MS = 4000;
export const SESSION_LOCK_WAIT_MS = 1200;
const SESSION_LOCK_RETRY_INTERVAL_MS = 75;
const RANKED_QUEUE_KEY = 'ranked:mm:queue';
const RANKED_TIMEOUTS_KEY = 'ranked:mm:timeouts';
const RANKED_USER_MAP_KEY = 'ranked:mm:user';
const RANKED_SEARCH_KEY_PREFIX = 'ranked:mm:search:';
const AUCTION_QUEUE_KEY = 'auction:mm:queue';
const AUCTION_USER_MAP_KEY = 'auction:mm:user';
const AUCTION_SEARCH_KEY_PREFIX = 'auction:mm:search:';
const GRID_QUEUE_KEY = 'football_grid:mm:queue';
const GRID_USER_MAP_KEY = 'football_grid:mm:user';
const GRID_SEARCH_KEY_PREFIX = 'football_grid:mm:search:';
const SHARED_PAIRING_USER_KEY_PREFIX = 'session:pairing:user:';
const STALE_ACTIVE_MATCH_MS = 15 * 60 * 1000;
const STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS = 90 * 1000;
const STALE_ACTIVE_LOBBY_MS = 30 * 60 * 1000;

const SIMPLE_MM_CANCEL_SEARCH_SCRIPT = `
local queueKey = KEYS[1]
local userMapKey = KEYS[2]
local searchKey = KEYS[3]
local userId = ARGV[1]
local expectedSearchId = ARGV[2]

redis.call('ZREM', queueKey, expectedSearchId)
redis.call('DEL', searchKey)
if redis.call('HGET', userMapKey, userId) == expectedSearchId then
  redis.call('HDEL', userMapKey, userId)
  return 1
end
return 0
`;

function sharedPairingUserKey(userId: string): string {
  return `${SHARED_PAIRING_USER_KEY_PREFIX}${userId}`;
}

async function releaseSharedActivityFences(userIds: string[], fenceToken: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const keys = [...new Set(userIds)].sort().map(sharedPairingUserKey);
  await redis.eval(`
    for i = 1, #KEYS do
      if redis.call('GET', KEYS[i]) == ARGV[1] then redis.call('DEL', KEYS[i]) end
    end
    return 1
  `, { keys, arguments: [fenceToken] });
}

async function renewSharedActivityFences(
  userIds: string[],
  fenceToken: string,
  ttlMs: number,
): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const keys = [...new Set(userIds)].sort().map(sharedPairingUserKey);
  return await redis.eval(`
    for i = 1, #KEYS do
      if redis.call('GET', KEYS[i]) ~= ARGV[1] then return 0 end
    end
    for i = 1, #KEYS do redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
    return 1
  `, { keys, arguments: [fenceToken, String(ttlMs)] }) === 1;
}

type ResolveContext = {
  activeMatch: Awaited<ReturnType<typeof matchesRepo.getActiveMatchForUser>> | null;
  queueSearchId: string | null;
  queueKind: 'ranked' | 'auction' | 'grid' | null;
  queueCount: number;
  waitingLobbies: LobbyWithJoinedAt[];
  activeLobbies: LobbyWithJoinedAt[];
  openLobbies: LobbyWithJoinedAt[];
};

function toSnapshot(context: ResolveContext): SessionStatePayload {
  const primaryLobby = context.waitingLobbies[0] ?? context.activeLobbies[0] ?? null;
  const primaryLobbyStatus = context.waitingLobbies[0]
    ? 'waiting'
    : context.activeLobbies[0]
      ? 'active'
      : null;
  const indicatorCount =
    Number(Boolean(context.activeMatch?.id)) +
    Number(Boolean(context.queueSearchId)) +
    Number(Boolean(primaryLobby));

  let state: SessionStatePayload['state'] = 'IDLE';
  if (
    indicatorCount > 1
    || context.queueCount > 1
    || context.waitingLobbies.length + context.activeLobbies.length > 1
  ) {
    state = 'CORRUPT_MULTI_STATE';
  } else if (context.activeMatch?.id) {
    state = 'IN_ACTIVE_MATCH';
  } else if (context.queueSearchId) {
    state = 'IN_QUEUE';
  } else if (primaryLobby) {
    state = 'IN_WAITING_LOBBY';
  }

  return {
    state,
    activeMatchId: context.activeMatch?.id ?? null,
    waitingLobbyId: primaryLobby?.id ?? null,
    primaryLobbyStatus,
    queueSearchId: context.queueSearchId,
    openLobbyIds: context.openLobbies.map((lobby) => lobby.id),
    resolvedAt: new Date().toISOString(),
  };
}

function isStaleActiveMatch(activityAt: string | null | undefined): boolean {
  const activityAtMs = Date.parse(activityAt ?? '');
  if (Number.isNaN(activityAtMs)) return false;
  return Date.now() - activityAtMs > STALE_ACTIVE_MATCH_MS;
}

function rankedMatchCleanupKeys(matchId: string, userIds: string[]): string[] {
  return [
    matchPauseKey(matchId),
    matchGraceKey(matchId),
    matchResumeCountdownKey(matchId),
    rankedAiMatchKey(matchId),
    ...userIds.flatMap((playerUserId) => [
      matchDisconnectKey(matchId, playerUserId),
      matchExitPendingKey(matchId, playerUserId),
      matchPresenceKey(matchId, playerUserId),
      matchReconnectCountKey(matchId, playerUserId),
      matchReconnectFenceKey(matchId, playerUserId),
    ]),
  ];
}

async function cleanupRankedMatchRedisKeys(matchId: string, userIds: string[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.del(rankedMatchCleanupKeys(matchId, userIds));
}

function getStatePayloadString(
  payload: Record<string, unknown> | null,
  key: string
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' ? value : null;
}

function getStatePayloadRecord(
  payload: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const value = payload?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasLiveHalftimeDeadline(payload: Record<string, unknown> | null): boolean {
  if (getStatePayloadString(payload, 'phase') !== 'HALFTIME') return false;
  const halftime = getStatePayloadRecord(payload, 'halftime');
  const deadlineAt = typeof halftime?.deadlineAt === 'string' ? halftime.deadlineAt : null;
  const deadlineMs = Date.parse(deadlineAt ?? '');
  return Number.isFinite(deadlineMs) && deadlineMs > Date.now();
}

async function resolveContext(userId: string): Promise<ResolveContext> {
  return withSpan('session.resolve_context', {
    'quizball.user_id': userId,
  }, async (span) => {
    const redis = getRedisClient();
    const queueSearchIdsPromise = redis
      ? Promise.all([
          redis.hGet(RANKED_USER_MAP_KEY, userId),
          redis.hGet(AUCTION_USER_MAP_KEY, userId),
          redis.hGet(GRID_USER_MAP_KEY, userId),
        ])
      : Promise.resolve<[string | null, string | null, string | null]>([null, null, null]);

    const [rawActiveMatch, openLobbies, queueSearchIds] = await Promise.all([
      matchesRepo.getActiveMatchForUser(userId),
      lobbiesRepo.listOpenLobbiesForUser(userId),
      queueSearchIdsPromise,
    ]);
    const [rankedSearchId, auctionSearchId, gridSearchId] = queueSearchIds;
    const queueEntries = [
      rankedSearchId ? { kind: 'ranked' as const, id: rankedSearchId } : null,
      auctionSearchId ? { kind: 'auction' as const, id: auctionSearchId } : null,
      gridSearchId ? { kind: 'grid' as const, id: gridSearchId } : null,
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const queueEntry = queueEntries[0] ?? null;
    const activeMatch = rawActiveMatch && isUserDroppedFromPartyMatch(rawActiveMatch, userId)
      ? null
      : rawActiveMatch;

    span.setAttribute('quizball.has_active_match', Boolean(activeMatch?.id));
    span.setAttribute('quizball.open_lobby_count', openLobbies.length);
    span.setAttribute('quizball.queue_count', queueEntries.length);
    span.setAttribute('quizball.queue_kind', queueEntry?.kind ?? 'none');

    return {
      activeMatch,
      queueSearchId: queueEntry?.id ?? null,
      queueKind: queueEntry?.kind ?? null,
      queueCount: queueEntries.length,
      waitingLobbies: openLobbies.filter((lobby) => lobby.status === 'waiting'),
      activeLobbies: openLobbies.filter((lobby) => lobby.status === 'active'),
      openLobbies,
    };
  });
}

async function resolveContexts(userIds: string[]): Promise<Map<string, ResolveContext>> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return new Map();

  return withSpan('session.resolve_contexts', {
    'quizball.user_count': uniqueUserIds.length,
  }, async () => {
    const redis = getRedisClient();
    const queueSearchIdsPromise = redis
      ? Promise.all(uniqueUserIds.map(async (userId) => Promise.all([
          redis.hGet(RANKED_USER_MAP_KEY, userId),
          redis.hGet(AUCTION_USER_MAP_KEY, userId),
          redis.hGet(GRID_USER_MAP_KEY, userId),
        ])))
      : Promise.resolve(uniqueUserIds.map(() => [null, null, null] as [string | null, string | null, string | null]));
    const [activeMatchesByUserId, openLobbiesByUserId, queueSearchIds] = await Promise.all([
      matchesRepo.getActiveMatchesForUsers(uniqueUserIds),
      lobbiesRepo.listOpenLobbiesForUsers(uniqueUserIds),
      queueSearchIdsPromise,
    ]);

    return new Map(uniqueUserIds.map((userId, index) => {
      const rawActiveMatch = activeMatchesByUserId.get(userId) ?? null;
      const activeMatch = rawActiveMatch && isUserDroppedFromPartyMatch(rawActiveMatch, userId)
        ? null
        : rawActiveMatch;
      const openLobbies = openLobbiesByUserId.get(userId) ?? [];
      const [rankedSearchId, auctionSearchId, gridSearchId] = queueSearchIds[index];
      const queueEntries = [
        rankedSearchId ? { kind: 'ranked' as const, id: rankedSearchId } : null,
        auctionSearchId ? { kind: 'auction' as const, id: auctionSearchId } : null,
        gridSearchId ? { kind: 'grid' as const, id: gridSearchId } : null,
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      const context: ResolveContext = {
        activeMatch,
        queueSearchId: queueEntries[0]?.id ?? null,
        queueKind: queueEntries[0]?.kind ?? null,
        queueCount: queueEntries.length,
        waitingLobbies: openLobbies.filter((lobby) => lobby.status === 'waiting'),
        activeLobbies: openLobbies.filter((lobby) => lobby.status === 'active'),
        openLobbies,
      };
      return [userId, context];
    }));
  });
}

async function hasAnyPairingInFlight(userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const count = await redis.exists([
    rankedPairingInFlightKey(userId),
    `${SHARED_PAIRING_USER_KEY_PREFIX}${userId}`,
  ]);
  return count > 0;
}

async function hasLiveLobbyAuctionState(lobbyId: string): Promise<boolean> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  const humanUserIds = members
    .filter((member) => !member.is_ai)
    .map((member) => member.user_id);
  const matchIds = await Promise.all(
    humanUserIds.map((memberUserId) => auctionStateStore.getActiveMatchIdForUser(memberUserId))
  );
  for (const matchId of new Set(matchIds.filter((value): value is string => Boolean(value)))) {
    const state = await auctionStateStore.load(matchId);
    if (
      state
      && state.origin === 'lobby'
      && state.phase !== 'finished'
      // Legacy in-flight states (pre-sourceLobbyId deploy) can't be matched to
      // a lobby, so any live member auction keeps the lobby conservatively live.
      && (!state.sourceLobbyId || state.sourceLobbyId === lobbyId)
      && state.seats.some((seat) => (
        !seat.isBot
        && !seat.forfeited
        && Boolean(seat.userId)
        && humanUserIds.includes(seat.userId as string)
      ))
    ) {
      return true;
    }
  }
  return false;
}

async function hasLiveDraftPhaseState(lobbyId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const [phaseKeyCount, ...pending] = await Promise.all([
    redis.exists([
      `draft:starting:${lobbyId}`,
      `draft:pause:${lobbyId}`,
      `draft:grace:${lobbyId}`,
      `draft:complete:lock:${lobbyId}`,
    ]),
    hasPendingRealtimeTimer('draft_ai_ban', lobbyId),
    hasPendingRealtimeTimer('draft_auto_ban', lobbyId),
    hasPendingRealtimeTimer('draft_grace_expiry', lobbyId),
  ]);
  return phaseKeyCount > 0 || pending.some(Boolean);
}

/**
 * Ranked-sim drafts keep sockets attached to the lobby through normal pick/ban turns, while
 * lobby auctions clear `socket.data.lobbyId` at match start and rely on auction phase state.
 * Football Grid lobbies are live while their series is open (active, or rematch window not
 * yet expired) — series close resets the lobby to waiting, so a long-idle active grid lobby
 * means the close path was lost. Cleanup requires those signals to be absent and more than
 * 30 minutes of DB inactivity.
 */
async function isActiveLobbyLive(
  io: QuizballServer,
  lobby: LobbyWithJoinedAt,
): Promise<boolean> {
  if (lobby.mode === 'ranked') return true;

  try {
    const sockets = await io.in(`lobby:${lobby.id}`).fetchSockets();
    if (sockets.some((socket) => socket.data.lobbyId === lobby.id)) return true;
  } catch (error) {
    logger.warn({ error, lobbyId: lobby.id }, 'Failed to inspect active lobby socket presence');
    return true;
  }

  if (lobby.game_mode === 'auction' || lobby.game_mode === 'ranked_sim') {
    const redis = getRedisClient();
    if (!redis?.isOpen) return true;
    try {
      const hasPhaseState = lobby.game_mode === 'auction'
        ? await hasLiveLobbyAuctionState(lobby.id)
        : await hasLiveDraftPhaseState(lobby.id);
      if (hasPhaseState) return true;
    } catch (error) {
      logger.warn({ error, lobbyId: lobby.id, gameMode: lobby.game_mode }, 'Failed to inspect active lobby phase state');
      return true;
    }
  }

  const updatedAtMs = Date.parse(lobby.updated_at);
  return !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs <= STALE_ACTIVE_LOBBY_MS;
}

/**
 * A waiting lobby is abandoned FROM THE REQUESTER'S POINT OF VIEW when nobody
 * else has a socket in it and nothing has touched it for the stale window.
 * The requester's own sockets only count as life when they connected BEFORE
 * the lobby went quiet (a tab that has been sitting in the lobby all along).
 * A socket that connected after the last activity was put into the room by
 * connect hydration, which re-attaches a returning player to whatever lobby
 * row they left behind — that is exactly how stranded lobbies blocked ranked
 * for days, and it also covers a client re-emitting a stale "explicit"
 * intent after a reload. Anything uncertain (ranked pairing lobbies, grid
 * series, inspection errors) counts as live.
 */
async function isWaitingLobbyAbandonedBy(
  io: QuizballServer,
  userId: string,
  lobby: Pick<LobbyWithJoinedAt, 'id' | 'mode' | 'game_mode' | 'updated_at'>,
): Promise<boolean> {
  if (lobby.mode === 'ranked') return false;
  const updatedAtMs = Date.parse(lobby.updated_at);
  if (!Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs <= STALE_ACTIVE_LOBBY_MS) return false;
  try {
    const sockets = await io.in(`lobby:${lobby.id}`).fetchSockets();
    const live = sockets.some((socket) => {
      if (socket.data.lobbyId !== lobby.id) return false;
      if (socket.data.user.id !== userId) return true;
      const connectedAt = socket.data.connectedAt;
      return typeof connectedAt === 'number' && connectedAt <= updatedAtMs;
    });
    if (live) return false;
  } catch (error) {
    logger.warn({ error, lobbyId: lobby.id }, 'Failed to inspect waiting lobby socket presence');
    return false;
  }
  return true;
}

/**
 * Remove the requester from waiting lobbies they abandoned, checking each one
 * under its lobby lock so a join or start racing this heal wins. Returns true
 * only when every lobby is gone afterwards; on any doubt the caller preserves.
 */
async function healAbandonedWaitingLobbies(
  io: QuizballServer,
  userId: string,
  lobbies: LobbyWithJoinedAt[],
): Promise<boolean> {
  let healedAll = true;
  for (const lobby of lobbies) {
    const lockKey = `lock:lobby:${lobby.id}`;
    const lock = await acquireLock(lockKey, LOBBY_LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) {
      logger.info({ userId, lobbyId: lobby.id }, 'Abandoned waiting lobby heal skipped: lobby lock busy');
      healedAll = false;
      continue;
    }
    // The critical section fans out to socket inspection and several writes;
    // keep the lock alive so a join/start cannot slip in halfway through.
    const heartbeat = startLockHeartbeat(lockKey, lock.token, LOBBY_LOCK_TTL_MS);
    try {
      const fresh = await lobbiesRepo.getById(lobby.id);
      // Deleted between the context read and the lock: nothing left to block on.
      if (!fresh) continue;
      if (fresh.status !== 'waiting' || !(await isWaitingLobbyAbandonedBy(io, userId, fresh))) {
        healedAll = false;
        continue;
      }
      // Only the requester leaves: another member with no socket right now may
      // be inside their own 15s reconnect grace, and only their own explicit
      // click carries the intent to give the lobby up. Removing the host
      // transfers hosting and stamps updated_at, which would make the dead
      // lobby look fresh to that member's later heal — put the idle time back.
      await removeUserFromLobby(io, { ...fresh, joined_at: lobby.joined_at }, userId, 'heal_abandoned_waiting_lobby');
      await lobbiesRepo.restoreWaitingIdleSince(fresh.id, fresh.updated_at);
      trackStaleLobbyHealed({
        userId,
        lobbyId: fresh.id,
        mode: fresh.mode,
        gameMode: fresh.game_mode,
        idleMs: Date.now() - Date.parse(fresh.updated_at),
      });
    } finally {
      heartbeat.stop();
      await releaseLock(lockKey, lock.token).catch(() => undefined);
    }
  }
  return healedAll;
}

async function everyActiveLobbyIsDead(
  io: QuizballServer,
  lobbies: LobbyWithJoinedAt[],
): Promise<boolean> {
  if (lobbies.length === 0) return false;
  const liveStates = await Promise.all(lobbies.map((lobby) => isActiveLobbyLive(io, lobby)));
  return liveStates.every((live) => !live);
}

async function firstLiveActiveLobby(
  io: QuizballServer,
  lobbies: LobbyWithJoinedAt[],
): Promise<LobbyWithJoinedAt | null> {
  for (const lobby of lobbies) {
    if (await isActiveLobbyLive(io, lobby)) return lobby;
  }
  return null;
}

async function cleanupStaleOrphanActiveMatch(
  io: QuizballServer,
  userId: string,
  context: ResolveContext
): Promise<void> {
  const activeMatch = context.activeMatch;
  if (!activeMatch) return;

  const activityAt = activeMatch.updated_at ?? activeMatch.started_at;
  const activityAtMs = Date.parse(activityAt);
  const ageMs = Number.isNaN(activityAtMs) ? 0 : Date.now() - activityAtMs;
  const staleByAge = isStaleActiveMatch(activityAt);

  let matchSocketCount: number | null = null;
  let staleByNoSockets = false;
  if (ageMs >= STALE_ACTIVE_MATCH_WITHOUT_SOCKETS_MS) {
    const sockets = await io.in(`match:${activeMatch.id}`).fetchSockets();
    matchSocketCount = sockets.length;
    staleByNoSockets = matchSocketCount === 0;
  }

  if (hasLiveHalftimeDeadline(activeMatch.state_payload)) {
    logger.info(
      {
        userId,
        matchId: activeMatch.id,
        lobbyId: activeMatch.lobby_id,
        startedAt: activeMatch.started_at,
        updatedAt: activeMatch.updated_at,
        phase: getStatePayloadString(activeMatch.state_payload, 'phase'),
        staleByAge,
        staleByNoSockets,
      },
      'Session guard skipped stale orphan cleanup during live halftime interlude'
    );
    return;
  }

  if (!staleByAge && !staleByNoSockets) return;

  // `prepareForConnect` runs after the new socket has joined user:<id>, but
  // before it has rejoined match:<id>. During a normal page reload the match
  // room can be temporarily empty, so treating "no match sockets" as orphaned
  // here can incorrectly forfeit the reconnecting player's active match.
  // The bypass is scoped to the staleByNoSockets case only — a truly
  // age-stale match should still be cleaned up regardless of reconnects.
  if (staleByNoSockets && !staleByAge) {
    try {
      const userSockets = await io.in(`user:${userId}`).fetchSockets();
      if (userSockets.length > 0) {
        logger.info(
          {
            userId,
            matchId: activeMatch.id,
            lobbyId: activeMatch.lobby_id,
            startedAt: activeMatch.started_at,
            staleByNoSockets,
            userSocketCount: userSockets.length,
          },
          'Session guard skipped staleByNoSockets cleanup because user is reconnecting'
        );
        return;
      }
    } catch (error) {
      logger.warn({ error, userId, matchId: activeMatch.id }, 'Failed to inspect user sockets for stale match cleanup');
    }
  }

  if (activeMatch.game_variant === 'football_grid') {
    // Football Grid does not ship in this release; the variant cannot occur.
    return;
  }

  if (activeMatch.mode === 'ranked') {
    if (!staleByAge) {
      logger.info(
        { userId, matchId: activeMatch.id, staleByAge, staleByNoSockets, matchSocketCount },
        'Session guard skipped ranked orphan cleanup before updated_at stale threshold'
      );
      return;
    }

    let userSocketCount: number | null = null;
    try {
      userSocketCount = (await io.in(`user:${userId}`).fetchSockets()).length;
    } catch (error) {
      logger.warn({ error, userId, matchId: activeMatch.id }, 'Failed to inspect user sockets for ranked stale match audit');
    }

    logger.warn(
      {
        userId,
        matchId: activeMatch.id,
        lobbyId: activeMatch.lobby_id,
        startedAt: activeMatch.started_at,
        updatedAt: activeMatch.updated_at,
        phase: getStatePayloadString(activeMatch.state_payload, 'phase'),
        staleReason: staleByAge && staleByNoSockets
          ? 'age_and_no_sockets'
          : staleByAge
            ? 'age'
            : 'no_sockets',
        staleByAge,
        staleByNoSockets,
        matchSocketCount,
        userSocketCount,
      },
      'Session guard stale orphan ranked match cleanup audit'
    );

    // FORFEIT-FIRST (shared resolver, consistent with the live disconnect
    // path #72 and the stale sweeper): the absent player loses by forfeit
    // when a present counterpart exists; progress completion is only the
    // fallback when presence cannot isolate a single absent loser.
    const players = await matchPlayersRepo.listMatchPlayers(activeMatch.id);
    const resolution = await resolveOrphanPossessionMatchTerminal({
      io,
      match: activeMatch,
      roster: players,
      source: 'session_guard_orphan',
      connectingUserId: userId,
    });
    if (resolution.outcome === 'abandoned') {
      for (const player of players) {
        trackMatchAbandoned(player.user_id, activeMatch.id, activeMatch.mode, 'session_guard_stale_ranked_orphan');
      }
    }
    return;
  }

  const abandoned = await matchesRepo.abandonMatch(activeMatch.id);
  if (!abandoned) return;

  // Analytics: per-participant match_abandoned event.
  try {
    const roster = await matchPlayersRepo.listMatchPlayers(activeMatch.id);
    for (const player of roster) {
      trackMatchAbandoned(player.user_id, activeMatch.id, activeMatch.mode, 'session_guard_stale_orphan');
    }
  } catch (err) {
    logger.warn({ err, matchId: activeMatch.id }, 'match_abandoned analytics failed');
  }

  logger.warn(
    {
      userId,
      matchId: activeMatch.id,
      lobbyId: activeMatch.lobby_id,
      startedAt: activeMatch.started_at,
      staleByAge,
      staleByNoSockets,
    },
    'Session guard abandoned stale orphan active match'
  );
}

async function emitLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;
  const state = await lobbiesService.buildLobbyState(lobby);
  io.to(`lobby:${lobbyId}`).emit('lobby:state', state);
}

async function removeUserFromLobby(
  io: QuizballServer,
  lobby: LobbyWithJoinedAt,
  userId: string,
  reason: string
): Promise<void> {
  // A ranked-AI lobby is a 2-member (human + bot) pre-match lobby: the human
  // leaving ENDS it. Tear it down + free any persistent-bot reservation
  // atomically under the shared per-lobby advisory lock (serialized with draft
  // activation). The locked abort removes ALL members + deletes the lobby +
  // releases the reservation, only while still 'waiting'/gone. If a reconnect
  // concurrently advanced the draft, it no-ops and we leave the live draft alone.
  if (lobby.mode === 'ranked') {
    const result = await reservationService.abortLobby(lobby.id, 'remove_user_from_lobby');
    const redis = getRedisClient();
    if (redis) await redis.del(rankedAiLobbyKey(lobby.id)).catch(() => undefined);
    if (result.aborted) {
      // Detach the removed members' sockets, then emit the closed state.
      for (const removedId of result.removedMemberIds) {
        await removeUserFromLobbySockets(io, lobby.id, removedId);
      }
      await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);
      logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard aborted ranked pre-match lobby');
      return;
    }
    // Lobby advanced (live draft) — leave it; just detach this user's socket.
    await removeUserFromLobbySockets(io, lobby.id, userId);
    await emitLobbyState(io, lobby.id);
    logger.info({ lobbyId: lobby.id, userId, reason, status: 'advanced' }, 'Session guard: ranked lobby advanced, left live');
    return;
  }

  // Non-ranked (friendly) lobby: the legacy per-member removal + host transfer.
  await lobbiesRepo.removeMember(lobby.id, userId);
  await removeUserFromLobbySockets(io, lobby.id, userId);

  const memberCount = await lobbiesRepo.countMembers(lobby.id);
  if (memberCount === 0) {
    await lobbiesRepo.deleteLobby(lobby.id);
    await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);
    logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed and deleted empty lobby');
    return;
  }

  if (lobby.status === 'waiting' && lobby.host_user_id === userId) {
    await transferHostIfNeeded(lobby.id, userId);
  }

  await emitLobbyState(io, lobby.id);
  logger.info({ lobbyId: lobby.id, userId, reason }, 'Session guard removed user from lobby');
}

async function closeRankedPreMatchLobby(
  io: QuizballServer,
  lobby: LobbyWithJoinedAt,
  userId: string,
  reason: string
): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobby.id);
  // Force-close of a STUCK active pre-match lobby (activated but no entered match
  // — the caller already confirmed no live match and abandoned any match row).
  // This is a genuine draft-teardown, so draftTeardown clears the reservation's
  // commit flag under the lock and reclaims the bot.
  await reservationService.abortLobby(lobby.id, 'close_pre_match_lobby', { draftTeardown: true });
  const redis = getRedisClient();
  if (redis?.isOpen) {
    await redis.del(rankedAiLobbyKey(lobby.id));
  }

  await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);

  const lobbySockets = await io.in(`lobby:${lobby.id}`).fetchSockets();
  lobbySockets.forEach((socket) => {
    socket.leave(`lobby:${lobby.id}`);
    if (socket.data.lobbyId === lobby.id) {
      socket.data.lobbyId = undefined;
    }
  });

  for (const member of members) {
    io.to(`user:${member.user_id}`).emit('ranked:queue_left');
    const snapshot = toSnapshot(await resolveContext(member.user_id));
    io.to(`user:${member.user_id}`).emit('session:state', snapshot);
  }
  logger.info(
    { lobbyId: lobby.id, userId, reason, memberUserIds: members.map((member) => member.user_id) },
    'Session guard closed ranked pre-match lobby'
  );
}

async function hasAnyHumanEnteredMatch(lobbyId: string, matchId: string): Promise<boolean> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  const humanUserIds = members
    .filter((member) => !member.is_ai)
    .map((member) => member.user_id);
  if (humanUserIds.length === 0) return false;

  const evidence = await Promise.all(
    humanUserIds.map((memberUserId) => resolveMatchReplayEvidence(matchId, memberUserId))
  );
  return evidence.some((entry) => entry.allowed);
}

async function cancelRankedQueueSearch(userId: string): Promise<void> {
  await withSpan('ranked.queue_cancel', {
    'quizball.user_id': userId,
  }, async (span) => {
    const redis = getRedisClient();
    if (!redis) {
      span.setAttribute('quizball.redis_available', false);
      return;
    }

    span.setAttribute('quizball.redis_available', true);
    await redis.eval(RANKED_MM_CANCEL_SEARCH_SCRIPT, {
      keys: [RANKED_QUEUE_KEY, RANKED_TIMEOUTS_KEY, RANKED_USER_MAP_KEY],
      arguments: [RANKED_SEARCH_KEY_PREFIX, userId, String(Date.now())],
    });
  });
}

async function cancelSimpleQueueSearch(
  userId: string,
  kind: 'auction' | 'grid',
): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const queueKey = kind === 'auction' ? AUCTION_QUEUE_KEY : GRID_QUEUE_KEY;
  const userMapKey = kind === 'auction' ? AUCTION_USER_MAP_KEY : GRID_USER_MAP_KEY;
  const searchPrefix = kind === 'auction' ? AUCTION_SEARCH_KEY_PREFIX : GRID_SEARCH_KEY_PREFIX;
  const searchId = await redis.hGet(userMapKey, userId);
  if (!searchId) return;
  await redis.eval(SIMPLE_MM_CANCEL_SEARCH_SCRIPT, {
    keys: [queueKey, userMapKey, `${searchPrefix}${searchId}`],
    arguments: [userId, searchId],
  });
}

async function cancelAllQueueSearches(userId: string): Promise<void> {
  await Promise.all([
    cancelRankedQueueSearch(userId),
    cancelSimpleQueueSearch(userId, 'auction'),
    cancelSimpleQueueSearch(userId, 'grid'),
  ]);
}

async function cleanupOpenLobbies(
  io: QuizballServer,
  userId: string,
  options: {
    keepLobbyId?: string;
    keepWaitingLobbyId?: string;
    preserveActiveMatchId?: string | null;
    cleanupStartedAtMs?: number;
  } = {}
): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  for (const lobby of openLobbies) {
    const joinedAtMs = Date.parse(lobby.joined_at);
    if (
      typeof options.cleanupStartedAtMs === 'number' &&
      Number.isFinite(joinedAtMs) &&
      joinedAtMs > options.cleanupStartedAtMs
    ) {
      logger.info(
        {
          userId,
          lobbyId: lobby.id,
          joinedAt: lobby.joined_at,
          cleanupStartedAt: new Date(options.cleanupStartedAtMs).toISOString(),
        },
        'Session guard skipped lobby cleanup for membership joined after cleanup started'
      );
      continue;
    }

    if (options.keepLobbyId && lobby.id === options.keepLobbyId) {
      continue;
    }

    if (lobby.status === 'waiting') {
      if (options.keepWaitingLobbyId && lobby.id === options.keepWaitingLobbyId) {
        continue;
      }
      await removeUserFromLobby(io, lobby, userId, 'cleanup_waiting');
      continue;
    }

    const activeMatchForLobby = await matchesRepo.getActiveMatchForLobby(lobby.id);
    if (!activeMatchForLobby) {
      if (await isActiveLobbyLive(io, lobby)) {
        continue;
      }
      await removeUserFromLobby(io, lobby, userId, 'cleanup_stale_active_lobby');
      trackStaleLobbyHealed({
        userId,
        lobbyId: lobby.id,
        mode: lobby.mode,
        gameMode: lobby.game_mode,
        idleMs: Date.now() - Date.parse(lobby.updated_at),
      });
      continue;
    }

    if (options.preserveActiveMatchId && activeMatchForLobby.id === options.preserveActiveMatchId) {
      continue;
    }

    if (isStaleActiveMatch(activeMatchForLobby.updated_at ?? activeMatchForLobby.started_at)) {
      logger.warn(
        {
          userId,
          lobbyId: lobby.id,
          matchId: activeMatchForLobby.id,
          startedAt: activeMatchForLobby.started_at,
        },
        'Session guard found stale active match for lobby'
      );
      continue;
    }

    await removeUserFromLobby(io, lobby, userId, 'cleanup_unrelated_active_lobby');
  }
}

async function cleanupRankedWaitingLobbies(io: QuizballServer, userId: string): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  for (const lobby of openLobbies) {
    if (lobby.mode !== 'ranked') continue;
    if (lobby.status === 'waiting') {
      await removeUserFromLobby(io, lobby, userId, 'ranked_queue_leave');
      continue;
    }

    if (lobby.status !== 'active') continue;
    const activeMatchForLobby = await matchesRepo.getActiveMatchForLobby(lobby.id);
    if (!activeMatchForLobby) {
      await closeRankedPreMatchLobby(io, lobby, userId, 'ranked_queue_leave_active_lobby_no_match');
      continue;
    }

    if (await hasAnyHumanEnteredMatch(lobby.id, activeMatchForLobby.id)) {
      logger.info(
        { userId, lobbyId: lobby.id, matchId: activeMatchForLobby.id },
        'Session guard skipped active ranked lobby cleanup because match has entered evidence'
      );
      continue;
    }

    const players = await matchPlayersRepo.listMatchPlayers(activeMatchForLobby.id);
    const abandoned = await abandonMatchWithCompleteLock(activeMatchForLobby.id);
    if (!abandoned.abandoned) {
      logger.warn(
        { userId, lobbyId: lobby.id, matchId: activeMatchForLobby.id, reason: abandoned.reason },
        'Session guard could not abandon pre-match ranked match during queue leave'
      );
      continue;
    }
    await cleanupRankedMatchRedisKeys(
      activeMatchForLobby.id,
      players.map((player) => player.user_id)
    );
    await closeRankedPreMatchLobby(io, lobby, userId, 'ranked_queue_leave_active_lobby_no_entered_match');
  }
}

export const userSessionGuardService = {
  async withUserSessionLocks<T>(
    userIds: string[],
    work: () => Promise<T>,
    options?: { waitMs?: number },
  ): Promise<T | null> {
    const orderedUserIds = [...new Set(userIds)].sort();
    const deadlineMs = Date.now() + Math.max(0, options?.waitMs ?? 0);
    const held: Array<{
      key: string;
      token: string;
      heartbeat: ReturnType<typeof startLockHeartbeat>;
    }> = [];
    try {
      for (const userId of orderedUserIds) {
        const key = `lock:user:session:${userId}`;
        while (true) {
          const lock = await acquireLock(key, SESSION_LOCK_TTL_MS);
          if (lock.acquired && lock.token) {
            held.push({
              key,
              token: lock.token,
              heartbeat: startLockHeartbeat(key, lock.token, SESSION_LOCK_TTL_MS),
            });
            break;
          }
          if (Date.now() >= deadlineMs) return null;
          await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(SESSION_LOCK_RETRY_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())),
          ));
        }
      }
      return await work();
    } finally {
      for (const lock of held.reverse()) {
        lock.heartbeat.stop();
        await releaseLock(lock.key, lock.token).catch(() => false);
      }
    }
  },

  async withUserSessionLock<T>(
    userId: string,
    work: () => Promise<T>,
    options?: { waitMs?: number }
  ): Promise<T | null> {
    return withSpan('session.user_lock', {
      'quizball.user_id': userId,
    }, async (span) => {
      const lockKey = `lock:user:session:${userId}`;
      const waitMs = Math.max(0, options?.waitMs ?? 0);
      const deadlineMs = Date.now() + waitMs;
      span.setAttribute('quizball.wait_ms', waitMs);

      while (true) {
        const lock = await acquireLock(lockKey, SESSION_LOCK_TTL_MS);
        if (lock.acquired && lock.token) {
          span.setAttribute('quizball.lock_acquired', true);
          const heartbeat = startLockHeartbeat(lockKey, lock.token, SESSION_LOCK_TTL_MS);
          try {
            return await work();
          } finally {
            heartbeat.stop();
            await releaseLock(lockKey, lock.token);
          }
        }

        if (Date.now() >= deadlineMs) {
          span.setAttribute('quizball.lock_acquired', false);
          return null;
        }

        const remainingMs = deadlineMs - Date.now();
        const sleepMs = Math.min(SESSION_LOCK_RETRY_INTERVAL_MS, remainingMs);
        if (sleepMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
        }
      }
    });
  },

  async withUserAndLobbyLock<T>(
    userId: string,
    lobbyId: string,
    work: () => Promise<T>
  ): Promise<T | null> {
    const userLockKey = `lock:user:session:${userId}`;
    const lobbyLockKey = `lock:lobby:${lobbyId}`;

    const userLock = await acquireLock(userLockKey, SESSION_LOCK_TTL_MS);
    if (!userLock.acquired || !userLock.token) {
      return null;
    }

    const lobbyLock = await acquireLock(lobbyLockKey, LOBBY_LOCK_TTL_MS);
    if (!lobbyLock.acquired || !lobbyLock.token) {
      await releaseLock(userLockKey, userLock.token);
      return null;
    }

    const userHeartbeat = startLockHeartbeat(userLockKey, userLock.token, SESSION_LOCK_TTL_MS);
    const lobbyHeartbeat = startLockHeartbeat(lobbyLockKey, lobbyLock.token, LOBBY_LOCK_TTL_MS);
    try {
      return await work();
    } finally {
      lobbyHeartbeat.stop();
      userHeartbeat.stop();
      await releaseLock(lobbyLockKey, lobbyLock.token);
      await releaseLock(userLockKey, userLock.token);
    }
  },

  async resolveState(userId: string): Promise<SessionStatePayload> {
    const context = await resolveContext(userId);
    return toSnapshot(context);
  },

  async resolveStates(userIds: string[]): Promise<Map<string, SessionStatePayload>> {
    const contexts = await resolveContexts(userIds);
    return new Map([...contexts].map(([userId, context]) => [userId, toSnapshot(context)]));
  },

  async claimRematchActivityFence(input: {
    userId: string;
    fenceToken: string;
    allowedLobbyId: string | null;
    ttlMs?: number;
  }): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return false;
    const key = sharedPairingUserKey(input.userId);
    const claimed = await redis.set(key, input.fenceToken, {
      NX: true,
      PX: input.ttlMs ?? 30_000,
    });
    if (claimed !== 'OK') {
      return await redis.get(key) === input.fenceToken;
    }

    const context = await resolveContext(input.userId);
    const allowedLobby = (lobby: LobbyWithJoinedAt) => (
      input.allowedLobbyId !== null && lobby.id === input.allowedLobbyId
    );
    const hasConflictingActivity = Boolean(context.activeMatch)
      || Boolean(context.queueSearchId)
      || context.openLobbies.some((lobby) => !allowedLobby(lobby));
    if (!hasConflictingActivity) return true;

    await releaseSharedActivityFences([input.userId], input.fenceToken);
    return false;
  },

  async ownsActivityFences(userIds: string[], fenceToken: string): Promise<boolean> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return false;
    const values = await Promise.all(
      [...new Set(userIds)].sort().map((userId) => redis.get(sharedPairingUserKey(userId))),
    );
    return values.length === new Set(userIds).size && values.every((value) => value === fenceToken);
  },

  async renewActivityFences(userIds: string[], fenceToken: string, ttlMs = 30_000): Promise<boolean> {
    return renewSharedActivityFences(userIds, fenceToken, ttlMs);
  },

  async releaseActivityFences(userIds: string[], fenceToken: string): Promise<void> {
    await releaseSharedActivityFences(userIds, fenceToken);
  },

  async emitState(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    const snapshot = await this.resolveState(userId);
    this.emitSnapshot(io, userId, snapshot);
    return snapshot;
  },

  emitSnapshot(
    io: QuizballServer,
    userId: string,
    snapshot: SessionStatePayload,
  ): void {
    io.to(`user:${userId}`).emit('session:state', snapshot);
  },

  emitBlocked(
    socket: QuizballSocket,
    payload: Omit<SessionBlockedPayload, 'stateSnapshot'> & { stateSnapshot: SessionStatePayload }
  ): void {
    socket.emit('session:blocked', payload);
  },

  async runWithUserTransitionLock(
    _io: QuizballServer,
    socket: QuizballSocket,
    work: () => Promise<void>,
    options?: {
      code?: string;
      message?: string;
      operation?: string;
      waitMs?: number;
    }
  ): Promise<boolean> {
    const userId = socket.data.user.id;
    const locked = await this.withUserSessionLock(userId, work, {
      waitMs: options?.waitMs ?? SESSION_LOCK_WAIT_MS,
    });
    if (locked !== null) {
      return true;
    }

    const snapshot = await this.resolveState(userId);
    logger.warn(
      {
        userId,
        operation: options?.operation ?? null,
        state: snapshot.state,
        activeMatchId: snapshot.activeMatchId,
        waitingLobbyId: snapshot.waitingLobbyId,
        queueSearchId: snapshot.queueSearchId,
      },
      'User transition lock blocked operation'
    );
    this.emitBlocked(socket, {
      reason: 'TRANSITION_IN_PROGRESS',
      message: options?.message ?? 'State transition is in progress. Please retry.',
      operation: options?.operation,
      stateSnapshot: snapshot,
    });
    return false;
  },

  async prepareForConnect(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    const cleanupStartedAtMs = Date.now();
    let context = await resolveContext(userId);
    // The overwhelmingly common connect path is a clean IDLE user. Do not
    // re-read the same match/lobby state or run a second lobby-only query when
    // the first snapshot proves there is nothing to clean. Keep one final
    // resolve below so a lobby membership created concurrently after this
    // snapshot is still observed instead of being removed as stale.
    if (context.activeMatch) {
      await cleanupStaleOrphanActiveMatch(io, userId, context);
      context = await resolveContext(userId);
    }
    if (context.queueCount > 1) {
      await cancelAllQueueSearches(userId);
      context = await resolveContext(userId);
    }

    if (context.activeMatch?.id) {
      await cancelAllQueueSearches(userId);
      if (context.openLobbies.length > 0) {
        await cleanupOpenLobbies(io, userId, {
          preserveActiveMatchId: context.activeMatch.id,
          cleanupStartedAtMs,
        });
      }
      return this.resolveState(userId);
    }

    const liveActiveLobby = context.waitingLobbies.length === 0 && context.activeLobbies.length > 0
      ? await firstLiveActiveLobby(io, context.activeLobbies)
      : null;
    const keepLobbyId = context.waitingLobbies[0]?.id ?? liveActiveLobby?.id;
    if (context.queueSearchId && keepLobbyId) {
      await cancelAllQueueSearches(userId);
    }
    const hasExtraLobby = context.openLobbies.some((lobby) => lobby.id !== keepLobbyId);
    if (hasExtraLobby) {
      await cleanupOpenLobbies(io, userId, {
        keepLobbyId,
        keepWaitingLobbyId: context.waitingLobbies[0]?.id,
        preserveActiveMatchId: null,
        cleanupStartedAtMs,
      });
    }
    return this.resolveState(userId);
  },

  async prepareForLobbyEntry(
    io: QuizballServer,
    userId: string,
    options?: {
      keepWaitingLobbyId?: string;
    }
  ): Promise<{ ok: boolean; snapshot: SessionStatePayload; reason?: SessionBlockedPayload['reason']; message?: string }> {
    const cleanupStartedAtMs = Date.now();
    // Lobby create/join is another flash-traffic path. The connection hook has
    // already performed general recovery, but this command still needs its own
    // authoritative read for races and non-socket callers. As with ranked queue
    // entry, keep the clean IDLE path to one batched match+lobby read.
    let context = await resolveContext(userId);
    if (context.activeMatch) {
      await cleanupStaleOrphanActiveMatch(io, userId, context);
      context = await resolveContext(userId);
    }
    if (context.queueCount > 1) {
      await cancelAllQueueSearches(userId);
      context = await resolveContext(userId);
      if (context.queueCount > 0) {
        return {
          ok: false,
          snapshot: toSnapshot(context),
          reason: 'QUEUE_UNAVAILABLE',
          message: 'Your previous searches are still being cleaned up. Please retry.',
        };
      }
    }
    let snapshot = toSnapshot(context);

    if (await hasAnyPairingInFlight(userId)) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your match or rematch is starting',
      };
    }

    if (snapshot.activeMatchId) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active match',
      };
    }

    const keepWaitingLobbyId = options?.keepWaitingLobbyId;
    const hasLobbyToClean = context.openLobbies.some(
      (lobby) => lobby.id !== keepWaitingLobbyId
    );
    if (!context.queueSearchId && !hasLobbyToClean) {
      return { ok: true, snapshot };
    }

    if (context.queueSearchId) await cancelAllQueueSearches(userId);
    if (hasLobbyToClean) {
      await cleanupOpenLobbies(io, userId, {
        keepWaitingLobbyId,
        cleanupStartedAtMs,
      });
    }
    context = await resolveContext(userId);
    snapshot = toSnapshot(context);
    if (snapshot.activeMatchId || await hasAnyPairingInFlight(userId)) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your match is starting',
      };
    }
    if (context.activeLobbies.length > 0) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active draft',
      };
    }
    return { ok: true, snapshot };
  },

  async prepareForQueueJoin(
    io: QuizballServer,
    userId: string,
    requestedQueue: 'ranked' | 'auction' | 'grid' = 'ranked',
    options?: {
      preserveWaitingLobbies?: boolean;
      /**
       * The player pressed Play Ranked themselves (not a reload re-emit):
       * a waiting lobby they abandoned may be healed instead of blocking.
       */
      explicitJoin?: boolean;
    },
  ): Promise<{ ok: boolean; snapshot: SessionStatePayload; reason?: SessionBlockedPayload['reason']; message?: string }> {
    // Queue join is a flash-traffic path. A clean user only needs one context
    // read; the generic connect preparation used to resolve the same match and
    // lobby state repeatedly before resolving it yet again below.
    const cleanupStartedAtMs = Date.now();
    let context = await resolveContext(userId);
    if (context.activeMatch) {
      await cleanupStaleOrphanActiveMatch(io, userId, context);
      context = await resolveContext(userId);
    }

    let snapshot = toSnapshot(context);
    if (context.queueCount > 1) {
      await cancelAllQueueSearches(userId);
      context = await resolveContext(userId);
      snapshot = toSnapshot(context);
      if (context.queueCount > 0) {
        return {
          ok: false,
          snapshot,
          reason: 'QUEUE_UNAVAILABLE',
          message: 'Your previous searches are still being cleaned up. Please retry.',
        };
      }
    }
    if (await hasAnyPairingInFlight(userId)) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your match is starting',
      };
    }

    if (snapshot.activeMatchId) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'You are already in an active match',
      };
    }

    // A reload while sitting in a live lobby can make the client re-emit a
    // stale queue_join; ranked opts in to preserving the lobby membership so
    // that automatic re-emit never dissolves a real lobby (auction/grid keep
    // the leave-lobby-and-queue semantics). An EXPLICIT join is different:
    // a lobby nobody else is in that has been idle past the stale window is
    // abandoned, and preserving it blocked players from ranked for days.
    if (options?.preserveWaitingLobbies && context.waitingLobbies.length > 0) {
      const healed = options.explicitJoin
        ? await healAbandonedWaitingLobbies(io, userId, context.waitingLobbies)
        : false;
      if (!healed) {
        return {
          ok: false,
          snapshot,
          reason: 'ACTIVE_MATCH',
          message: 'You are already in a lobby',
        };
      }
      context = await resolveContext(userId);
      snapshot = toSnapshot(context);
    }

    if (context.activeLobbies.length > 0) {
      if (await everyActiveLobbyIsDead(io, context.activeLobbies)) {
        await cleanupOpenLobbies(io, userId, { cleanupStartedAtMs });
        context = await resolveContext(userId);
        snapshot = toSnapshot(context);
      }
      if (context.activeLobbies.length > 0) {
        return {
          ok: false,
          snapshot,
          reason: 'ACTIVE_MATCH',
          message: 'You are already in an active draft',
        };
      }
    }

    if (snapshot.state === 'IN_QUEUE' && context.queueKind !== requestedQueue) {
      return {
        ok: false,
        snapshot,
        reason: 'QUEUE_UNAVAILABLE',
        message: 'You are already searching in another game mode',
      };
    }

    if (snapshot.state === 'IN_QUEUE') {
      return { ok: true, snapshot };
    }

    // The common IDLE path has no artifacts to clean and can return without
    // another database round trip. Only resolve again when cleanup changed
    // actual lobby/queue state.
    if (context.openLobbies.length > 0 || context.queueSearchId) {
      if (context.queueSearchId) await cancelAllQueueSearches(userId);
      await cleanupOpenLobbies(io, userId, { cleanupStartedAtMs });
      context = await resolveContext(userId);
      snapshot = toSnapshot(context);
    }

    if (snapshot.activeMatchId || await hasAnyPairingInFlight(userId)) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your match is starting',
      };
    }
    if (context.openLobbies.length > 0) {
      return {
        ok: false,
        snapshot,
        reason: 'ACTIVE_MATCH',
        message: 'Your lobby state changed. Please retry.',
      };
    }

    return { ok: true, snapshot };
  },

  async cleanupRankedQueueArtifacts(io: QuizballServer, userId: string): Promise<SessionStatePayload> {
    await cancelRankedQueueSearch(userId);
    await cleanupRankedWaitingLobbies(io, userId);
    return this.resolveState(userId);
  },
};
