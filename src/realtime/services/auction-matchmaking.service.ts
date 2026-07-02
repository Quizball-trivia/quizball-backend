import { randomUUID } from 'crypto';
import { ErrorCode } from '../../core/errors.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import {
  auctionContentService,
  auctionStateStore,
  type AuctionContentLocale,
} from '../../modules/auction/index.js';
import { findAuctionSeatByUserId } from '../../modules/auction/auction-match-state.js';
import type { FormationName } from '../../modules/auction/auction.types.js';
import {
  startAuctionMatchForHumans,
  rejoinAuctionMatch,
  type AuctionMatchHumanPlayer,
} from './auction-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import type {
  AuctionMatchFoundPayload,
  AuctionSearchCancelledPayload,
  AuctionSearchStartedPayload,
  AuctionSearchStatusPayload,
} from '../socket.types.js';
import {
  emitAuctionError,
  toAuctionErrorPayload,
} from './auction-action-errors.js';

const AUCTION_MM_QUEUE_KEY = 'auction:mm:queue';
const AUCTION_MM_USER_MAP_KEY = 'auction:mm:user';
const AUCTION_MM_SEARCH_KEY_PREFIX = 'auction:mm:search:';
const AUCTION_MM_LOCK_KEY = 'lock:auction:mm';
const AUCTION_MM_LOCK_TTL_MS = 5_000;
const AUCTION_MM_SEARCH_TTL_SEC = 120;
// First AI bidder is staged after this long alone (the initial wait for a
// second real player before any bot fill begins).
const AUCTION_ONE_HUMAN_FALLBACK_MS = 10_000;
// Staged bot backfill: after this long with no new real player, add ONE AI
// bidder, emit the updated count (so the client's search animation advances
// 1→2→3), then wait again before adding the next. Real players joining the
// queue short-circuit the wait. Tunable.
const AUCTION_BOT_BACKFILL_STEP_MS = 10_000;
// Server-authoritative pre-match "GET READY" countdown once all 3 seats fill.
const AUCTION_PREMATCH_COUNTDOWN_MS = 5_000;
const AUCTION_SEARCH_CANCEL_TIMER_KEY_PREFIX = 'auction:mm:fill:';

interface QueuedAuctionSearch {
  searchId: string;
  userId: string;
  displayName: string;
  locale: AuctionContentLocale;
  formation?: FormationName;
  queuedAt: number;
  fallbackAt: number;
  /** How many AI bidders have been staged into this search so far (0..2). */
  botFillCount?: number;
}

export interface AuctionSearchStartServiceInput {
  formation?: FormationName;
  locale: AuctionContentLocale;
}

export type AuctionMatchmakingFillPayload = {
  kind: 'auction_matchmaking_fill';
  searchId: string;
};

