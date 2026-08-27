import { randomUUID } from 'crypto';
import { ErrorCode } from '../../core/errors.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { logger } from '../../core/logger.js';
import { appMetrics, setAuctionMatchmakingQueueDepth } from '../../core/metrics.js';
import { acquireLock, releaseLock } from '../locks.js';
import { getRedisClient } from '../redis.js';
import { config } from '../../core/config.js';
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
const AUCTION_MM_CLAIM_KEY_PREFIX = 'auction:mm:claim:';
const AUCTION_MM_CLAIMS_KEY = 'auction:mm:claims';
const AUCTION_MM_CLAIM_USER_MAP_KEY = 'auction:mm:claim:user';
const SHARED_PAIRING_USER_KEY_PREFIX = 'session:pairing:user:';
const AUCTION_MM_LOCK_KEY = 'lock:auction:mm';
const AUCTION_MM_LOCK_TTL_MS = 30_000;
const AUCTION_MM_CLAIM_LEASE_MS = 60_000;
const AUCTION_MM_CLAIM_HEARTBEAT_MS = 15_000;
const AUCTION_MM_CLAIM_TTL_SEC = 10 * 60;
const AUCTION_MM_DRAIN_INTERVAL_MS = 250;
const AUCTION_MM_RECOVERY_INTERVAL_MS = 5_000;
const AUCTION_MM_MAX_CONCURRENT_STARTS = 4;
const AUCTION_MM_MAX_GROUPS_PER_DRAIN = 12;
const AUCTION_MM_HUMAN_JOIN_WINDOW_MS = 5_000;
const AUCTION_MM_HUMAN_WAIT_EXTENSION_MS = 4_000;
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
  /** A near-deadline human arrival can extend this search once, never more. */
  humanWaitExtended?: boolean;
}

interface ClaimedAuctionGroup {
  claimToken: string;
  matchId: string;
  claimedAt: number;
  leaseUntil: number;
  searches: QueuedAuctionSearch[];
}

interface ClaimStartJob {
  io: QuizballServer;
  claim: ClaimedAuctionGroup;
  generation: number;
  heartbeat: { stop: () => void };
  resolve: () => void;
}

let matchmakingIo: QuizballServer | null = null;
let drainTimer: NodeJS.Timeout | null = null;
let recoveryTimer: NodeJS.Timeout | null = null;
let drainRunning = false;
let recoveryRunning = false;
let activeClaimStarts = 0;
let claimStartGeneration = 0;
const pendingClaimStarts: ClaimStartJob[] = [];

export interface AuctionSearchStartServiceInput {
  formation?: FormationName;
  locale: AuctionContentLocale;
}

export type AuctionMatchmakingFillPayload = {
  kind: 'auction_matchmaking_fill';
  searchId: string;
};

