import { randomUUID } from 'crypto';
import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { cancelRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import {
  auctionContentService,
  AuctionContentError,
  AuctionContentErrorCode,
  type AuctionContentLocale,
} from '../../modules/auction/index.js';
import type { FormationName } from '../../modules/auction/auction.types.js';
import {
  startAuctionMatchForHumans,
  type AuctionMatchHumanPlayer,
} from './auction-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import type {
  AuctionErrorPayload,
  AuctionMatchFoundPayload,
  AuctionSearchCancelledPayload,
  AuctionSearchStartedPayload,
  AuctionSearchStatusPayload,
} from '../socket.types.js';

const AUCTION_MM_QUEUE_KEY = 'auction:mm:queue';
const AUCTION_MM_USER_MAP_KEY = 'auction:mm:user';
const AUCTION_MM_SEARCH_KEY_PREFIX = 'auction:mm:search:';
const AUCTION_MM_LOCK_KEY = 'lock:auction:mm';
const AUCTION_MM_LOCK_TTL_MS = 5_000;
const AUCTION_MM_SEARCH_TTL_SEC = 120;
const AUCTION_ONE_HUMAN_FALLBACK_MS = 12_000;
const AUCTION_TWO_HUMAN_FALLBACK_MS = 10_000;
const AUCTION_SEARCH_CANCEL_TIMER_KEY_PREFIX = 'auction:mm:fill:';

interface QueuedAuctionSearch {
  searchId: string;
  userId: string;
  displayName: string;
  locale: AuctionContentLocale;
  formation?: FormationName;
  queuedAt: number;
  fallbackAt: number;
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
        code: 'AUTHENTICATION_ERROR',
        message: 'Authentication required',
      });
      return;
    }

    if (socket.data.matchId || socket.data.lobbyId) {
      emitAuctionError(socket, {
        code: 'auction_search_blocked',
        message: 'You are already in a match or lobby',
      });
      return;
    }

    try {
      await auctionContentService.assertPublishedAuctionContentAvailable(input.locale);
    } catch (error) {
      emitAuctionError(socket, toAuctionErrorPayload(error));
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
        emitAuctionError(socket, toAuctionErrorPayload(error));
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
              emitSearchStarted(io, existing, await countQueuedByLocale(redis, existing.locale));
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
            fallbackAt: now + AUCTION_ONE_HUMAN_FALLBACK_MS,
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
      const fillGroup = queued.slice(0, 2);
      if (!fillGroup.some((entry) => entry.searchId === anchor.searchId)) return;
      if (fillGroup.length === 0) return;
      if (fillGroup.length >= 2) {
        const twoHumanReadyAt = fillGroup[1].queuedAt + AUCTION_TWO_HUMAN_FALLBACK_MS;
        if (Date.now() < twoHumanReadyAt) {
          await scheduleRealtimeTimer(
            'auction_matchmaking_fill',
            fillTimerKey(anchor.searchId),
            new Date(twoHumanReadyAt),
            { kind: 'auction_matchmaking_fill', searchId: anchor.searchId }
          );
          return;
        }
      }

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
    const payload = toAuctionErrorPayload(error);
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
  };
  for (const human of humans) {
    io.to(`user:${human.userId}`).emit('auction:match_found', payload);
  }
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

function emitAuctionError(socket: QuizballSocket, payload: AuctionErrorPayload): void {
  socket.emit('auction:error', payload);
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

function toAuctionErrorPayload(error: unknown): AuctionErrorPayload {
  if (error instanceof AuctionContentError) {
    return {
      code: error.auctionCode,
      message: error.message,
      meta: error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : undefined,
    };
  }

  return {
    code: AuctionContentErrorCode.CONTENT_UNAVAILABLE,
    message: error instanceof Error ? error.message : 'Auction matchmaking failed',
  };
}