export const auctionMatchmakingService = {
  async handleSearchStart(
    io: QuizballServer,
    socket: QuizballSocket,
    input: AuctionSearchStartServiceInput
  ): Promise<void> {
    const user = socket.data.user;
    if (!user?.id) {
      emitAuctionError(socket, {
        code: ErrorCode.AUTHENTICATION_ERROR,
        message: 'Authentication required',
      });
      return;
    }

    // Block only if the user is GENUINELY still in a live match/lobby. The
    // `socket.data.matchId` flag can go stale (match finished, user forfeited/
    // left, or a reconnect re-set it) — so we self-heal like ranked does:
    // verify the match in Redis and clear the flag if it's dead, instead of
    // dead-ending the user on "already in a match".
    if (socket.data.lobbyId) {
      emitAuctionError(socket, {
        code: 'auction_search_blocked',
        message: 'You are already in a match or lobby',
      });
      return;
    }
    if (socket.data.matchId) {
      const staleMatchId = socket.data.matchId;
      const stillInLiveMatch = await isUserInLiveAuctionMatch(staleMatchId, user.id);
      if (stillInLiveMatch) {
        emitAuctionError(socket, {
          code: 'auction_search_blocked',
          message: 'You are already in a match or lobby',
        });
        return;
      }
      // Stale flag — clear it (and the user→match index) and let the search run.
      socket.data.matchId = undefined;
      await auctionStateStore.clearUserMatchIndex(user.id, staleMatchId).catch(() => {});
    }

    // Reload guard (keyed by USER, not the socket): a fresh socket after a page
    // reload has no socket.data.matchId, so the check above can't see an active
    // match. Look it up by userId and, if the user is still seated in a live
    // match, RE-JOIN them to it instead of starting a second match (which would
    // leave two matches both gating on this one client → the user can't bid).
    const activeMatchId = await auctionStateStore
      .getActiveMatchIdForUser(user.id)
      .catch(() => null);
    if (activeMatchId && (await isUserInLiveAuctionMatch(activeMatchId, user.id))) {
      const rejoined = await rejoinAuctionMatch(io, socket, activeMatchId);
      if (rejoined) return;
      // Match vanished between the two reads — fall through to a fresh search.
      await auctionStateStore.clearUserMatchIndex(user.id, activeMatchId).catch(() => {});
    }

    try {
      await auctionContentService.assertPublishedAuctionContentAvailable(input.locale);
    } catch (error) {
      emitAuctionError(socket, toAuctionErrorPayload(error, {
        fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
        fallbackMessage: 'Auction matchmaking failed',
      }));
      return;
    }

    const redis = getRedisClient();
    if (!redis?.isOpen) {
      try {
        const match = await startAuctionMatchForHumans(io, {
          humanPlayers: [{ userId: user.id, displayName: user.nickname ?? 'Player' }],
          formation: input.formation,
          locale: input.locale,
          sourceSocket: socket,
        });
        emitMatchFound(io, match.matchId, [{
          userId: user.id,
          displayName: user.nickname ?? 'Player',
        }], 2, input.locale, match.formation);
      } catch (error) {
        emitAuctionError(socket, toAuctionErrorPayload(error, {
          fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
          fallbackMessage: 'Auction matchmaking failed',
        }));
      }
      return;
    }

    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        const snapshot = await userSessionGuardService.resolveState(user.id);
        if (snapshot.activeMatchId || snapshot.waitingLobbyId || snapshot.state === 'CORRUPT_MULTI_STATE') {
          userSessionGuardService.emitBlocked(socket, {
            reason: 'ACTIVE_MATCH',
            message: 'You are already in an active session',
            operation: 'auction:search_start',
            stateSnapshot: snapshot,
          });
          return;
        }

        await withAuctionMatchmakingLock(async () => {
          const existingSearchId = await redis.hGet(AUCTION_MM_USER_MAP_KEY, user.id);
          if (existingSearchId) {
            const existing = await readSearch(redis, existingSearchId);
            if (existing) {
              // Re-attaching to an in-flight search (e.g. a page reload). Make
              // sure the bot-backfill fill timer is still armed — otherwise the
              // search hangs forever at its current count. Re-arm it relative to
              // now so the staged fill resumes.
              const rearmed: QueuedAuctionSearch = {
                ...existing,
                fallbackAt: Date.now() + harnessDelayMs(AUCTION_BOT_BACKFILL_STEP_MS, 1_000),
              };
              await writeSearch(redis, rearmed);
              await scheduleAuctionMatchmakingFill(rearmed);
              emitSearchStarted(io, rearmed, await countQueuedByLocale(redis, rearmed.locale));
              return;
            }
            await redis.hDel(AUCTION_MM_USER_MAP_KEY, user.id);
          }

          const now = Date.now();
          const search: QueuedAuctionSearch = {
            searchId: randomUUID(),
            userId: user.id,
            displayName: user.nickname ?? 'Player',
            locale: input.locale,
            formation: input.formation,
            queuedAt: now,
            fallbackAt: now + harnessDelayMs(AUCTION_ONE_HUMAN_FALLBACK_MS, 1_000),
          };
          await writeSearch(redis, search);
          await scheduleAuctionMatchmakingFill(search);
          emitSearchStarted(io, search, await countQueuedByLocale(redis, search.locale));
          await tryStartFullHumanMatchesLocked(io, search.locale);
        });
      },
      {
        code: 'AUCTION_SEARCH_BUSY',
        message: 'Auction search is already changing. Please retry.',
        operation: 'auction:search_start',
      }
    );

    if (!completed) {
      logger.warn({ userId: user.id }, 'Auction search start skipped: user transition lock busy');
    }
  },

  async handleSearchCancel(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const user = socket.data.user;
    if (!user?.id) return;
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        await withAuctionMatchmakingLock(async () => {
          const removed = await removeQueuedSearchForUser(redis, user.id);
          socket.emit('auction:search_cancelled', {
            searchId: removed?.searchId ?? null,
            reason: 'cancelled',
          } satisfies AuctionSearchCancelledPayload);
        });
      },
      {
        code: 'AUCTION_SEARCH_BUSY',
        message: 'Auction search is already changing. Please retry.',
        operation: 'auction:search_cancel',
      }
    );
  },

  async handleSocketDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const user = socket.data.user;
    if (!user?.id || socket.data.matchId || socket.data.lobbyId) return;
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    const otherSockets = await io.in(`user:${user.id}`).fetchSockets().catch(() => []);
    if (otherSockets.some((entry) => entry.id !== socket.id)) return;

    await withAuctionMatchmakingLock(async () => {
      const removed = await removeQueuedSearchForUser(redis, user.id);
      if (!removed) return;
      io.to(`user:${user.id}`).emit('auction:search_cancelled', {
        searchId: removed.searchId,
        reason: 'disconnect',
      } satisfies AuctionSearchCancelledPayload);
    });
  },

  async runFillTimer(io: QuizballServer, payload: AuctionMatchmakingFillPayload): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    await withAuctionMatchmakingLock(async () => {
      const anchor = await readSearch(redis, payload.searchId);
      if (!anchor) return;

      const queued = await listQueuedSearches(redis, anchor.locale);
      const fillGroup = queued.slice(0, 3);
      if (!fillGroup.some((entry) => entry.searchId === anchor.searchId)) return;
      if (fillGroup.length === 0) return;

      // Enough real humans to run a pure-human match — start it now.
      if (fillGroup.length >= 3) {
        await startMatchFromQueuedSearches(io, redis, fillGroup.slice(0, 3));
        return;
      }

      // Staged bot backfill: seats = real humans + AI bidders staged so far.
      const botFillCount = anchor.botFillCount ?? 0;
      const seatsFilled = fillGroup.length + botFillCount;

      if (seatsFilled < 3) {
        // Add ONE AI bidder, bump the broadcast count so the client's search
        // animation advances (1→2→3), then wait again before the next.
        const nextBotFill = botFillCount + 1;
        const updated: QueuedAuctionSearch = {
          ...anchor,
          botFillCount: nextBotFill,
          fallbackAt: Date.now() + harnessDelayMs(AUCTION_BOT_BACKFILL_STEP_MS, 1_000),
        };
        await writeSearch(redis, updated);
        // Broadcast the new count to every human in the fill group.
        for (const human of fillGroup) {
          const humanSearch = await readSearch(redis, human.searchId);
          if (humanSearch) emitSearchStatus(io, humanSearch, fillGroup.length + nextBotFill);
        }
        await scheduleRealtimeTimer(
          'auction_matchmaking_fill',
          fillTimerKey(anchor.searchId),
          new Date(updated.fallbackAt),
          { kind: 'auction_matchmaking_fill', searchId: anchor.searchId }
        );
        return;
      }

      // Seats are full (humans + staged bots) — start the match.
      await startMatchFromQueuedSearches(io, redis, fillGroup);
    });
  },
};

