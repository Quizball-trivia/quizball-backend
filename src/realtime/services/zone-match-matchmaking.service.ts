import { randomUUID } from 'node:crypto';
import { config } from '../../core/config.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { isRoomGameEnabled } from '../../modules/room/room.config.js';
import { roomService } from '../../modules/room/room.service.js';
import { RoomError } from '../../modules/room/room.types.js';
import { createZoneBotUser, deleteZoneBotUser, startZoneMatchBot } from '../../modules/room/games/zone-match/zone-match.bot.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { ZoneMatchSearchStatePayload } from '../socket.types.js';
import { roomRealtimeService } from './room-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';

/**
 * Zone match (Ranked 2.0 beta) matchmaking: a 1v1 queue after football grid's shape. A search waits for another
 * human; at a per-search random 10–20 s (a fixed delay reads as scripted) the durable fallback timer seats the
 * server practice bot instead. Both outcomes start an ordinary zone-match room: the queue mints a synthetic lobby
 * (ranked 1.0's reservation-anchor trick), so the room runtime, the web handoff and the reconnect pointer all work
 * unchanged. No RP, no tickets: the beta queue never touches live ranked.
 */

const QUEUE_KEY = 'zone_match:mm:queue';
const USER_MAP_KEY = 'zone_match:mm:user';
const SEARCH_PREFIX = 'zone_match:mm:search:';
const LOCK_KEY = 'lock:zone_match:mm';
const LOCK_TTL_MS = 12_000;
const SEARCH_TTL_SEC = 180;
const MAX_SEARCH_AGE_MS = SEARCH_TTL_SEC * 1_000;
const MATCH_SCAN_LIMIT = 50;
const FALLBACK_TIMER_KIND = 'zone_match_matchmaking_fallback' as const;

interface QueuedZoneSearch {
  searchId: string;
  userId: string;
  isGuest: boolean;
  queuedAt: number;
  fallbackAt: number;
}

const searchKey = (searchId: string) => `${SEARCH_PREFIX}${searchId}`;
const searchExpiresAt = (search: QueuedZoneSearch) => search.queuedAt + MAX_SEARCH_AGE_MS;
const isSearchExpired = (search: QueuedZoneSearch, now = Date.now()) => now >= searchExpiresAt(search);

/** When this search gives up on humans: 10–20 s drawn per search (1 s under the test harness). */
function nextFallbackAt(search: Pick<QueuedZoneSearch, 'queuedAt'>, now = Date.now()): number {
  const span = Math.max(0, config.ZONE_MATCH_BOT_FALLBACK_MAX_MS - config.ZONE_MATCH_BOT_FALLBACK_MIN_MS);
  const delay = config.ZONE_MATCH_BOT_FALLBACK_MIN_MS + Math.floor(Math.random() * (span + 1));
  return Math.min(search.queuedAt + MAX_SEARCH_AGE_MS, now + harnessDelayMs(delay, 1_000));
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

async function readSearch(searchId: string): Promise<QueuedZoneSearch | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  const raw = await redis.get(searchKey(searchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QueuedZoneSearch;
    return parsed.searchId === searchId && typeof parsed.userId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSearch(search: QueuedZoneSearch): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) throw new Error('ZONE_QUEUE_UNAVAILABLE');
  const remainingMs = searchExpiresAt(search) - Date.now();
  if (remainingMs <= 0) throw new Error('ZONE_SEARCH_EXPIRED');
  await redis.multi()
    .set(searchKey(search.searchId), JSON.stringify(search), { EX: Math.max(1, Math.ceil(remainingMs / 1_000)) })
    .hSet(USER_MAP_KEY, search.userId, search.searchId)
    .zAdd(QUEUE_KEY, [{ score: search.queuedAt, value: search.searchId }])
    .exec();
}

async function removeSearch(search: QueuedZoneSearch): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.multi()
    .zRem(QUEUE_KEY, search.searchId)
    .hDel(USER_MAP_KEY, search.userId)
    .del(searchKey(search.searchId))
    .exec();
  await cancelRealtimeTimer(FALLBACK_TIMER_KIND, search.searchId);
}

