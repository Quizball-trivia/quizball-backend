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
import type { AuctionPlayer, FormationName } from '../../modules/auction/auction.types.js';
import { FORMATION_BY_NAME } from '../../modules/auction/auction.constants.js';
import {
  parseStoredAvatarCustomization,
  type AvatarCustomization,
} from '../../modules/users/avatar-customization.js';
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
const AUCTION_MM_LOCK_TTL_MS = 30_000;
// A claimed search whose match failed to start is requeued this soon; after
// this many consecutive failures it is dropped with a client-visible error.
const AUCTION_MM_START_RETRY_MS = 3_000;
const AUCTION_MM_MAX_START_FAILURES = 3;
const AUCTION_MM_SEARCH_TTL_SEC = 120;
// Ranked-style fallback begins after this wait: any empty seats are filled by
// selected smart-bot profiles. The wait is RANDOMIZED per search — a fixed
// 10s meant every solo queue popped at the same instant, which read as
// scripted (owner feedback 2026-08-26): sometimes the lobby fills fast,
// sometimes it drags, like a real queue.
const AUCTION_FALLBACK_MIN_MS = 5_000;
const AUCTION_FALLBACK_MAX_MS = 18_000;
function randomFallbackDelayMs(): number {
  return harnessDelayMs(
    AUCTION_FALLBACK_MIN_MS + Math.random() * (AUCTION_FALLBACK_MAX_MS - AUCTION_FALLBACK_MIN_MS),
    1_000
  );
}
// Server-authoritative ranked-style pre-match sequence once all 3 seats fill.
// The full connected lineup stays visible first, followed by the showdown and
// then a five-second countdown shared by every browser.
const AUCTION_PREMATCH_LINEUP_MS = 2_500;
// 3s minimum so the showdown always reads, even when every client acks fast.
const AUCTION_PREMATCH_SHOWDOWN_MS = 3_000;
const AUCTION_PREMATCH_COUNTDOWN_MS = 5_000;
const AUCTION_SEARCH_CANCEL_TIMER_KEY_PREFIX = 'auction:mm:fill:';

interface QueuedAuctionSearch {
  searchId: string;
  userId: string;
  displayName: string;
  /** Database-backed layered avatar shown to every player in the waiting room. */
  avatarCustomization?: AvatarCustomization | null;
  locale: AuctionContentLocale;
  formation?: FormationName;
  queuedAt: number;
  fallbackAt: number;
  /** Transient match-start failures while this search was claimed — the search
   *  is requeued (not dropped) until AUCTION_MM_MAX_START_FAILURES. */
  startFailures?: number;
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
        const humans = [{
          userId: user.id,
          displayName: user.nickname ?? 'Player',
        }];
        await startAuctionMatchForHumans(io, {
          humanPlayers: [{ userId: user.id, displayName: user.nickname ?? 'Player' }],
          formation: input.formation,
          locale: input.locale,
          sourceSocket: socket,
        }, {
          beforeStartEvents: (prepared) => {
            emitMatchFound(
              io,
              prepared.matchId,
              humans,
              botPlayerSummaries(prepared.seats),
              input.locale,
              prepared.formation,
            );
          },
        });
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
        const prepared = await userSessionGuardService.prepareForQueueJoin(io, user.id, 'auction');
        const snapshot = prepared.snapshot;
        if (!prepared.ok || snapshot.activeMatchId || snapshot.waitingLobbyId || snapshot.state === 'CORRUPT_MULTI_STATE') {
          userSessionGuardService.emitBlocked(socket, {
            reason: prepared.reason ?? 'ACTIVE_MATCH',
            message: prepared.message ?? 'You are already in an active session',
            operation: 'auction:search_start',
            stateSnapshot: snapshot,
          });
          return;
        }