async function tryStartFullHumanMatchesLocked(
  io: QuizballServer,
  locale: AuctionContentLocale
): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;

  while (true) {
    const queued = await listQueuedSearches(redis, locale);
    if (queued.length < 3) return;
    await startMatchFromQueuedSearches(io, redis, queued.slice(0, 3));
  }
}

async function startMatchFromQueuedSearches(
  io: QuizballServer,
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  searches: readonly QueuedAuctionSearch[]
): Promise<void> {
  const oldest = searches[0];
  const humans = searches.map((search) => ({
    userId: search.userId,
    displayName: search.displayName,
  }));

  await claimSearches(redis, searches);
  try {
    const match = await startAuctionMatchForHumans(io, {
      humanPlayers: humans,
      formation: oldest.formation,
      locale: oldest.locale,
    });
    emitMatchFound(io, match.matchId, humans, 3 - humans.length, oldest.locale, match.formation);
    logger.info(
      {
        matchId: match.matchId,
        humanUserIds: humans.map((human) => human.userId),
        botCount: 3 - humans.length,
        locale: oldest.locale,
      },
      'Auction matchmaking started match'
    );
  } catch (error) {
    const payload = toAuctionErrorPayload(error, {
      fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
      fallbackMessage: 'Auction matchmaking failed',
    });
    for (const search of searches) {
      io.to(`user:${search.userId}`).emit('auction:error', payload);
    }
    logger.warn(
      { error, humanUserIds: humans.map((human) => human.userId), code: payload.code },
      'Auction matchmaking failed to start match'
    );
  }
}