export const auctionMatchmakingService = {
  start(io: QuizballServer): void {
    matchmakingIo = io;
    if (!drainTimer) {
      drainTimer = setInterval(() => {
        void runPeriodicDrain().catch((error) => {
          logger.error({ error }, 'Auction matchmaking drain failed');
        });
      }, AUCTION_MM_DRAIN_INTERVAL_MS);
      drainTimer.unref();
    }
    if (!recoveryTimer) {
      recoveryTimer = setInterval(() => {
        void recoverAbandonedClaims().catch((error) => {
          logger.error({ error }, 'Auction matchmaking claim recovery failed');
        });
      }, AUCTION_MM_RECOVERY_INTERVAL_MS);
      recoveryTimer.unref();
    }
    void recoverAbandonedClaims().catch((error) => {
      logger.error({ error }, 'Auction matchmaking boot claim recovery failed');
    });
    logger.info({ concurrency: AUCTION_MM_MAX_CONCURRENT_STARTS }, 'Auction matchmaking drain started');
  },

  stop(): void {
    if (drainTimer) clearInterval(drainTimer);
    if (recoveryTimer) clearInterval(recoveryTimer);
    drainTimer = null;
    recoveryTimer = null;
    matchmakingIo = null;
    drainRunning = false;
    recoveryRunning = false;
    claimStartGeneration += 1;
    for (const job of pendingClaimStarts.splice(0)) {
      job.heartbeat.stop();
      job.resolve();
    }
  },

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
          // meantime) — recheck both the pairing fence and live-match index
          // inside the lock or a duplicate search can sneak in behind the
          // user's own claim/match.
          const pairingFence = await redis.get(sharedPairingUserKey(user.id));
          if (pairingFence) {
            return {
              claims: [] as ClaimedAuctionGroup[], search: null, group: [], reattached: false,
              queueDepth: 0, pairingBlocked: true,
            };
          }
          const activeNow = await auctionStateStore
            .getActiveMatchIdForUser(user.id)
            .catch(() => null);
          if (activeNow && (await isUserInLiveAuctionMatch(activeNow, user.id))) {
            const rejoined = await rejoinAuctionMatch(io, socket, activeNow).catch(() => false);
            if (rejoined) {
              return {
                claims: [] as ClaimedAuctionGroup[], search: null, group: [], reattached: false,
                queueDepth: 0, pairingBlocked: false,
              };
            }
            await auctionStateStore.clearUserMatchIndex(user.id, activeNow).catch(() => {});
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
              const queued = await listQueuedSearches(redis);
              const group = queueGroupForSearch(queued, rearmed.searchId);
              const claims = await claimFullHumanMatchesLocked(redis);
              return {
                claims, search: rearmed, group, reattached: true,
                queueDepth: queued.length, pairingBlocked: false,
              };
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
          const queued = await listQueuedSearches(redis);
          const group = queueGroupForSearch(queued, search.searchId);
          const claims = await claimFullHumanMatchesLocked(redis);
          return {
            claims, search, group, reattached: false,
            queueDepth: queued.length, pairingBlocked: false,
          };
        });
        // Lock still busy after the bounded wait: the client got NOTHING —
        // surface a retryable error instead of a silent non-search.
        if (lockOutcome === null) {
          emitAuctionError(socket, {
            code: 'AUCTION_SEARCH_BUSY',
            message: 'Auction matchmaking is busy. Please retry.',
          });
          return;
        }
        if (lockOutcome.pairingBlocked) {
          userSessionGuardService.emitBlocked(socket, {
            reason: 'ACTIVE_MATCH',
            message: 'Your match is starting',
            operation: 'auction:search_start',
            stateSnapshot: snapshot,
          });
          return;
        }
        if (lockOutcome.search) {
          const claimed = lockOutcome.claims.some((claim) => (
            claim.searches.some((entry) => entry.searchId === lockOutcome.search?.searchId)
          ));
          if (!claimed) {
            try {
              await scheduleAuctionMatchmakingFill(lockOutcome.search);
            } catch (error) {
              await withAuctionMatchmakingLock(() => (
                removeQueuedSearchForUser(redis, lockOutcome.search!.userId)
              )).catch(() => null);
              emitAuctionError(socket, toAuctionErrorPayload(error, {
                fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
                fallbackMessage: 'Auction matchmaking failed',
              }));
              return;
            }
          }
          // Queue I/O and socket fan-out are intentionally outside the global
          // lock; only the shared queue mutation and seat claim are fenced.
          emitSearchStarted(io, lockOutcome.search, lockOutcome.group);
          if (!lockOutcome.reattached) emitSearchStatuses(io, lockOutcome.group);
          logger.info(
            {
              userId: user.id,
              searchId: lockOutcome.search.searchId,
              locale: lockOutcome.search.locale,
              queueDepth: lockOutcome.queueDepth,
            },
            lockOutcome.reattached
              ? 'Auction matchmaking search reattached'
              : 'Auction matchmaking search joined',
          );
        }
        // Claim ownership is durable. Do not hold the per-user transition lock
        // while the bounded worker pool creates and hands off the match.
        for (const claim of lockOutcome.claims) void enqueueClaimStart(io, claim);
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
          const claimToken = await redis.hGet(AUCTION_MM_CLAIM_USER_MAP_KEY, user.id);
          if (claimToken) {
            emitAuctionError(socket, {
              code: 'auction_search_cancel_rejected',
              message: 'Auction match is starting',
            });
            return;
          }
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

    // Kill-switch: a search queued before AUCTION_ENABLED was flipped off (or
    // re-armed across a redeploy) must never fill into a NEW match while the
    // mode is disabled. Cancel it cleanly instead of leaving it queued forever.
    if (!config.AUCTION_ENABLED) {
      await withAuctionMatchmakingLock(async () => {
        const anchor = await readSearch(redis, payload.searchId);
        if (!anchor) return;
        const removed = await removeQueuedSearchForUser(redis, anchor.userId).catch(() => null);
        if (removed) {
          io.to(`user:${anchor.userId}`).emit('auction:search_cancelled', {
            searchId: removed.searchId,
            reason: 'cancelled',
          } satisfies AuctionSearchCancelledPayload);
        }
        emitAllQueueStatuses(io, await listQueuedSearches(redis));
      });
      return;
    }

    const outcome = await withAuctionMatchmakingLock(async (): Promise<
      | { kind: 'none' }
      | { kind: 'extended'; searches: QueuedAuctionSearch[] }
      | { kind: 'claimed'; claim: ClaimedAuctionGroup }
    > => {
      const anchor = await readSearch(redis, payload.searchId);
      if (!anchor) return { kind: 'none' };
      // A concurrent handler already requeued/re-armed this search (its
      // fallbackAt moved into the future) — this stale firing must not retry
      // the same group again in the same wave.
      if (anchor.fallbackAt > Date.now() + 500) return { kind: 'none' };

      const queued = await listQueuedSearches(redis);
      const fillGroup = queued.slice(0, 3);
      if (!fillGroup.some((entry) => entry.searchId === anchor.searchId)) return { kind: 'none' };
      if (fillGroup.length === 0) return { kind: 'none' };

      // Enough real humans to run a pure-human match — start it now.
      if (fillGroup.length >= 3) {
        const claim = await claimSearchGroupLocked(redis, fillGroup.slice(0, 3));
        return claim ? { kind: 'claimed', claim } : { kind: 'none' };
      }

      // If another human arrived in the last five seconds, give this group one
      // short, shared grace window before filling the remaining seats with
      // bots. Mark every member now so overlapping durable timers cannot stack
      // extensions for the same searches.
      const now = Date.now();
      const anotherRecentHuman = fillGroup.some((entry) => (
        entry.searchId !== anchor.searchId
        && now - entry.queuedAt <= AUCTION_MM_HUMAN_JOIN_WINDOW_MS
      ));
      if (
        fillGroup.every((search) => !search.humanWaitExtended)
        && anotherRecentHuman
      ) {
        const extended = fillGroup.map((search) => ({
          ...search,
          humanWaitExtended: true,
          fallbackAt: now + AUCTION_MM_HUMAN_WAIT_EXTENSION_MS,
        }));
        for (const search of extended) await writeSearch(redis, search);
        return { kind: 'extended', searches: extended };
      }

      // Ranked-style bot fallback: once the human wait expires, select and
      // reserve the real smart-bot profiles, then start. We never expose a
      // synthetic "bot joined" count without the corresponding username.
      const claim = await claimSearchGroupLocked(redis, fillGroup);
      return claim ? { kind: 'claimed', claim } : { kind: 'none' };
    });

    // The lock now contains queue mutation only, but a consumed durable timer
    // must still re-arm if another replica briefly owns it.
    if (outcome === null) {
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
      return;
    }

    if (outcome.kind === 'extended') {
      await Promise.all(outcome.searches.map(scheduleAuctionMatchmakingFill));
      emitSearchStatuses(io, outcome.searches);
      return;
    }
    if (outcome.kind === 'claimed') {
      await enqueueClaimStart(io, outcome.claim);
    }
  },
};