        const lockOutcome = await withAuctionMatchmakingLock(async () => {
          // The pre-lock guards are STALE by now (the bounded wait can be
          // seconds; a previous search may have committed into a match in the
          // meantime) — recheck the live-match index inside the lock or a
          // duplicate search sneaks in behind the user's own match.
          const activeNow = await auctionStateStore
            .getActiveMatchIdForUser(user.id)
            .catch(() => null);
          if (activeNow && (await isUserInLiveAuctionMatch(activeNow, user.id))) {
            await rejoinAuctionMatch(io, socket, activeNow).catch(() => {});
            return true;
          }
          const existingSearchId = await redis.hGet(AUCTION_MM_USER_MAP_KEY, user.id);
          if (existingSearchId) {
            const existing = await readSearch(redis, existingSearchId);
            if (existing) {
              // Re-attaching to an in-flight search (e.g. a page reload). Make
              // sure the ranked-style fallback timer is still armed — otherwise
              // the search could wait forever. Re-arm it relative to now.
              const rearmed: QueuedAuctionSearch = {
                ...existing,
                fallbackAt: Date.now() + randomFallbackDelayMs(),
              };
              await writeSearch(redis, rearmed);
              await scheduleAuctionMatchmakingFill(rearmed);
              const queued = await listQueuedSearches(redis);
              const group = queueGroupForSearch(queued, rearmed.searchId);
              emitSearchStarted(io, rearmed, group);
              logger.info(
                {
                  userId: user.id,
                  searchId: rearmed.searchId,
                  locale: rearmed.locale,
                  queueDepth: queued.length,
                },
                'Auction matchmaking search reattached'
              );
              return true;
            }
            await redis.hDel(AUCTION_MM_USER_MAP_KEY, user.id);
          }

          const now = Date.now();
          const search: QueuedAuctionSearch = {
            searchId: randomUUID(),
            userId: user.id,
            displayName: user.nickname ?? 'Player',
            avatarCustomization: parseStoredAvatarCustomization(user.avatar_customization),
            locale: input.locale,
            formation: input.formation,
            queuedAt: now,
            fallbackAt: now + randomFallbackDelayMs(),
          };
          await writeSearch(redis, search);
          await scheduleAuctionMatchmakingFill(search);
          const queued = await listQueuedSearches(redis);
          const group = queueGroupForSearch(queued, search.searchId);
          // A join changes the visible lobby for everyone already in this
          // three-seat group. Broadcast the same authoritative roster to all
          // of them so a player connected to another Railway replica updates
          // at the same time as the newly joined player.
          emitSearchStarted(io, search, group);
          emitSearchStatuses(io, group);
          logger.info(
            {
              userId: user.id,
              searchId: search.searchId,
              locale: search.locale,
              queueDepth: queued.length,
            },
            'Auction matchmaking search joined'
          );
          await tryStartFullHumanMatchesLocked(io);
          return true;
        });
        // Lock still busy after the bounded wait: the client got NOTHING —
        // surface a retryable error instead of a silent non-search.
        if (lockOutcome === null) {
          emitAuctionError(socket, {
            code: 'AUCTION_SEARCH_BUSY',
            message: 'Auction matchmaking is busy. Please retry.',
          });
        }
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
        const result = await withAuctionMatchmakingLock(async () => {
          const activeMatchId = await auctionStateStore
            .getActiveMatchIdForUser(user.id)
            .catch(() => null);
          if (activeMatchId && await isUserInLiveAuctionMatch(activeMatchId, user.id)) {
            emitAuctionError(socket, {
              code: 'auction_search_cancel_rejected',
              message: 'Auction match already started',
            });
            return;
          }
          const removed = await removeQueuedSearchForUser(redis, user.id);
          socket.emit('auction:search_cancelled', {
            searchId: removed?.searchId ?? null,
            reason: 'cancelled',
          } satisfies AuctionSearchCancelledPayload);
          if (removed) {
            emitAllQueueStatuses(io, await listQueuedSearches(redis));
          }
        });
        if (result === null) {
          emitAuctionError(socket, {
            code: 'auction_search_cancel_busy',
            message: 'Auction search is already changing. Please retry.',
          });
        }
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