function emitMatchFound(
  io: QuizballServer,
  matchId: string,
  humans: readonly AuctionMatchHumanPlayer[],
  botCount: number,
  locale: AuctionContentLocale,
  formation: FormationName
): void {
  const payload: AuctionMatchFoundPayload = {
    matchId,
    humanUserIds: humans.map((human) => human.userId),
    botCount,
    locale,
    formation,
    // Single server-chosen instant so all clients count down in sync.
    countdownEndsAt: new Date(Date.now() + AUCTION_PREMATCH_COUNTDOWN_MS).toISOString(),
  };
  for (const human of humans) {
    io.to(`user:${human.userId}`).emit('auction:match_found', payload);
  }
}

/**
 * True only if the user is genuinely still seated in a live (non-finished)
 * auction match. Used to self-heal a stale `socket.data.matchId` so a user who
 * left/forfeited/finished isn't wrongly blocked from searching again.
 */
async function isUserInLiveAuctionMatch(matchId: string, userId: string): Promise<boolean> {
  const state = await auctionStateStore.load(matchId).catch(() => null);
  if (!state) return false;
  if (state.phase === 'finished') return false;
  const seat = findAuctionSeatByUserId(state, userId);
  // A forfeited seat is not a live participation — the player quit; they must
  // be free to start a new search, not be steered back into the old match.
  // (Honest budget-elimination still counts as live: they spectate to the end.)
  return Boolean(seat) && !seat?.isBot && !seat?.forfeited;
}

function emitSearchStarted(
  io: QuizballServer,
  search: QueuedAuctionSearch,
  queuedUserCount: number
): void {
  io.to(`user:${search.userId}`).emit('auction:search_start', {
    searchId: search.searchId,
    locale: search.locale,
    queuedUserCount,
    seatsNeeded: Math.max(0, 3 - queuedUserCount),
    fallbackAt: new Date(search.fallbackAt).toISOString(),
  } satisfies AuctionSearchStartedPayload);
  io.to(`user:${search.userId}`).emit('auction:search_status', {
    searchId: search.searchId,
    locale: search.locale,
    queuedUserCount,
    seatsNeeded: Math.max(0, 3 - queuedUserCount),
    fallbackAt: new Date(search.fallbackAt).toISOString(),
  } satisfies AuctionSearchStatusPayload);
}

/** Emit just the live queue-count update (used by the staged bot backfill). */
function emitSearchStatus(
  io: QuizballServer,
  search: QueuedAuctionSearch,
  queuedUserCount: number
): void {
  io.to(`user:${search.userId}`).emit('auction:search_status', {
    searchId: search.searchId,
    locale: search.locale,
    queuedUserCount,
    seatsNeeded: Math.max(0, 3 - queuedUserCount),
    fallbackAt: new Date(search.fallbackAt).toISOString(),
  } satisfies AuctionSearchStatusPayload);
}

async function scheduleAuctionMatchmakingFill(search: QueuedAuctionSearch): Promise<void> {
  await scheduleRealtimeTimer(
    'auction_matchmaking_fill',
    fillTimerKey(search.searchId),
    new Date(search.fallbackAt),
    { kind: 'auction_matchmaking_fill', searchId: search.searchId }
  );
}

async function cancelAuctionMatchmakingFill(searchId: string): Promise<void> {
  await cancelRealtimeTimer('auction_matchmaking_fill', fillTimerKey(searchId));
}

function fillTimerKey(searchId: string): string {
  return `${AUCTION_SEARCH_CANCEL_TIMER_KEY_PREFIX}${searchId}`;
}