async function claimFullHumanMatchesLocked(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  maxGroups = Math.min(AUCTION_MM_MAX_GROUPS_PER_DRAIN, availableClaimStartSlots()),
): Promise<ClaimedAuctionGroup[]> {
  const claims: ClaimedAuctionGroup[] = [];
  while (claims.length < maxGroups) {
    const queued = await listQueuedSearches(redis);
    if (queued.length < 3) break;
    const claim = await claimSearchGroupLocked(redis, queued.slice(0, 3));
    if (!claim) break;
    claims.push(claim);
  }
  return claims;
}

async function startClaimedGroup(
  io: QuizballServer,
  claim: ClaimedAuctionGroup,
  heartbeat: { stop: () => void },
): Promise<void> {
  // Production kill switch: claims can already be queued in this replica's
  // bounded worker pool when AUCTION_ENABLED flips off. Cancel those claims
  // before any new match state is created.
  if (!config.AUCTION_ENABLED) {
    try {
      await cancelClaimForDisabledMode(io, claim);
    } finally {
      heartbeat.stop();
    }
    return;
  }

  // Pending jobs renew their lease while waiting for a worker slot. Recheck
  // the durable claim and both ownership fences immediately before creating
  // any match state so a recovered/stale job cannot start a duplicate match.
  let ownsClaim: boolean;
  try {
    ownsClaim = await renewClaimLease(claim);
  } catch (error) {
    heartbeat.stop();
    throw error;
  }
  if (!ownsClaim) {
    logger.warn(
      { claimToken: claim.claimToken, matchId: claim.matchId },
      'Auction claimed match start skipped because claim ownership was lost',
    );
    heartbeat.stop();
    return;
  }

  const oldest = claim.searches[0];
  const humans = claim.searches.map((search) => ({
    userId: search.userId,
    displayName: search.displayName,
    ...(search.avatarCustomization
      ? { avatarCustomization: search.avatarCustomization }
      : {}),
  }));

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
      context: {
        createId: (kind) => kind === 'match' ? claim.matchId : randomUUID(),
      },
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
    await completeClaim(claim, 'completed');
    const botPlayers = botPlayerSummaries(match.seats);
    const humanSeatShare = humans.length / Math.max(1, match.seats.length);
    for (const search of claim.searches) {
      appMetrics.auctionMatchmakingQueueWaitDuration.record(
        Math.max(0, Date.now() - search.queuedAt),
        { human_seats: String(humans.length) },
      );
    }
    appMetrics.auctionMatchmakingHumanSeatShare.record(humanSeatShare, {
      human_seats: String(humans.length),
    });
    logger.info(
      {
        matchId: match.matchId,
        claimToken: claim.claimToken,
        humanUserIds: humans.map((human) => human.userId),
        botCount: botPlayers.length,
        locale: oldest.locale,
      },
      'Auction matchmaking started match'
    );
  } catch (error) {
    // The state save is the commit point. A later socket/timer failure must not
    // requeue these users into a second match; reconnect and boot recovery can
    // redeliver the already-indexed match.
    const committed = await auctionStateStore.load(claim.matchId).catch(() => null);
    if (committed) {
      await completeClaim(claim, 'completed');
      logger.warn(
        { error, claimToken: claim.claimToken, matchId: claim.matchId },
        'Auction match committed; handoff deferred to reconnect recovery',
      );
      return;
    }

    // Transient start failures (DB admission shed under a burst, content
    // retries exhausted) must NOT eject users from the queue — the searches
    // were already claimed, so REQUEUE them with a fresh fill timer and only
    // give up (with a client-visible error) after repeated failures.
    const { requeued, dropped } = await requeueFailedClaim(claim);

    const payload = toAuctionErrorPayload(error, {
      fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
      fallbackMessage: 'Auction matchmaking failed',
    });
    for (const search of dropped) {
      io.to(`user:${search.userId}`).emit('auction:error', payload);
    }
    logger.warn(
      {
        error,
        claimToken: claim.claimToken,
        humanUserIds: humans.map((human) => human.userId),
        requeuedCount: requeued.length,
        droppedCount: dropped.length,
        code: payload.code,
      },
      'Auction matchmaking failed to start match'
    );
  } finally {
    heartbeat.stop();
  }
}