/** Matchmaking runs only while both its flags are on and the room-game kill switch leaves Zone match on. */
const queueOpen = (): boolean => config.ZONE_MATCH_QUEUE_ENABLED && config.ZONE_MATCH_BOT_ENABLED && isRoomGameEnabled('zone_match');

function emitSearchState(io: QuizballServer, userId: string, payload: ZoneMatchSearchStatePayload): void {
  io.to(`user:${userId}`).emit('zone:search_state', payload);
}

async function expireSearch(io: QuizballServer, search: QueuedZoneSearch): Promise<void> {
  await removeSearch(search);
  emitSearchState(io, search.userId, { state: 'idle', searchId: search.searchId });
  await userSessionGuardService.emitState(io, search.userId).catch(() => {});
}

async function listSearches(io: QuizballServer): Promise<QueuedZoneSearch[]> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return [];
  const ids = await redis.zRange(QUEUE_KEY, 0, MATCH_SCAN_LIMIT - 1);
  const searches = await Promise.all(ids.map(readSearch));
  const valid = searches.filter((entry): entry is QueuedZoneSearch => entry !== null);
  const staleIds = ids.filter((id) => !valid.some((entry) => entry.searchId === id));
  if (staleIds.length > 0) await redis.zRem(QUEUE_KEY, staleIds);
  const live: QueuedZoneSearch[] = [];
  for (const search of valid) {
    if (isSearchExpired(search)) await expireSearch(io, search);
    else live.push(search);
  }
  return live.sort((a, b) => a.queuedAt - b.queuedAt);
}

async function scheduleFallback(search: QueuedZoneSearch): Promise<void> {
  await scheduleRealtimeTimer(
    FALLBACK_TIMER_KIND,
    search.searchId,
    new Date(search.fallbackAt),
    { kind: FALLBACK_TIMER_KIND, searchId: search.searchId, userId: search.userId },
  );
}

/**
 * The queue's match start: both participants reserved under their session locks, the searches re-read (a cancel, a
 * disconnect or another flow may have removed one since the sweep listed it), then a synthetic lobby (every player a
 * ready member) + the ordinary room-from-lobby path.
 */
async function startQueueMatch(io: QuizballServer, searches: QueuedZoneSearch[], withBot: boolean): Promise<boolean> {
  const started = await userSessionGuardService.withUserSessionLocks(searches.map((s) => s.userId), async () => {
    for (const search of searches) {
      const fresh = await readSearch(search.searchId);
      if (!fresh || fresh.userId !== search.userId) return false;
    }
    const [first, second] = searches;
    let lobbyId: string | null = null;
    let effects: Awaited<ReturnType<typeof roomService.createFromLobby>> | null = null;
    let botUserId: string | null = null;
    try {
      // Mode 'ranked': the one lobby shape with no invite code (lobbies_invite_code_mode_check) — nobody can join a
      // queue lobby by code. Ranked 1.0's bot-anchor lobby is the same trick; legacy draft recovery skips
      // room_game ranked lobbies, and roomRepo.finish closes them instead of reopening.
      const lobby = withBot
        ? await lobbiesRepo.createLobby({ mode: 'ranked', gameMode: 'room_game', roomGame: 'zone_match', hostUserId: first.userId, inviteCode: null })
        : await lobbiesRepo.createLobbyWithMembers(
            { mode: 'ranked', gameMode: 'room_game', roomGame: 'zone_match', hostUserId: first.userId, inviteCode: null },
            [{ userId: first.userId, isReady: true }, { userId: second.userId, isReady: true }],
          );
      lobbyId = lobby.id;
      if (withBot) await lobbiesRepo.addMember(lobby.id, first.userId, true);
      botUserId = withBot ? await createZoneBotUser() : null;
      const players = [
        ...searches.map((s) => ({ userId: s.userId, isGuest: s.isGuest })),
        ...(botUserId ? [{ userId: botUserId, isGuest: false, isBot: true }] : []),
      ];
      effects = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'zone_match', options: null, players });
    } catch (error) {
      // room_pool_short, a user who slipped into another session, a lost race: the searches stay queued; their
      // fallback timers try again (and the next join sweeps too). The half-built lobby must not linger as 'waiting' —
      // but only while no match exists: createFromLobby can reject AFTER its commit (its post-commit clock read), so
      // the lobby row goes only when no live match claims it.
      if (lobbyId) {
        try {
          const [live] = await sql<Array<{ id: string }>>`
            SELECT id FROM room_matches WHERE lobby_id = ${lobbyId} AND status IN ('ready', 'active') LIMIT 1
          `;
          if (!live) {
            await lobbiesRepo.deleteLobby(lobbyId).catch(() => {});
            if (botUserId) await deleteZoneBotUser(botUserId).catch(() => {});
          }
        } catch {
          // Can't verify → don't delete: a live match's lobby must never go; an orphan lobby is the lesser harm.
        }
      }
      logger.warn({ error: error instanceof RoomError ? error.message : error, users: searches.map((s) => s.userId) }, 'Zone queue match start failed');
      return false;
    }
    // The match exists from here on: cleanup/delivery hiccups are logged, never unwound (resync repairs delivery).
    try {
      for (const search of searches) await removeSearch(search);
      if (botUserId) startZoneMatchBot(io, effects.matchId, botUserId);
      for (const search of searches) {
        emitSearchState(io, search.userId, {
          state: 'matched', searchId: search.searchId, matchId: effects.matchId, lobbyId, vsBot: withBot,
        });
      }
      roomRealtimeService.markChanged(effects.userIds);
      await roomRealtimeService.announce(io, effects, 'zone_match', effects.engineVersion);
    } catch (error) {
      logger.warn({ error, matchId: effects.matchId }, 'Zone queue match delivery hiccup (resync repairs)');
    }
    logger.info({ matchId: effects.matchId, users: searches.map((s) => s.userId), vsBot: withBot }, 'Zone queue match started');
    return true;
  }, { waitMs: 1_200 });
  return started === true;
}