async function writeSearch(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  search: QueuedAuctionSearch
): Promise<void> {
  await redis
    .multi()
    .hSet(searchKey(search.searchId), {
      searchId: search.searchId,
      userId: search.userId,
      displayName: search.displayName,
      locale: search.locale,
      formation: search.formation ?? '',
      status: 'queued',
      queuedAt: String(search.queuedAt),
      fallbackAt: String(search.fallbackAt),
      botFillCount: String(search.botFillCount ?? 0),
    })
    .expire(searchKey(search.searchId), AUCTION_MM_SEARCH_TTL_SEC)
    .zAdd(AUCTION_MM_QUEUE_KEY, { score: search.queuedAt, value: search.searchId })
    .hSet(AUCTION_MM_USER_MAP_KEY, search.userId, search.searchId)
    .exec();
}

async function readSearch(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  searchId: string
): Promise<QueuedAuctionSearch | null> {
  const row = await redis.hGetAll(searchKey(searchId));
  if (!row || row.status !== 'queued') return null;
  const queuedAt = Number(row.queuedAt);
  const fallbackAt = Number(row.fallbackAt);
  if (!row.userId || !row.displayName || !isAuctionLocale(row.locale) || !Number.isFinite(queuedAt) || !Number.isFinite(fallbackAt)) {
    return null;
  }
  return {
    searchId,
    userId: row.userId,
    displayName: row.displayName,
    locale: row.locale,
    formation: isFormationName(row.formation) ? row.formation : undefined,
    queuedAt,
    fallbackAt,
    botFillCount: Number.isFinite(Number(row.botFillCount)) ? Number(row.botFillCount) : 0,
  };
}

async function listQueuedSearches(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  locale: AuctionContentLocale
): Promise<QueuedAuctionSearch[]> {
  const searchIds = await redis.zRange(AUCTION_MM_QUEUE_KEY, 0, -1);
  const searches = await Promise.all(searchIds.map((searchId) => readSearch(redis, searchId)));
  return searches
    .filter((search): search is QueuedAuctionSearch => search !== null && search.locale === locale)
    .sort((a, b) => a.queuedAt - b.queuedAt);
}

async function countQueuedByLocale(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  locale: AuctionContentLocale
): Promise<number> {
  return (await listQueuedSearches(redis, locale)).length;
}

async function claimSearches(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  searches: readonly QueuedAuctionSearch[]
): Promise<void> {
  await Promise.all(searches.map((search) => cancelAuctionMatchmakingFill(search.searchId)));
  const searchIds = searches.map((search) => search.searchId);
  const userIds = searches.map((search) => search.userId);
  const multi = redis.multi().zRem(AUCTION_MM_QUEUE_KEY, searchIds).hDel(AUCTION_MM_USER_MAP_KEY, userIds);
  for (const search of searches) {
    multi.hSet(searchKey(search.searchId), { status: 'matched' });
  }
  await multi.exec();
}

async function removeQueuedSearchForUser(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  userId: string
): Promise<QueuedAuctionSearch | null> {
  const searchId = await redis.hGet(AUCTION_MM_USER_MAP_KEY, userId);
  if (!searchId) return null;
  const search = await readSearch(redis, searchId);
  await cancelAuctionMatchmakingFill(searchId);
  await redis
    .multi()
    .zRem(AUCTION_MM_QUEUE_KEY, searchId)
    .hDel(AUCTION_MM_USER_MAP_KEY, userId)
    .hSet(searchKey(searchId), { status: 'cancelled' })
    .exec();
  return search;
}

async function withAuctionMatchmakingLock<T>(work: () => Promise<T>): Promise<T | null> {
  const lock = await acquireLock(AUCTION_MM_LOCK_KEY, AUCTION_MM_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return null;
  try {
    return await work();
  } finally {
    await releaseLock(AUCTION_MM_LOCK_KEY, lock.token).catch(() => {});
  }
}

function searchKey(searchId: string): string {
  return `${AUCTION_MM_SEARCH_KEY_PREFIX}${searchId}`;
}

function isAuctionLocale(value: string | undefined): value is AuctionContentLocale {
  return value === 'en' || value === 'ka';
}

function isFormationName(value: string | undefined): value is FormationName {
  return value === '4-3-3'
    || value === '4-4-2'
    || value === '3-5-2'
    || value === '4-2-3-1'
    || value === '3-4-3';
}