function availableClaimStartSlots(): number {
  return Math.max(0, AUCTION_MM_MAX_CONCURRENT_STARTS - activeClaimStarts - pendingClaimStarts.length);
}

function enqueueClaimStart(io: QuizballServer, claim: ClaimedAuctionGroup): Promise<void> {
  return new Promise((resolve) => {
    pendingClaimStarts.push({
      io,
      claim,
      generation: claimStartGeneration,
      heartbeat: startClaimHeartbeat(claim),
      resolve,
    });
    pumpClaimStarts();
  });
}

function pumpClaimStarts(): void {
  while (activeClaimStarts < AUCTION_MM_MAX_CONCURRENT_STARTS) {
    const job = pendingClaimStarts.shift();
    if (!job) return;
    if (job.generation !== claimStartGeneration) {
      job.heartbeat.stop();
      job.resolve();
      continue;
    }
    activeClaimStarts += 1;
    void startClaimedGroup(job.io, job.claim, job.heartbeat)
      .catch((error) => {
        logger.error(
          { error, claimToken: job.claim.claimToken },
          'Auction claimed match start rejected unexpectedly',
        );
      })
      .finally(() => {
        activeClaimStarts = Math.max(0, activeClaimStarts - 1);
        job.resolve();
        pumpClaimStarts();
      });
  }
}

