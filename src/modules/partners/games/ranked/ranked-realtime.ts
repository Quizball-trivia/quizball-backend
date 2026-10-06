/** Freecroco ranked on the socket layer: the partner handshake, the exact events a partner socket may send, session
 *  re-checks, the block hook (contract §5.5: a blocked player has left their match) and the play reconciler. */

import type { Event as SocketEvent } from 'socket.io';
import { sql } from '../../../../db/index.js';
import { logger } from '../../../../core/logger.js';
import { usersRepo } from '../../../users/users.repo.js';
import type { User as DbUser } from '../../../../db/types.js';
import { matchesRepo } from '../../../matches/matches.repo.js';
import { acquireLock, extendLock, releaseLock } from '../../../../realtime/locks.js';
import { getRedisClient } from '../../../../realtime/redis.js';
import {
  RANKED_MM_USER_MAP_KEY,
  rankedPairingInFlightKey,
  rankedSearchKey,
} from '../../../../realtime/ranked-matchmaking-keys.js';
import { rankedAiMatchKey } from '../../../../realtime/ai-ranked.constants.js';
import {
  matchDisconnectKey,
  matchExitPendingKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchReconnectFenceKey,
} from '../../../../realtime/match-keys.js';
import { cancelMatchQuestionTimer } from '../../../../realtime/match-flow.js';
import { cancelPossessionHalftimeTimer } from '../../../../realtime/possession-match-flow.js';
import type { QuizballServer, QuizballSocket } from '../../../../realtime/socket-server.js';
import { userSessionGuardService } from '../../../../realtime/services/user-session-guard.service.js';
import { getParticipantSnapshot } from '../../../../realtime/services/match-participants.helpers.js';
import { resolveMatchPresence } from '../../../../realtime/services/match-presence.service.js';
import { abandonPossessionTerminalMatch } from '../../../../realtime/services/match-disconnect.service.js';
import { completePossessionMatchFromProgress } from '../../../../realtime/possession-completion.js';
import {
  buildOpponentForfeitPendingPayload,
  finalizeMatchAsForfeit,
} from '../../../../realtime/services/match-forfeit.service.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from '../../../../realtime/services/match-final-results.service.js';
import { onPartnerPlayerBlocked } from '../../partner-events.js';
import { PartnerError } from '../../partner-errors.js';
import { resolvePartnerPrincipal, type PartnerPrincipal } from '../../partner-player-auth.js';
import {
  getOpenPartnerRankedEntryForPlay,
  listPartnerRankedReconcileWork,
  partnerRankedSearchAge,
  reconcilePartnerRankedMatch,
  releasePartnerRankedSearch,
} from './ranked-entries.js';

/** The handshake for a partner access token: the partner principal and the users row the game modules key on. */
export async function authenticatePartnerSocket(token: string): Promise<{ partner: PartnerPrincipal; user: DbUser }> {
  const partner = await resolvePartnerPrincipal(token);
  const user = await usersRepo.getById(partner.userId);
  if (!user || user.partner_slug !== partner.slug) throw new PartnerError('session_ended', undefined, undefined, 'expired');
  return { partner, user };
}

/**
 * Everything a partner socket may send: the ranked queue, the draft, the possession match and connection controls.
 * Rematch (`match:play_again`) is excluded: every play starts with a queue join that reserves it.
 */
export const PARTNER_SOCKET_EVENTS: ReadonlySet<string> = new Set([
  'ranked:queue_join',
  'ranked:queue_leave',
  'draft:rejoin',
  'draft:ban',
  'draft:ui_ready',
  'match:answer',
  'match:clues_answer',
  'match:countdown_guess',
  'match:put_in_order_answer',
  'match:final_results_ack',
  'match:forfeit',
  'match:leave',
  'match:halftime_ban',
  'match:halftime_ui_ready',
  'match:kickoff_ui_ready',
  'match:resume_ui_ready',
  'match:presence_heartbeat',
  'match:stage_ready',
  'match:question_revealed',
  'match:ready_for_next_question',
  'match:rejoin',
  'match:visibility_signal',
  'connection:ping',
  'connection:rtt',
]);

/** Steps that start or end a search or a play re-check the session every time; gameplay events at most every few
 *  seconds. */
const ALWAYS_RECHECK: ReadonlySet<string> = new Set([
  'ranked:queue_join',
  'ranked:queue_leave',
  'draft:ban',
  'draft:rejoin',
  'match:rejoin',
  'match:forfeit',
  'match:leave',
]);
const RECHECK_EVERY_MS = 5_000;