    const cleaned = await withAuctionMatchmakingLock(async () => {
      const removed = await removeQueuedSearchForUser(redis, user.id);
      if (!removed) return true;
      io.to(`user:${user.id}`).emit('auction:search_cancelled', {
        searchId: removed.searchId,
        reason: 'disconnect',
      } satisfies AuctionSearchCancelledPayload);
      emitAllQueueStatuses(io, await listQueuedSearches(redis));
      return true;
    });
    // Lock busy through the whole bounded wait: retry once shortly after —
    // an unremoved search would otherwise match a user who is gone.
    if (cleaned === null) {
      setTimeout(() => {
        void withAuctionMatchmakingLock(async () => {
          const removed = await removeQueuedSearchForUser(redis, user.id);
          if (removed) {
            emitAllQueueStatuses(io, await listQueuedSearches(redis));
          }
        }).catch(() => {});
      }, 3_000);
    }
  },

  async runFillTimer(io: QuizballServer, payload: AuctionMatchmakingFillPayload): Promise<void> {
    const redis = getRedisClient();
    if (!redis?.isOpen) return;

    const completed = await withAuctionMatchmakingLock(async () => {
      const anchor = await readSearch(redis, payload.searchId);
      if (!anchor) return;
      // A concurrent handler already requeued/re-armed this search (its
      // fallbackAt moved into the future) — this stale firing must not retry
      // the same group again in the same wave.
      if (anchor.fallbackAt > Date.now() + 500) return;

      const queued = await listQueuedSearches(redis);
      const fillGroup = queued.slice(0, 3);
      if (!fillGroup.some((entry) => entry.searchId === anchor.searchId)) return;
      if (fillGroup.length === 0) return;

      // Enough real humans to run a pure-human match — start it now.
      if (fillGroup.length >= 3) {
        await startMatchFromQueuedSearches(io, redis, fillGroup.slice(0, 3));
        return;
      }

      // Ranked-style bot fallback: once the human wait expires, select and
      // reserve the real smart-bot profiles, then start. We never expose a
      // synthetic "bot joined" count without the corresponding username.
      await startMatchFromQueuedSearches(io, redis, fillGroup);
      return true;
    });

    // Lock still busy after the bounded wait (a burst of match starts holds it
    // for a while): this timer firing is the search's ONLY fill signal, so it
    // must re-arm rather than be consumed — a dropped fill strands the
    // searcher in the queue forever.
    if (completed === null) {
      const stillQueued = await readSearch(redis, payload.searchId).catch(() => null);
      if (!stillQueued) return;
      logger.warn(
        { searchId: payload.searchId },
        'Auction fill timer could not take the matchmaking lock; rescheduling'
      );
      await scheduleRealtimeTimer(
        'auction_matchmaking_fill',
        fillTimerKey(payload.searchId),
        new Date(Date.now() + 2_000),
        { kind: 'auction_matchmaking_fill', searchId: payload.searchId }
      );
    }
  },
};

async function tryStartFullHumanMatchesLocked(io: QuizballServer): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;

  while (true) {
    const queued = await listQueuedSearches(redis);
    if (queued.length < 3) return;
    const started = await startMatchFromQueuedSearches(io, redis, queued.slice(0, 3));
    // A failed start requeues its searches — looping here would re-pick the
    // same trio in a tight loop. Their fill timers own the retry cadence.
    if (!started) return;
  }
}

async function startMatchFromQueuedSearches(
  io: QuizballServer,
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  searches: readonly QueuedAuctionSearch[]
): Promise<boolean> {
  const oldest = searches[0];
  const humans = searches.map((search) => ({
    userId: search.userId,
    displayName: search.displayName,
    ...(search.avatarCustomization
      ? { avatarCustomization: search.avatarCustomization }
      : {}),
  }));

  await claimSearches(redis, searches);
  try {
    // Match humans from one shared queue, regardless of their UI language,
    // just like ranked matchmaking. Auction state currently has one shared
    // content locale, so the oldest search deterministically chooses the card
    // language while each client keeps its own locale for interface copy.
    const match = await startAuctionMatchForHumans(io, {
      humanPlayers: humans,
      formation: oldest.formation,
      locale: oldest.locale,
    }, {
      beforeStartEvents: (prepared) => {
        emitMatchFound(
          io,
          prepared.matchId,
          humans,
          botPlayerSummaries(prepared.seats),
          oldest.locale,
          prepared.formation,
        );
      },
    });
    const botPlayers = botPlayerSummaries(match.seats);
    logger.info(
      {
        matchId: match.matchId,
        humanUserIds: humans.map((human) => human.userId),
        botCount: botPlayers.length,
        locale: oldest.locale,
      },
      'Auction matchmaking started match'
    );
    return true;
  } catch (error) {
    // Transient start failures (DB admission shed under a burst, content
    // retries exhausted) must NOT eject users from the queue — the searches
    // were already claimed, so REQUEUE them with a fresh fill timer and only
    // give up (with a client-visible error) after repeated failures.
    const droppedSearches: QueuedAuctionSearch[] = [];
    for (const search of searches) {
      // The failure may have happened AFTER the match was durably saved and
      // indexed (socket attach, timers): those users are seated in a live
      // match — requeueing them would fork a duplicate match.
      const activeMatchId = await auctionStateStore
        .getActiveMatchIdForUser(search.userId)
        .catch(() => null);
      if (activeMatchId) continue;

      const startFailures = (search.startFailures ?? 0) + 1;
      if (startFailures >= AUCTION_MM_MAX_START_FAILURES) {
        droppedSearches.push(search);
        continue;
      }
      const requeued: QueuedAuctionSearch = {
        ...search,
        startFailures,
        fallbackAt: Date.now() + harnessDelayMs(AUCTION_MM_START_RETRY_MS, 1_000),
      };
      try {
        await writeSearch(redis, requeued);
        // A requeued search without a fill timer is stranded — treat a failed
        // schedule as a drop so the user at least gets the error.
        await scheduleRealtimeTimer(
          'auction_matchmaking_fill',
          fillTimerKey(requeued.searchId),
          new Date(requeued.fallbackAt),
          { kind: 'auction_matchmaking_fill', searchId: requeued.searchId }
        );
      } catch {
        await removeQueuedSearchForUser(redis, search.userId).catch(() => {});
        droppedSearches.push(search);
      }
    }

    const payload = toAuctionErrorPayload(error, {
      fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
      fallbackMessage: 'Auction matchmaking failed',
    });
    for (const search of droppedSearches) {
      io.to(`user:${search.userId}`).emit('auction:error', payload);
    }
    logger.warn(
      {
        error,
        humanUserIds: humans.map((human) => human.userId),
        requeuedCount: searches.length - droppedSearches.length,
        droppedCount: droppedSearches.length,
        code: payload.code,
      },
      'Auction matchmaking failed to start match'
    );
    return false;
  }
}