/** Pairs the two oldest searches while two are queued. Returns false when the lock was busy. */
async function runHumanPairSweep(io: QuizballServer): Promise<boolean> {
  const locked = await withMatchmakingLock(async () => {
    for (let i = 0; i < 5; i += 1) {
      const queued = await listSearches(io);
      if (queued.length < 2) return;
      const pair = queued.slice(0, 2);
      if (!await startQueueMatch(io, pair, false)) return;
    }
  });
  return locked !== null;
}

export const zoneMatchMatchmakingService = {
  async handleSearchStart(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    if (!queueOpen()) {
      socket.emit('error', { code: 'ZONE_QUEUE_UNAVAILABLE', message: 'Ranked 2.0 search is not available right now' });
      return;
    }
    const redis = getRedisClient();
    if (!redis?.isOpen) {
      socket.emit('error', { code: 'ZONE_QUEUE_UNAVAILABLE', message: 'Matchmaking is temporarily unavailable' });
      return;
    }
    const transitioned = await userSessionGuardService.withUserSessionLock(userId, async () => {
      const prepared = await userSessionGuardService.prepareForQueueJoin(io, userId, 'zone', { explicitJoin: true });
      if (!prepared.ok) {
        userSessionGuardService.emitBlocked(socket, {
          reason: prepared.reason ?? 'ACTIVE_MATCH',
          message: prepared.message ?? 'You are already in an active session',
          operation: 'zone:search_start',
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
      const search: QueuedZoneSearch = {
        searchId: randomUUID(),
        userId,
        isGuest: socket.data.user.is_guest === true,
        queuedAt: now,
        fallbackAt: nextFallbackAt({ queuedAt: now }, now),
      };
      await writeSearch(search);
      await scheduleFallback(search);
      emitSearchState(io, userId, {
        state: 'searching', searchId: search.searchId,
        queuedAt: new Date(search.queuedAt).toISOString(),
        fallbackAt: new Date(search.fallbackAt).toISOString(),
      });
      return true;
    }, { waitMs: 1_200 });
    if (transitioned === null) {
      socket.emit('error', { code: 'ZONE_SEARCH_BUSY', message: 'Your search is already changing. Please retry.' });
      return;
    }
    if (!transitioned) return;
    await runHumanPairSweep(io);
  },

  async handleSearchCancel(io: QuizballServer, socket: QuizballSocket, expectedSearchId: string): Promise<void> {
    const userId = socket.data.user.id;
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    // Removal needs only the user's session lock: startQueueMatch holds both participants' session locks and
    // re-reads the searches before creating anything, so this can never race a pairing into a double start.
    // '*' cancels whatever search the user has (a screen that left before the searching ack has no id).
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ran = await userSessionGuardService.withUserSessionLock(userId, async () => {
        const searchId = await redis.hGet(USER_MAP_KEY, userId);
        if (!searchId || (expectedSearchId !== '*' && searchId !== expectedSearchId)) return;
        const search = await readSearch(searchId);
        if (search) await removeSearch(search);
        else await redis.multi().zRem(QUEUE_KEY, searchId).hDel(USER_MAP_KEY, userId).exec();
        await userSessionGuardService.emitState(io, userId).catch(() => {});
      }, { waitMs: 1_200 });
      if (ran !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    // Confirmed (or the search was already gone / already matched — room:found wins over this).
    const remaining = await redis.hGet(USER_MAP_KEY, userId);
    if (!remaining || (expectedSearchId !== '*' && remaining !== expectedSearchId)) {
      emitSearchState(io, userId, { state: 'idle', searchId: expectedSearchId });
    }
  },

  /** The durable fallback fired: humans get first refusal, then the search seats the bot. */
  async handleFallbackTimer(io: QuizballServer, searchId: string, userId?: string): Promise<void> {
    // A timer armed before the switch went off ends its search instead of seating anyone.
    if (!queueOpen()) {
      const search = await readSearch(searchId);
      if (search) await expireSearch(io, search);
      return;
    }
    const swept = await runHumanPairSweep(io);
    const rearmShortRetry = async () => {
      const retryUserId = userId ?? (await readSearch(searchId))?.userId;
      if (!retryUserId) return;
      await scheduleRealtimeTimer(FALLBACK_TIMER_KIND, searchId, new Date(Date.now() + 250), { kind: FALLBACK_TIMER_KIND, searchId, userId: retryUserId });
    };
    if (!swept) return rearmShortRetry();
    const locked = await withMatchmakingLock(async () => {
      const search = await readSearch(searchId);
      if (!search) return;
      if (isSearchExpired(search)) return expireSearch(io, search);
      // Two queued searches can still pair as humans: push this fallback out instead of seating a bot.
      if ((await listSearches(io)).length >= 2) {
        const rearmed = { ...search, fallbackAt: nextFallbackAt(search) };
        await writeSearch(rearmed);
        await scheduleFallback(rearmed);
        return;
      }
      if (!await startQueueMatch(io, [search], true)) {
        const remaining = await readSearch(searchId);
        if (!remaining) return;
        const rearmed = { ...remaining, fallbackAt: nextFallbackAt(remaining) };
        await writeSearch(rearmed);
        await scheduleFallback(rearmed);
      }
    });
    if (locked === null) await rearmShortRetry();
  },

  /** The user's last socket left: an unmatched search does not sit in the queue for a player who is gone. */
  async handleSocketDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const redis = getRedisClient();
    if (!redis?.isOpen) return;
    if (!await redis.hGet(USER_MAP_KEY, userId)) return;
    const others = await io.in(`user:${userId}`).fetchSockets().catch(() => []);
    if (others.some((candidate) => candidate.id !== socket.id)) return;
    // Same session-lock-only removal as cancel: safe against pairings by startQueueMatch's revalidation.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const ran = await userSessionGuardService.withUserSessionLock(userId, async () => {
        const searchId = await redis.hGet(USER_MAP_KEY, userId);
        const search = searchId ? await readSearch(searchId) : null;
        if (search) await removeSearch(search);
        // The search record has a TTL, the user map does not: an expired record must not leave the map entry
        // behind (it would read as IN_QUEUE forever and block every other queue).
        else if (searchId) await redis.multi().zRem(QUEUE_KEY, searchId).hDel(USER_MAP_KEY, userId).exec();
      }, { waitMs: 1_200 });
      if (ran !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    logger.warn({ userId }, 'Zone queue disconnect cleanup could not take the session lock; the search TTL covers it');
  },
};