/** Why the partner session behind a socket is over, or null while it is live. */
export async function partnerSessionEndReason(partner: PartnerPrincipal): Promise<'blocked' | 'replaced' | 'expired' | null> {
  const [row] = await sql<{ state: string; end_reason: string | null; over: boolean; status: string }[]>`
    SELECT s.state, s.end_reason, s.session_expires_at <= clock_timestamp() AS over, p.status
    FROM partner_sessions s JOIN partner_players p ON p.id = s.player_id
    WHERE s.id = ${partner.sessionId} AND s.player_id = ${partner.playerId}`;
  if (!row) return 'expired';
  if (row.status !== 'active') return 'blocked';
  if (row.state !== 'redeemed') return row.end_reason === 'replaced' || row.end_reason === 'blocked' ? row.end_reason : 'expired';
  return row.over ? 'expired' : null;
}

/** Tells the page why and closes the socket (the page then shows the partner's "open again" screen). */
export function endPartnerSocket(socket: QuizballSocket, reason: string): void {
  socket.emit('partner:session_ended', { reason });
  socket.disconnect(true);
}

/**
 * Installs the allowlist and session re-checks on a partner socket (before any handler runs). No packet is handled
 * before `admission` has admitted the socket, and none at all once it has refused it.
 */
export function installPartnerSocketGuard(socket: QuizballSocket, admission: Promise<boolean>): void {
  const partner = socket.data.partner;
  if (!partner) return;
  let checkedAt = Date.now();
  // A refused packet raises 'error' on the server socket; without a listener Node would treat it as uncaught.
  socket.on('error', (error) => {
    logger.debug({ userId: partner.userId, message: error?.message }, 'Partner socket packet refused');
  });
  socket.use((packet: SocketEvent, next) => {
    const [event] = packet;
    if (typeof event !== 'string' || !PARTNER_SOCKET_EVENTS.has(event)) {
      next(new Error('PARTNER_EVENT_NOT_ALLOWED'));
      return;
    }
    admission
      .then(async (admitted): Promise<Error | undefined> => {
        if (!admitted) return new Error('PARTNER_NOT_ADMITTED');
        if (!ALWAYS_RECHECK.has(event) && Date.now() - checkedAt < RECHECK_EVERY_MS) return undefined;
        const reason = await partnerSessionEndReason(partner);
        if (reason) {
          endPartnerSocket(socket, reason);
          return new Error('PARTNER_SESSION_ENDED');
        }
        checkedAt = Date.now();
        return undefined;
      })
      .catch((error) => {
        logger.warn({ err: error, userId: partner.userId }, 'Partner socket session check failed');
        return new Error('PARTNER_SESSION_CHECK_FAILED');
      })
      .then((refused) => next(refused));
  });
}

/**
 * The partner side of a connection, started once the socket is in its user room: admission runs at once and the guard
 * holds every packet until it is decided. Resolves whether the socket was admitted; a refused socket has handled
 * nothing, so the caller hydrates it and runs its disconnect cleanup only once admitted.
 */
export function connectPartnerSocket(io: QuizballServer, socket: QuizballSocket): Promise<boolean> {
  const admission = admitPartnerSocket(io, socket).catch((error) => {
    logger.warn({ err: error, userId: socket.data.partner?.userId }, 'Partner socket admission check failed');
    socket.disconnect(true);
    return false;
  });
  installPartnerSocketGuard(socket, admission);
  return admission;
}

/** False for a partner socket that was never admitted (its disconnect must not touch the player's search or match). */
export function partnerSocketAdmitted(data: { partner?: PartnerPrincipal; partnerAdmitted?: boolean }): boolean {
  return !data.partner || data.partnerAdmitted === true;
}

/**
 * One live partner session per player (contract §5.3), decided by each session's state and never by connection order:
 * a handshake that passed authentication and arrived after a newer launch redeemed is refused, and a socket whose
 * session is still live is never closed. Returns whether the connecting socket was admitted.
 */
export async function admitPartnerSocket(io: QuizballServer, socket: QuizballSocket): Promise<boolean> {
  const partner = socket.data.partner;
  if (!partner) return true;
  const ended = await partnerSessionEndReason(partner);
  if (ended) {
    endPartnerSocket(socket, ended);
    return false;
  }
  const sockets = await io.in(`user:${partner.userId}`).fetchSockets();
  const reasons = new Map<string, Promise<Awaited<ReturnType<typeof partnerSessionEndReason>>>>();
  for (const other of sockets) {
    const otherPartner = (other.data as { partner?: PartnerPrincipal } | undefined)?.partner;
    if (other.id === socket.id || !otherPartner || otherPartner.sessionId === partner.sessionId) continue;
    let reason = reasons.get(otherPartner.sessionId);
    if (!reason) {
      reason = partnerSessionEndReason(otherPartner);
      reasons.set(otherPartner.sessionId, reason);
    }
    const otherEnded = await reason;
    if (!otherEnded) continue;
    other.emit('partner:session_ended', { reason: otherEnded });
    other.disconnect(true);
  }
  socket.data.partnerAdmitted = true;
  return true;
}