async function runPeriodicDrain(): Promise<void> {
  if (drainRunning) return;
  if (!config.AUCTION_ENABLED) return;
  const io = matchmakingIo;
  const redis = getRedisClient();
  const available = availableClaimStartSlots();
  if (!io || !redis?.isOpen || available <= 0) return;
  drainRunning = true;
  try {
    // Every replica polls this shared queue. Avoid serializing on the global
    // claim lock when there are not enough humans to form a match.
    const depth = await redis.zCard(AUCTION_MM_QUEUE_KEY).catch(() => 0);
    setAuctionMatchmakingQueueDepth(depth);
    if (depth < 3) return;
    const claims = await withAuctionMatchmakingLock(() => (
      claimFullHumanMatchesLocked(redis, available)
    ));
    if (!claims) return;
    for (const claim of claims) void enqueueClaimStart(io, claim);
  } finally {
    drainRunning = false;
  }
}

async function recoverAbandonedClaims(): Promise<void> {
  if (recoveryRunning) return;
  const io = matchmakingIo;
  const redis = getRedisClient();
  if (!io || !redis?.isOpen) return;
  recoveryRunning = true;
  try {
    const dueTokens = await redis.zRangeByScore(AUCTION_MM_CLAIMS_KEY, 0, Date.now(), {
      LIMIT: { offset: 0, count: 50 },
    });
    for (const claimToken of dueTokens) {
      const claim = await readClaim(redis, claimToken);
      if (!claim) {
        await redis.zRem(AUCTION_MM_CLAIMS_KEY, claimToken);
        continue;
      }
      if (claim.leaseUntil > Date.now()) continue;
      const committed = await auctionStateStore.load(claim.matchId).catch(() => null);
      if (committed) {
        await completeClaim(claim, 'recovered_committed');
        continue;
      }
      if (!config.AUCTION_ENABLED) {
        await cancelClaimForDisabledMode(io, claim);
        continue;
      }
      const result = await requeueFailedClaim(claim, io);
      logger.warn(
        {
          claimToken,
          requeuedCount: result.requeued.length,
          droppedCount: result.dropped.length,
        },
        'Recovered abandoned Auction matchmaking claim',
      );
    }
  } finally {
    recoveryRunning = false;
  }
}

async function claimSearchGroupLocked(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  searches: readonly QueuedAuctionSearch[],
): Promise<ClaimedAuctionGroup | null> {
  if (!config.AUCTION_ENABLED) return null;
  if (searches.length < 1 || searches.length > 3) return null;
  const current = await Promise.all(searches.map((search) => readSearch(redis, search.searchId)));
  if (current.some((search, index) => (
    !search || search.userId !== searches[index].userId
  ))) return null;
  const currentIds = await Promise.all(
    searches.map((search) => redis.hGet(AUCTION_MM_USER_MAP_KEY, search.userId)),
  );
  if (currentIds.some((searchId, index) => searchId !== searches[index].searchId)) return null;

  const claimToken = randomUUID();
  const claimedUserIds: string[] = [];
  for (const search of searches) {
    const claimed = await redis.set(sharedPairingUserKey(search.userId), claimToken, {
      NX: true,
      PX: AUCTION_MM_CLAIM_LEASE_MS,
    });
    if (claimed !== 'OK') {
      await userSessionGuardService.releaseActivityFences(claimedUserIds, claimToken);
      return null;
    }
    claimedUserIds.push(search.userId);
  }

  const claimedAt = Date.now();
  const claim: ClaimedAuctionGroup = {
    claimToken,
    matchId: claimToken,
    claimedAt,
    leaseUntil: claimedAt + AUCTION_MM_CLAIM_LEASE_MS,
    searches: searches.map((search) => ({ ...search })),
  };
  try {
    const searchIds = claim.searches.map((search) => search.searchId);
    const userIds = claim.searches.map((search) => search.userId);
    const transaction = redis
      .multi()
      .hSet(claimKey(claimToken), claimHashFields(claim, 'claimed'))
      .expire(claimKey(claimToken), AUCTION_MM_CLAIM_TTL_SEC)
      .zAdd(AUCTION_MM_CLAIMS_KEY, { score: claim.leaseUntil, value: claimToken })
      .zRem(AUCTION_MM_QUEUE_KEY, searchIds)
      .hDel(AUCTION_MM_USER_MAP_KEY, userIds)
      .hSet(AUCTION_MM_CLAIM_USER_MAP_KEY, Object.fromEntries(
        userIds.map((userId) => [userId, claimToken]),
      ));
    for (const search of claim.searches) {
      transaction.hSet(searchKey(search.searchId), {
        status: 'claimed',
        claimToken,
      });
    }
    await transaction.exec();
    setAuctionMatchmakingQueueDepth(Math.max(0, await redis.zCard(AUCTION_MM_QUEUE_KEY)));
  } catch (error) {
    // EXEC can have an uncertain outcome if the connection drops after Redis
    // commits but before the reply reaches this process. If the durable claim
    // is visible, keep its fences and continue; recovery owns any later crash.
    try {
      const committedClaim = await readClaim(redis, claimToken);
      if (committedClaim) return committedClaim;
    } catch (readError) {
      // Do not release an uncertain fence. Its bounded TTL is safer than
      // allowing the same users into another mode while a committed claim may
      // be recovered on a different replica.
      logger.warn({ error: readError, claimToken }, 'Auction claim outcome could not be verified');
      throw error;
    }
    await userSessionGuardService.releaseActivityFences(claimedUserIds, claimToken);
    throw error;
  }

  // Durable timer cancellation is best-effort and deliberately outside the
  // global lock. A late timer is harmless because claimed searches no longer
  // read as queued.
  void Promise.all(claim.searches.map((search) => (
    cancelAuctionMatchmakingFill(search.searchId)
  ))).catch((error) => {
    logger.warn({ error, claimToken }, 'Auction claim timer cancellation failed');
  });
  return claim;
}