function emitMatchFound(
  io: QuizballServer,
  matchId: string,
  humans: readonly AuctionMatchHumanPlayer[],
  botPlayers: AuctionMatchFoundPayload['botPlayers'],
  locale: AuctionContentLocale,
  formation: FormationName
): void {
  const serverNowMs = Date.now();
  // Bots pop into the lineup at staggered, randomized moments — sometimes
  // together, usually seconds apart — instead of materializing as a block.
  // The lineup stage stretches to cover the last arrival.
  const togetherRoll = Math.random();
  let previousDelayMs = 0;
  const staggeredBots = botPlayers.map((bot, index) => {
    const joinDelayMs = index === 0
      ? Math.round(Math.random() * 1_500)
      : togetherRoll < 0.25
        ? previousDelayMs
        : previousDelayMs + Math.round(1_000 + Math.random() * 4_000);
    previousDelayMs = joinDelayMs;
    return { ...bot, joinDelayMs };
  });
  const maxJoinDelayMs = staggeredBots.reduce((max, bot) => Math.max(max, bot.joinDelayMs), 0);
  const lineupEndsAtMs = serverNowMs + maxJoinDelayMs + AUCTION_PREMATCH_LINEUP_MS;
  const showdownEndsAtMs = lineupEndsAtMs + AUCTION_PREMATCH_SHOWDOWN_MS;
  const payload: AuctionMatchFoundPayload = {
    matchId,
    humanUserIds: humans.map((human) => human.userId),
    botCount: staggeredBots.length,
    botPlayers: staggeredBots,
    locale,
    formation,
    serverNow: new Date(serverNowMs).toISOString(),
    lineupEndsAt: new Date(lineupEndsAtMs).toISOString(),
    showdownEndsAt: new Date(showdownEndsAtMs).toISOString(),
    // Single server-chosen instant so all clients finish the countdown in sync.
    countdownEndsAt: new Date(showdownEndsAtMs + AUCTION_PREMATCH_COUNTDOWN_MS).toISOString(),
  };
  for (const human of humans) {
    io.to(`user:${human.userId}`).emit('auction:match_found', payload);
  }
}

function botPlayerSummaries(seats: readonly AuctionPlayer[]): AuctionMatchFoundPayload['botPlayers'] {
  return seats
    .filter((seat) => seat.isBot)
    .map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
    }));
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
  group: readonly QueuedAuctionSearch[]
): void {
  const botCount = 0;
  const queuedUserCount = Math.min(3, group.length);
  const queuedPlayers = queuePlayerSummaries(group);
  io.to(`user:${search.userId}`).emit('auction:search_start', {
    searchId: search.searchId,
    locale: search.locale,
    queuedUserCount,
    seatsNeeded: Math.max(0, 3 - queuedUserCount),
    fallbackAt: new Date(search.fallbackAt).toISOString(),
    queuedPlayers,
    botCount,
  } satisfies AuctionSearchStartedPayload);
}