/** What one block ended: the event's own ids, so a block handled late never touches a session or play begun after it. */
export interface PartnerBlockScope {
  userId: string;
  revokedSessionIds: readonly string[];
  cancelledPlayIds: readonly string[];
}

/**
 * A blocked player has left (contract §5.5 + §7.1): the revoked sessions' sockets close, a running match of a
 * cancelled play ends as their leave (early → cancelled; later → the opponent wins), and its search ends. The block
 * already cancelled the play, so no event is sent for them and their play stays used.
 */
async function handlePartnerBlock(io: QuizballServer, scope: PartnerBlockScope): Promise<void> {
  const revoked = new Set(scope.revokedSessionIds);
  if (revoked.size > 0) {
    const sockets = await io.in(`user:${scope.userId}`).fetchSockets();
    for (const socket of sockets) {
      const sessionId = (socket.data as { partner?: PartnerPrincipal } | undefined)?.partner?.sessionId;
      if (!sessionId || !revoked.has(sessionId)) continue;
      socket.emit('partner:session_ended', { reason: 'blocked' });
      socket.disconnect(true);
    }
  }
  for (const playId of scope.cancelledPlayIds) {
    await endBlockedRankedPlay(io, scope.userId, playId);
  }
}

async function endBlockedRankedPlay(io: QuizballServer, userId: string, playId: string): Promise<void> {
  const entry = await getOpenPartnerRankedEntryForPlay(playId);
  if (!entry || entry.userId !== userId) return;
  if (entry.state === 'searching') {
    await userSessionGuardService.withUserSessionLock(userId, async () => {
      // The queue artifacts are keyed by user: once a newer search has replaced this play's entry they are its own.
      if ((await getOpenPartnerRankedEntryForPlay(playId))?.state !== 'searching') return;
      await userSessionGuardService.cleanupRankedQueueArtifacts(io, userId);
    });
    await releasePartnerRankedSearch(userId, 'blocked', playId);
    return;
  }
  if (!entry.matchId) return;
  const match = await matchesRepo.getMatch(entry.matchId);
  if (!match || match.status !== 'active') return;
  // Rechecked right before ending it: only a match this play still holds open is ended.
  const current = await getOpenPartnerRankedEntryForPlay(playId);
  if (current?.state !== 'playing' || current.matchId !== match.id) return;
  const { participants: roster, cache } = await getParticipantSnapshot(match.id);
  cancelMatchQuestionTimer(match.id, match.current_q_index);
  cancelPossessionHalftimeTimer(match.id);
  // An opponent already gone (disconnected in grace, or left during this player's grace) means both dropped out
  // (contract §7.1: decided by the score); the blocked player still gets no event (the block cancelled the play).
  const presence = await resolveMatchPresence(io, match.id, roster, {
    includeUserRoomSockets: true,
    disconnectedUserIds: [userId],
  });
  const opponentDropped = roster.some((player) => player.user_id !== userId
    && (presence.absentPlayers.some((absent) => absent.user_id === player.user_id)
      || presence.exitPendingUserIds.includes(player.user_id)));
  if (opponentDropped) {
    const source = 'partner_block_opponent_dropped';
    const bothDropped = await completePossessionMatchFromProgress(io, match.id, source, { kind: 'both_dropped' });
    if (!bothDropped.completed && bothDropped.reason === 'undecidable') {
      await abandonPossessionTerminalMatch(io, match, roster, source);
    } else if (!bothDropped.completed) {
      logger.warn({ matchId: match.id, userId, reason: bothDropped.reason }, 'Blocked partner player: both-dropped end not finalized here');
    }
    return;
  }
  const opponentPending = buildOpponentForfeitPendingPayload(match.id, 'opponent_forfeit');
  for (const player of roster) {
    if (player.user_id !== userId) io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPending);
  }
  const cleanupKeys = [
    matchPauseKey(match.id),
    matchGraceKey(match.id),
    ...roster.flatMap((player) => [
      matchDisconnectKey(match.id, player.user_id),
      matchExitPendingKey(match.id, player.user_id),
      matchPresenceKey(match.id, player.user_id),
      matchReconnectCountKey(match.id, player.user_id),
      matchReconnectFenceKey(match.id, player.user_id),
    ]),
    rankedAiMatchKey(match.id),
  ];
  const finalized = await finalizeMatchAsForfeit({
    matchId: match.id,
    forfeitingUserId: userId,
    activeMatch: match,
    cacheSnapshot: cache,
    cleanupRedisKeys: cleanupKeys,
  });
  if (finalized.completed) {
    const payload = await buildFinalResultsPayload(match.id, finalized.resultVersion);
    if (payload) await emitFinalResultsToMatchParticipants(io, match.id, payload);
  } else {
    // The match is finishing on another path (or its lock is busy); the reconciler settles whatever is left.
    logger.warn({ matchId: match.id, userId }, 'Blocked partner player: match forfeit not finalized here');
  }
}