function startClaimHeartbeat(claim: ClaimedAuctionGroup): { stop: () => void } {
  const timer = setInterval(() => {
    void renewClaimLease(claim).catch((error) => {
      logger.warn({ error, claimToken: claim.claimToken }, 'Auction claim heartbeat failed');
    });
  }, AUCTION_MM_CLAIM_HEARTBEAT_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

async function renewClaimLease(claim: ClaimedAuctionGroup): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  const renewed = await withAuctionMatchmakingLock(async () => {
    const row = await redis.hGetAll(claimKey(claim.claimToken));
    if (row.status !== 'claimed' || row.matchId !== claim.matchId) return false;
    for (const search of claim.searches) {
      const [claimOwner, pairingOwner] = await Promise.all([
        redis.hGet(AUCTION_MM_CLAIM_USER_MAP_KEY, search.userId),
        redis.get(sharedPairingUserKey(search.userId)),
      ]);
      if (claimOwner !== claim.claimToken || pairingOwner !== claim.claimToken) return false;
    }
    const leaseUntil = Date.now() + AUCTION_MM_CLAIM_LEASE_MS;
    await redis
      .multi()
      .hSet(claimKey(claim.claimToken), { leaseUntil: String(leaseUntil) })
      .expire(claimKey(claim.claimToken), AUCTION_MM_CLAIM_TTL_SEC)
      .zAdd(AUCTION_MM_CLAIMS_KEY, { score: leaseUntil, value: claim.claimToken })
      .exec();
    return true;
  });
  if (renewed) {
    const fencesRenewed = await userSessionGuardService.renewActivityFences(
      claim.searches.map((search) => search.userId),
      claim.claimToken,
      AUCTION_MM_CLAIM_LEASE_MS,
    );
    return fencesRenewed;
  }
  return false;
}

async function completeClaim(
  claim: ClaimedAuctionGroup,
  status: 'completed' | 'recovered_committed',
): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const completed = await withAuctionMatchmakingLock(async () => {
    const row = await redis.hGetAll(claimKey(claim.claimToken));
    if (row.status !== 'claimed') return false;
    await redis
      .multi()
      .hSet(claimKey(claim.claimToken), {
        status,
        completedAt: String(Date.now()),
      })
      .expire(claimKey(claim.claimToken), AUCTION_MM_CLAIM_TTL_SEC)
      .zRem(AUCTION_MM_CLAIMS_KEY, claim.claimToken)
      .hDel(
        AUCTION_MM_CLAIM_USER_MAP_KEY,
        claim.searches.map((search) => search.userId),
      )
      .exec();
    return true;
  });
  if (completed) {
    await userSessionGuardService.releaseActivityFences(
      claim.searches.map((search) => search.userId),
      claim.claimToken,
    );
  }
}