/** Emit the current three-seat lobby snapshot to every human in the group. */
function emitSearchStatuses(
  io: QuizballServer,
  group: readonly QueuedAuctionSearch[]
): void {
  if (group.length === 0) return;
  const queuedPlayers = queuePlayerSummaries(group);
  const botCount = 0;
  const queuedUserCount = Math.min(3, group.length);
  for (const search of group) {
    io.to(`user:${search.userId}`).emit('auction:search_status', {
      searchId: search.searchId,
      locale: search.locale,
      queuedUserCount,
      seatsNeeded: Math.max(0, 3 - queuedUserCount),
      fallbackAt: new Date(search.fallbackAt).toISOString(),
      queuedPlayers,
      botCount,
    } satisfies AuctionSearchStatusPayload);
  }
}

function emitAllQueueStatuses(
  io: QuizballServer,
  searches: readonly QueuedAuctionSearch[]
): void {
  for (let index = 0; index < searches.length; index += 3) {
    emitSearchStatuses(io, searches.slice(index, index + 3));
  }
}

function queueGroupForSearch(
  searches: readonly QueuedAuctionSearch[],
  searchId: string
): QueuedAuctionSearch[] {
  const index = searches.findIndex((search) => search.searchId === searchId);
  if (index < 0) return [];
  const start = Math.floor(index / 3) * 3;
  return searches.slice(start, start + 3);
}

function queuePlayerSummaries(group: readonly QueuedAuctionSearch[]) {
  return group.map((search) => ({
    userId: search.userId,
    displayName: search.displayName,
    ...(search.avatarCustomization
      ? { avatarCustomization: search.avatarCustomization }
      : {}),
  }));
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
      avatarCustomization: search.avatarCustomization
        ? JSON.stringify(search.avatarCustomization)
        : '',
      locale: search.locale,
      formation: search.formation ?? '',
      status: 'queued',
      queuedAt: String(search.queuedAt),
      fallbackAt: String(search.fallbackAt),
      startFailures: String(search.startFailures ?? 0),
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
    avatarCustomization: parseQueuedAvatarCustomization(row.avatarCustomization),
    locale: row.locale,
    formation: isFormationName(row.formation) ? row.formation : undefined,
    queuedAt,
    fallbackAt,
    startFailures: Number.isFinite(Number(row.startFailures)) ? Number(row.startFailures) : 0,
  };
}

function parseQueuedAvatarCustomization(value: string | undefined): AvatarCustomization | null {
  if (!value) return null;
  try {
    return parseStoredAvatarCustomization(JSON.parse(value));
  } catch {
    return null;
  }
}

async function listQueuedSearches(
  redis: NonNullable<ReturnType<typeof getRedisClient>>
): Promise<QueuedAuctionSearch[]> {
  const searchIds = await redis.zRange(AUCTION_MM_QUEUE_KEY, 0, -1);
  const searches = await Promise.all(searchIds.map((searchId) => readSearch(redis, searchId)));
  // writeSearch lands the hash and the ZSET member in one MULTI, so a null
  // read means the search is expired/corrupt/claimed — prune it instead of
  // letting dead members grow the set (and this O(n) scan) forever.
  const deadIds = searchIds.filter((_, index) => searches[index] === null);
  if (deadIds.length > 0) {
    await redis.zRem(AUCTION_MM_QUEUE_KEY, deadIds).catch(() => {});
  }
  return searches
    .filter((search): search is QueuedAuctionSearch => search !== null)
    .sort((a, b) => a.queuedAt - b.queuedAt);
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

/**
 * Bounded-WAIT lock (not a bare try-lock): under a queue burst the lock is held
 * for seconds at a time by match starts, and a caller that silently no-ops on
 * busy loses its one shot (a consumed fill timer = a stranded searcher). Waits
 * up to ~AUCTION_MM_LOCK_TTL_MS in short retries before giving up; callers that
 * still get null must reschedule themselves, never drop.
 */
async function withAuctionMatchmakingLock<T>(work: () => Promise<T>): Promise<T | null> {
  const attempts = 12;
  const delayMs = 400;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lock = await acquireLock(AUCTION_MM_LOCK_KEY, AUCTION_MM_LOCK_TTL_MS);
    if (lock.acquired && lock.token) {
      try {
        return await work();
      } finally {
        await releaseLock(AUCTION_MM_LOCK_KEY, lock.token).catch(() => {});
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
  }
  return null;
}

function searchKey(searchId: string): string {
  return `${AUCTION_MM_SEARCH_KEY_PREFIX}${searchId}`;
}

function isAuctionLocale(value: string | undefined): value is AuctionContentLocale {
  return value === 'en' || value === 'ka';
}

function isFormationName(value: string | undefined): value is FormationName {
  return value !== undefined && Object.hasOwn(FORMATION_BY_NAME, value);
}