export function registerPartnerRankedBlockHandler(io: QuizballServer): () => void {
  return onPartnerPlayerBlocked(async (event) => {
    if (!event.userId) return;
    await handlePartnerBlock(io, {
      userId: event.userId,
      revokedSessionIds: event.revokedSessionIds,
      cancelledPlayIds: event.cancelledPlayIds,
    });
  });
}

const RECONCILE_EVERY_MS = 15_000;
const IDLE_SEARCH_SECONDS = 30;
/** No search, pairing or draft lasts this long: a play still unmatched by then is stuck (its lobby is torn down). */
const STUCK_SEARCH_SECONDS = 600;
const RECONCILE_LOCK = 'partner:ranked:reconcile';
const RECONCILE_LOCK_TTL_MS = 15_000;
/** A tick stops claiming work after this long; the rest waits for the next tick. */
const RECONCILE_BUDGET_MS = 10_000;

/** Whether a player has nothing ranked going on: no search, lobby, match or pairing in flight. */
async function isRankedIdle(userId: string): Promise<boolean> {
  const snapshot = await userSessionGuardService.resolveState(userId);
  if (snapshot.state !== 'IDLE') return false;
  const redis = getRedisClient();
  if (redis?.isOpen && (await redis.exists(rankedPairingInFlightKey(userId))) === 1) return false;
  return true;
}

/**
 * Ends one play's stale search, judged on that play's entry as it is now (the scan may be stale: the search may have
 * been seen alive, or ended and been replaced by a fresh one). Runs under the user's session lock, which queue joins
 * hold while they reserve and enqueue.
 */
async function endStaleSearch(io: QuizballServer, userId: string, playId: string): Promise<boolean> {
  const age = await partnerRankedSearchAge(playId);
  if (age === null || age < IDLE_SEARCH_SECONDS) return false;
  const idle = await isRankedIdle(userId);
  // Read after the idle check, so a search enqueued in between is seen: a live search is never swept as idle.
  if (!await queuedSearchIsStuck(userId, playId)) return false;
  if (idle) return releasePartnerRankedSearch(userId, 'reconciler_idle_search', playId);
  if (age < STUCK_SEARCH_SECONDS) return false;
  if ((await userSessionGuardService.resolveState(userId)).activeMatchId) return false;
  await userSessionGuardService.cleanupRankedQueueArtifacts(io, userId);
  return await isRankedIdle(userId) && releasePartnerRankedSearch(userId, 'reconciler_stuck_search', playId);
}

/** Whether the player's queued Redis search, if any, is this play's and itself as old as a stuck one (a retry enqueues
 *  a fresh search on the same play). */
async function queuedSearchIsStuck(userId: string, playId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return true;
  const searchId = await redis.hGet(RANKED_MM_USER_MAP_KEY, userId);
  if (!searchId) return true;
  const search = await redis.hGetAll(rankedSearchKey(searchId));
  if (Object.keys(search).length === 0) return true;
  const queuedAt = Number(search.queuedAt);
  return search.playId === playId && Number.isFinite(queuedAt) && Date.now() - queuedAt >= STUCK_SEARCH_SECONDS * 1000;
}

/**
 * Every started play ends exactly once: matches that ended without their partner settlement (a crash between the
 * match result and the settlement, or an end on a path that bypassed it) are settled, and plays whose search died
 * without a match are returned. `keepGoing` is asked before each item; once it says no, nothing more is claimed.
 */