async function cancelClaimForDisabledMode(
  io: QuizballServer,
  claim: ClaimedAuctionGroup,
): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  const cancelled = await withAuctionMatchmakingLock(async () => {
    const row = await redis.hGetAll(claimKey(claim.claimToken));
    if (row.status !== 'claimed') return false;
    const transaction = redis
      .multi()
      .hSet(claimKey(claim.claimToken), {
        status: 'cancelled_disabled',
        completedAt: String(Date.now()),
      })
      .expire(claimKey(claim.claimToken), AUCTION_MM_CLAIM_TTL_SEC)
      .zRem(AUCTION_MM_CLAIMS_KEY, claim.claimToken)
      .hDel(
        AUCTION_MM_CLAIM_USER_MAP_KEY,
        claim.searches.map((search) => search.userId),
      );
    for (const search of claim.searches) {
      transaction.hSet(searchKey(search.searchId), { status: 'cancelled' });
    }
    await transaction.exec();
    return true;
  });
  if (!cancelled) return;

  await userSessionGuardService.releaseActivityFences(
    claim.searches.map((search) => search.userId),
    claim.claimToken,
  );
  for (const search of claim.searches) {
    io.to(`user:${search.userId}`).emit('auction:search_cancelled', {
      searchId: search.searchId,
      reason: 'cancelled',
    } satisfies AuctionSearchCancelledPayload);
  }
}

async function requeueFailedClaim(
  claim: ClaimedAuctionGroup,
  io: QuizballServer | null = matchmakingIo,
): Promise<{ requeued: QueuedAuctionSearch[]; dropped: QueuedAuctionSearch[] }> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return { requeued: [], dropped: [...claim.searches] };
  const result = await withAuctionMatchmakingLock(async () => {
    const row = await redis.hGetAll(claimKey(claim.claimToken));
    if (row.status !== 'claimed') return { requeued: [], dropped: [] };

    const fencesOwned = await ensureClaimFences(redis, claim);
    const states = fencesOwned
      ? await userSessionGuardService.resolveStates(claim.searches.map((search) => search.userId))
      : new Map();

    const requeued: QueuedAuctionSearch[] = [];
    const dropped: QueuedAuctionSearch[] = [];
    for (const search of claim.searches) {
      const startFailures = (search.startFailures ?? 0) + 1;
      const state = states.get(search.userId);
      const hasConflictingSession = !fencesOwned
        || !state
        || Boolean(state.activeMatchId)
        || Boolean(state.queueSearchId)
        || state.openLobbyIds.length > 0;
      if (hasConflictingSession || startFailures >= AUCTION_MM_MAX_START_FAILURES) {
        dropped.push(search);
      } else {
        requeued.push({
          ...search,
          startFailures,
          fallbackAt: Date.now() + harnessDelayMs(AUCTION_MM_START_RETRY_MS, 1_000),
        });
      }
    }

    const transaction = redis
      .multi()
      .hSet(claimKey(claim.claimToken), {
        status: 'requeued',
        completedAt: String(Date.now()),
      })
      .expire(claimKey(claim.claimToken), AUCTION_MM_CLAIM_TTL_SEC)
      .zRem(AUCTION_MM_CLAIMS_KEY, claim.claimToken)
      .hDel(
        AUCTION_MM_CLAIM_USER_MAP_KEY,
        claim.searches.map((search) => search.userId),
      );
    for (const search of requeued) {
      transaction
        .hSet(searchKey(search.searchId), searchHashFields(search, 'queued'))
        .expire(searchKey(search.searchId), AUCTION_MM_SEARCH_TTL_SEC)
        .zAdd(AUCTION_MM_QUEUE_KEY, { score: search.queuedAt, value: search.searchId })
        .hSet(AUCTION_MM_USER_MAP_KEY, search.userId, search.searchId);
    }
    for (const search of dropped) {
      transaction.hSet(searchKey(search.searchId), { status: 'failed' });
    }
    await transaction.exec();
    setAuctionMatchmakingQueueDepth(Math.max(0, await redis.zCard(AUCTION_MM_QUEUE_KEY)));
    return { requeued, dropped };
  });

  await userSessionGuardService.releaseActivityFences(
    claim.searches.map((search) => search.userId),
    claim.claimToken,
  );
  if (!result) return { requeued: [], dropped: [] };

  const scheduled: QueuedAuctionSearch[] = [];
  const scheduleDropped = [...result.dropped];
  for (const search of result.requeued) {
    try {
      await scheduleAuctionMatchmakingFill(search);
      scheduled.push(search);
    } catch {
      await removeQueuedSearchForUser(redis, search.userId).catch(() => {});
      scheduleDropped.push(search);
    }
  }
  if (io && scheduled.length > 0) {
    emitAllQueueStatuses(io, await listQueuedSearches(redis));
  }
  if (io) {
    for (const search of scheduleDropped) {
      io.to(`user:${search.userId}`).emit('auction:search_cancelled', {
        searchId: search.searchId,
        reason: 'cancelled',
      } satisfies AuctionSearchCancelledPayload);
    }
  }
  return { requeued: scheduled, dropped: scheduleDropped };
}