export async function reconcilePartnerRanked(
  io: QuizballServer,
  keepGoing: () => boolean = () => true,
): Promise<{ matches: number; searches: number }> {
  if (!keepGoing()) return { matches: 0, searches: 0 };
  const work = await listPartnerRankedReconcileWork(IDLE_SEARCH_SECONDS);
  let matches = 0;
  let searches = 0;
  for (const { userId, playId } of work.blockedInActiveMatch) {
    if (!keepGoing()) return stopped(matches, searches);
    try {
      // The block's sessions were closed with it (or end at their next re-check); only its match is left to end.
      await handlePartnerBlock(io, { userId, revokedSessionIds: [], cancelledPlayIds: [playId] });
      matches += 1;
    } catch (error) {
      logger.error({ err: error, userId, playId }, 'Partner ranked block reconcile failed');
    }
  }
  for (const matchId of work.endedMatchIds) {
    if (!keepGoing()) return stopped(matches, searches);
    try {
      if (await reconcilePartnerRankedMatch(matchId)) matches += 1;
    } catch (error) {
      logger.error({ err: error, matchId }, 'Partner ranked match reconcile failed');
    }
  }
  if (work.staleSearches.length > 0 && !keepGoing()) return stopped(matches, searches);
  // One batched read rules out players still busy (they stay stale across ticks while a draft or lobby runs); every
  // player this pass may change is re-checked on its own first, as before.
  const seen = work.staleSearches.length > 0
    ? await userSessionGuardService.resolveStates(work.staleSearches.map((s) => s.userId))
    : new Map<string, Awaited<ReturnType<typeof userSessionGuardService.resolveState>>>();
  for (const { userId, playId, staleSeconds } of work.staleSearches) {
    if (!keepGoing()) return stopped(matches, searches);
    try {
      const batched = seen.get(userId);
      if (batched?.state !== 'IDLE' && (staleSeconds < STUCK_SEARCH_SECONDS || batched?.activeMatchId)) continue;
      const ended = await userSessionGuardService.withUserSessionLock(userId, () => endStaleSearch(io, userId, playId));
      if (ended) searches += 1;
    } catch (error) {
      logger.error({ err: error, userId, playId }, 'Partner ranked search reconcile failed');
    }
  }
  if (matches || searches) logger.info({ matches, searches }, 'Partner ranked reconciler settled plays');
  return { matches, searches };
}

function stopped(matches: number, searches: number): { matches: number; searches: number } {
  logger.warn({ matches, searches }, 'Partner ranked reconciler stopped early (lock lost, budget spent or shutting down)');
  return { matches, searches };
}

/**
 * Renews the reconcile lock (token-checked) while a tick runs. `held()` turns false for good once a renewal fails or
 * the last confirmed expiry is close, so a tick never keeps working after another replica could have taken over.
 */
function holdReconcileLease(token: string): { held: () => boolean; stop: () => void } {
  let lost = false;
  let validUntil = Date.now() + RECONCILE_LOCK_TTL_MS;
  const renew = setInterval(() => {
    const askedAt = Date.now();
    void extendLock(RECONCILE_LOCK, token, RECONCILE_LOCK_TTL_MS).then((ok) => {
      if (ok) validUntil = askedAt + RECONCILE_LOCK_TTL_MS;
      else lost = true;
    });
  }, RECONCILE_LOCK_TTL_MS / 3);
  renew.unref?.();
  return {
    held: () => !lost && Date.now() < validUntil - RECONCILE_LOCK_TTL_MS / 3,
    stop: () => clearInterval(renew),
  };
}

let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileTick: Promise<void> | null = null;
let reconcileGeneration = 0;

export function startPartnerRankedReconciler(io: QuizballServer): void {
  if (reconcileTimer) return;
  const generation = ++reconcileGeneration;
  reconcileTimer = setInterval(() => {
    if (reconcileTick) return;
    reconcileTick = (async () => {
      const lock = await acquireLock(RECONCILE_LOCK, RECONCILE_LOCK_TTL_MS);
      if (!lock.acquired || !lock.token) return;
      const lease = holdReconcileLease(lock.token);
      const budgetEnds = Date.now() + RECONCILE_BUDGET_MS;
      try {
        // A stop (shutdown) also ends the tick: start no new work on a server that is going away.
        await reconcilePartnerRanked(
          io,
          () => lease.held() && generation === reconcileGeneration && Date.now() < budgetEnds,
        );
      } finally {
        lease.stop();
        await releaseLock(RECONCILE_LOCK, lock.token);
      }
    })()
      .catch((error) => logger.error({ err: error }, 'Partner ranked reconciler tick failed'))
      .finally(() => {
        reconcileTick = null;
      });
  }, RECONCILE_EVERY_MS);
  reconcileTimer.unref?.();
}

/** Stops the timer and resolves once a tick already running has finished (shutdown awaits it before the DB closes). */
export function stopPartnerRankedReconciler(): Promise<void> {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  reconcileGeneration += 1;
  return reconcileTick ?? Promise.resolve();
}