async function ensureClaimFences(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  claim: ClaimedAuctionGroup,
): Promise<boolean> {
  for (const search of claim.searches) {
    const key = sharedPairingUserKey(search.userId);
    const current = await redis.get(key);
    if (current === claim.claimToken) continue;
    if (current !== null) return false;
    const acquired = await redis.set(key, claim.claimToken, {
      NX: true,
      PX: AUCTION_MM_CLAIM_LEASE_MS,
    });
    if (acquired !== 'OK') return false;
  }
  return true;
}

async function readClaim(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  claimToken: string,
): Promise<ClaimedAuctionGroup | null> {
  const row = await redis.hGetAll(claimKey(claimToken));
  if (row.status !== 'claimed' || !row.snapshot) return null;
  try {
    const searches = JSON.parse(row.snapshot) as QueuedAuctionSearch[];
    const claimedAt = Number(row.claimedAt);
    const leaseUntil = Number(row.leaseUntil);
    if (!Array.isArray(searches) || searches.length < 1 || searches.length > 3) return null;
    if (!Number.isFinite(claimedAt) || !Number.isFinite(leaseUntil)) return null;
    return {
      claimToken,
      matchId: row.matchId || claimToken,
      claimedAt,
      leaseUntil,
      searches,
    };
  } catch {
    return null;
  }
}

function claimHashFields(
  claim: ClaimedAuctionGroup,
  status: string,
): Record<string, string> {
  return {
    claimToken: claim.claimToken,
    matchId: claim.matchId,
    status,
    claimedAt: String(claim.claimedAt),
    leaseUntil: String(claim.leaseUntil),
    snapshot: JSON.stringify(claim.searches),
  };
}

function claimKey(claimToken: string): string {
  return `${AUCTION_MM_CLAIM_KEY_PREFIX}${claimToken}`;
}

function sharedPairingUserKey(userId: string): string {
  return `${SHARED_PAIRING_USER_KEY_PREFIX}${userId}`;
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
    .hSet(searchKey(search.searchId), searchHashFields(search, 'queued'))
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
    humanWaitExtended: row.humanWaitExtended === '1',
  };
}

function searchHashFields(
  search: QueuedAuctionSearch,
  status: 'queued' | 'claimed' | 'cancelled' | 'failed',
): Record<string, string> {
  return {
    searchId: search.searchId,
    userId: search.userId,
    displayName: search.displayName,
    avatarCustomization: search.avatarCustomization
      ? JSON.stringify(search.avatarCustomization)
      : '',
    locale: search.locale,
    formation: search.formation ?? '',
    status,
    queuedAt: String(search.queuedAt),
    fallbackAt: String(search.fallbackAt),
    startFailures: String(search.startFailures ?? 0),
    humanWaitExtended: search.humanWaitExtended ? '1' : '0',
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
  const queued = searches
    .filter((search): search is QueuedAuctionSearch => search !== null)
    .sort((a, b) => a.queuedAt - b.queuedAt);
  setAuctionMatchmakingQueueDepth(queued.length);
  return queued;
}

async function removeQueuedSearchForUser(
  redis: NonNullable<ReturnType<typeof getRedisClient>>,
  userId: string
): Promise<QueuedAuctionSearch | null> {
  const searchId = await redis.hGet(AUCTION_MM_USER_MAP_KEY, userId);
  if (!searchId) return null;
  const search = await readSearch(redis, searchId);
  await cancelAuctionMatchmakingFill(searchId).catch((error) => {
    logger.warn(
      { error, searchId, userId },
      'Auction fill timer cancellation failed during queue removal',
    );
  });
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
