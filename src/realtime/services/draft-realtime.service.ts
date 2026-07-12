import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { getRandom } from '../../core/rng.js';
import { harnessDelayMs, isHarnessFastTimers } from '../../core/harness-timing.js';
import { AppError, ErrorCode } from '../../core/errors.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { storeService } from '../../modules/store/store.service.js';
import {
  RANKED_RECENT_CATEGORY_MODE,
  userRecentCategoriesRepo,
} from '../../modules/user-recent-categories/user-recent-categories.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import { logger } from '../../core/logger.js';
import { startDraft } from './lobby-realtime.service.js';
import {
  trackDraftCompleted,
  trackDraftUiReady,
  trackRankedDraftAborted,
} from '../../core/analytics/game-events.js';
import { abortRankedDraftStartForTickets } from './lobby-draft-start.service.js';
import { rankedAiLobbyKey, rankedAiMatchKey } from '../ai-ranked.constants.js';
import { rankedCancelKey } from '../ranked-matchmaking-keys.js';
import {
  matchDisconnectKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../locks.js';
import { cancelRealtimeTimer, hasPendingRealtimeTimer, scheduleRealtimeTimer } from '../realtime-timer-scheduler.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import { finalizeMatchAsForfeit } from './match-forfeit.service.js';
import {
  detachAllSocketsFromLobby,
  emitClosedLobbyStateForMode,
} from './lobby-lifecycle.helpers.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import {
  advanceDraftTurnState,
  readDraftTurnState,
  resetDraftTurnStateForTests,
} from '../draft-turn-state.js';

const AI_BAN_DELAY_MIN_MS = 700;
const AI_BAN_DELAY_MAX_MS = 1800;
const DRAFT_AUTO_BAN_MS = 16000;
const DRAFT_UI_READY_TTL_SEC = 600;
// If a client never sends draft:ui_ready (old client, lost socket, browser
// killed mid-transition), keep the draft recoverable instead of wedging.
export const DRAFT_UI_READY_FORCE_MS = 10000;
const AI_LOBBY_KEY_TTL_SEC = 7200;
const DRAFT_DISCONNECT_GRACE_MS = 30000;
// Disconnect/pause state TTL. Gates the grace-recovery "who is disconnected"
// check, so it must persist until the durable grace timer actually runs — which
// can be delayed by a redeploy / scheduler lag. Sized to match the grace marker.
const DRAFT_DISCONNECT_TTL_SEC = 600;
// Pending-recovery marker TTL. Must comfortably outlive the grace window (60s)
// PLUS any realistic delayed delivery of the durable timer (redeploy / scheduler
// lag), so a late firing still finds the marker and recovers instead of no-opping.
const DRAFT_GRACE_TTL_SEC = 600;
// Short-lived mutual-exclusion lock between duplicate/concurrent grace firings.
// Auto-expires so a crashed handler can't wedge recovery; long enough to cover a
// single recovery pass.
const DRAFT_GRACE_LOCK_TTL_SEC = 30;
// How long after a disconnect to re-check whether the player still has a live
// socket in the lobby room. Must exceed the socket.io ping timeout so a zombie
// socket has provably died by the time the re-check runs — anything still
// connected then is a real presence (the disconnect was a ghost socket).
const DRAFT_PRESENCE_RECHECK_MS = 12_000;
const draftPresenceRecheckTimers = new Map<string, NodeJS.Timeout>();

function scheduleDraftPresenceRecheck(
  lobbyId: string,
  userId: string,
  delayMs: number,
  recheckPresence: () => Promise<void>
): void {
  const timerKey = `${lobbyId}:${userId}`;
  const existing = draftPresenceRecheckTimers.get(timerKey);
  if (existing) clearTimeout(existing);

  const recheck = setTimeout(() => {
    if (draftPresenceRecheckTimers.get(timerKey) !== recheck) return;
    draftPresenceRecheckTimers.delete(timerKey);
    void recheckPresence().catch((error) => {
      logger.warn({ error, lobbyId, userId }, 'Draft presence re-check failed');
    });
  }, harnessDelayMs(delayMs));
  recheck.unref?.();
  draftPresenceRecheckTimers.set(timerKey, recheck);
}

export function resetDraftRuntimeState(): void {
  for (const timer of draftPresenceRecheckTimers.values()) {
    clearTimeout(timer);
  }
  draftPresenceRecheckTimers.clear();
  resetDraftTurnStateForTests();
}

// Mutual-exclusion lock around draft completion → match creation. Completion is
// reachable from several concurrent paths (human ban handler, scheduled AI ban,
// auto-ban watchdog, reconnect/resume) and possibly from two instances during a
// deploy overlap. Without the lock, concurrent startMatchFromDraft calls race
// each other's ranked-ticket CAS consume (3 attempts, ~1ms backoff) until it
// throws 409 CONFLICT and the match is never created. Heartbeat-extended so a
// slow match creation can't outlive the TTL and let a duplicate in.
const DRAFT_COMPLETE_LOCK_TTL_MS = 30_000;

interface DraftDisconnectPresenceOptions {
  ignoreSocketId?: string;
  disconnectedConnectedAt?: number;
  knownDisconnected?: boolean;
}

function draftDisconnectKey(lobbyId: string, userId: string): string {
  return `draft:disconnect:${lobbyId}:${userId}`;
}

function draftPauseKey(lobbyId: string): string {
  return `draft:pause:${lobbyId}`;
}

function draftGraceKey(lobbyId: string): string {
  return `draft:grace:${lobbyId}`;
}

function draftGraceLockKey(lobbyId: string): string {
  return `draft:grace:lock:${lobbyId}`;
}

function draftCompleteLockKey(lobbyId: string): string {
  return `draft:complete:lock:${lobbyId}`;
}

function draftAbsentAfterGraceKey(lobbyId: string, userId: string): string {
  return `draft:absent_after_grace:${lobbyId}:${userId}`;
}

function draftUiReadyKey(lobbyId: string, userId: string, banCount: number): string {
  return `draft:ui_ready:${lobbyId}:${userId}:${banCount}`;
}

function draftUiReadyDeadlineKey(lobbyId: string, banCount: number): string {
  return `draft:ui_ready_deadline:${lobbyId}:${banCount}`;
}

export async function markDraftPlayerDisconnected(lobbyId: string, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.set(draftDisconnectKey(lobbyId, userId), String(Date.now()), { EX: DRAFT_DISCONNECT_TTL_SEC });
}

export async function isDraftPlayerMarkedDisconnected(lobbyId: string, userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return false;
  return (await redis.exists(draftDisconnectKey(lobbyId, userId))) === 1;
}

export async function pauseDraftForDisconnectedPlayerAtStart(
  io: QuizballServer,
  lobbyId: string,
  userId: string
): Promise<void> {
  await draftRealtimeService.pauseDraftForDisconnectedPlayer(io, lobbyId, userId, { knownDisconnected: true });
}

async function markDraftUiReady(lobbyId: string, userId: string, banCount: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.set(draftUiReadyKey(lobbyId, userId, banCount), String(Date.now()), { EX: DRAFT_UI_READY_TTL_SEC });
}

async function isDraftUserUiReady(lobbyId: string, userId: string, banCount: number): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return true;
  return (await redis.exists(draftUiReadyKey(lobbyId, userId, banCount))) === 1;
}

async function getDraftReadyState(
  lobbyId: string,
  humanUserIds: string[],
  banCount: number
): Promise<{ readyUserIds: string[]; waitingUserIds: string[] }> {
  const ready = await Promise.all(
    humanUserIds.map((userId) => isDraftUserUiReady(lobbyId, userId, banCount))
  );
  return {
    readyUserIds: humanUserIds.filter((_, index) => ready[index]),
    waitingUserIds: humanUserIds.filter((_, index) => !ready[index]),
  };
}

async function getOrCreateDraftUiReadyDeadline(lobbyId: string, banCount: number): Promise<number> {
  const redis = getRedisClient();
  const key = draftUiReadyDeadlineKey(lobbyId, banCount);
  const candidate = Date.now() + harnessDelayMs(DRAFT_UI_READY_FORCE_MS);
  if (redis?.isOpen) {
    // SET NX GET makes deadline creation atomic across replicas: the first
    // writer wins and every concurrent caller reads the same value.
    const prior = await redis.set(key, String(candidate), { NX: true, GET: true, EX: DRAFT_UI_READY_TTL_SEC });
    const existing = Number(prior);
    if (prior !== null && Number.isFinite(existing) && existing > Date.now()) return existing;
  }
  return candidate;
}

async function getRankedDraftAbortSignals(
  lobbyId: string,
  humanUserIds: string[]
): Promise<Array<{ userId: string; cancelled: boolean; absentAfterGrace: boolean }>> {
  const redis = getRedisClient();
  if (!redis?.isOpen || humanUserIds.length === 0) return [];

  return Promise.all(
    humanUserIds.map(async (userId) => {
      const [cancelled, absentAfterGrace] = await Promise.all([
        redis.get(rankedCancelKey(userId)),
        redis.exists(draftAbsentAfterGraceKey(lobbyId, userId)),
      ]);
      return {
        userId,
        cancelled: Boolean(cancelled),
        absentAfterGrace: absentAfterGrace === 1,
      };
    })
  );
}

const TICKET_REFUND_MAX_ATTEMPTS = 3;
const TICKET_REFUND_RETRY_BASE_DELAY_MS = 500;

async function refundRankedTicketsWithRetry(
  ticketUserIds: string[],
  context: { lobbyId: string; matchId?: string; reason: string }
): Promise<boolean> {
  for (let attempt = 1; attempt <= TICKET_REFUND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const refund = await storeService.refundRankedTickets(ticketUserIds);
      logger.info(
        { ...context, ticketUserIds, attempt, wallets: refund.wallets },
        'Refunded ranked tickets'
      );
      return true;
    } catch (refundError) {
      const isLastAttempt = attempt === TICKET_REFUND_MAX_ATTEMPTS;
      const errorFields = {
        ...context,
        ticketUserIds,
        attempt,
        maxAttempts: TICKET_REFUND_MAX_ATTEMPTS,
        error: refundError instanceof Error ? refundError.message : refundError,
      };
      if (isLastAttempt) {
        logger.error(
          { ...errorFields, eventName: 'ranked_ticket_refund_failed' },
          'Ranked ticket refund failed after retries — needs manual reconciliation'
        );
        return false;
      }
      logger.warn(errorFields, 'Ranked ticket refund attempt failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, TICKET_REFUND_RETRY_BASE_DELAY_MS * attempt));
    }
  }
  return false;
}

async function abortRankedDraftBeforeMatchCreation(
  io: QuizballServer,
  lobby: { id: string; mode: 'friendly' | 'ranked' },
  humanUserIds: string[],
  reason: string,
  signals: Array<{ userId: string; cancelled: boolean; absentAfterGrace: boolean }>,
  details: {
    expectedUserId?: string | null;
    aiUserId?: string | null;
    banCount?: number | null;
    forceAtMs?: number | null;
  } = {}
): Promise<void> {
  await lobbiesRepo.deleteLobby(lobby.id);
  const redis = getRedisClient();
  if (redis?.isOpen) {
    await redis.del([
      rankedAiLobbyKey(lobby.id),
      ...humanUserIds.map((userId) => draftAbsentAfterGraceKey(lobby.id, userId)),
    ]);
  }
  await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);
  await detachAllSocketsFromLobby(io, lobby.id);
  for (const userId of humanUserIds) {
    const signal = signals.find((candidate) => candidate.userId === userId);
    trackRankedDraftAborted({
      userId,
      lobbyId: lobby.id,
      reason,
      cancelled: signal?.cancelled ?? false,
      absentAfterGrace: signal?.absentAfterGrace ?? false,
      expectedUserId: details.expectedUserId ?? null,
      aiUserId: details.aiUserId ?? null,
      banCount: details.banCount ?? null,
      forceAtMs: details.forceAtMs ?? null,
    });
    io.to(`user:${userId}`).emit('ranked:queue_left');
    await userSessionGuardService.emitState(io, userId).catch((error) => {
      logger.warn({ error, userId, lobbyId: lobby.id }, 'Failed to emit state after ranked draft abort');
    });
  }
  logger.warn(
    { lobbyId: lobby.id, humanUserIds, reason, signals, ...details },
    'Ranked draft aborted before match creation'
  );
}

async function abortRankedDraftWithoutUiReady(params: {
  io: QuizballServer;
  lobby: { id: string; mode: 'friendly' | 'ranked' };
  members: Array<{ user_id: string }>;
  aiUserId: string | null;
  expectedUserId: string;
  banCount: number;
  forceAtMs: number | null | undefined;
}): Promise<void> {
  const { io, lobby, members, aiUserId, expectedUserId, banCount, forceAtMs } = params;
  const humanUserIds = members
    .filter((member) => member.user_id !== aiUserId)
    .map((member) => member.user_id);

  logger.warn(
    { lobbyId: lobby.id, expectedUserId, banCount, forceAtMs: forceAtMs ?? null, humanUserIds },
    'Aborting ranked draft because human auto-ban reached force deadline without draft ui_ready'
  );

  await abortRankedDraftBeforeMatchCreation(
    io,
    lobby,
    humanUserIds,
    'human_auto_ban_without_ui_ready',
    humanUserIds.map((userId) => ({
      userId,
      cancelled: false,
      absentAfterGrace: false,
    })),
    {
      expectedUserId,
      aiUserId,
      banCount,
      forceAtMs: forceAtMs ?? null,
    }
  );
}

// Inline retry for transient wallet contention during ranked ticket consume.
// The wallet CAS (6 attempts, ≤375ms) can still lose against sustained outside
// writers (wallet refill hydration bursts, reconnect-driven refetch storms,
// long external transactions). Without this, a single CONFLICT throw bubbles
// out of draft completion and the players sit on "preparing match" until the
// auto-ban watchdog retries ~16s later — observed on prod as multi-minute
// retry loops across lobbies. Retrying inline (we hold the per-lobby
// completion lock, heartbeat-extended) converges in seconds instead.
const CONSUME_CONFLICT_MAX_RETRIES = 3;
const CONSUME_CONFLICT_RETRY_BASE_MS = 200;

function isTicketCasConflict(error: unknown): error is AppError {
  return error instanceof AppError && error.code === ErrorCode.CONFLICT;
}

async function consumeRankedTicketsWithConflictRetry(
  lobbyId: string,
  ticketUserIds: string[]
): Promise<Awaited<ReturnType<typeof storeService.consumeRankedTickets>>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storeService.consumeRankedTickets(ticketUserIds);
    } catch (error) {
      if (!isTicketCasConflict(error) || attempt >= CONSUME_CONFLICT_MAX_RETRIES) {
        throw error;
      }
      // Exponential backoff with jitter: ~200/400/800ms (+0–50%) so synchronized
      // completion retries across lobbies/instances don't re-collide in lockstep.
      const delayMs = Math.round(
        CONSUME_CONFLICT_RETRY_BASE_MS * 2 ** attempt * (1 + getRandom() * 0.5)
      );
      logger.warn(
        {
          lobbyId,
          ticketUserIds,
          attempt: attempt + 1,
          maxRetries: CONSUME_CONFLICT_MAX_RETRIES,
          delayMs,
          errorDetails: error.details ?? null,
        },
        'Ranked ticket consume hit wallet contention; retrying inline'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function startMatchFromDraft(
  io: QuizballServer,
  lobbyId: string,
  halfOneCategoryId: string
): Promise<string | null> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return null;

  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length !== 2) return null;

  let consumedRankedTicketUserIds: string[] = [];
  let rankedHumanUserIds: string[] = [];

  if (lobby.mode === 'ranked') {
    const aiUserId = await resolveRankedAiUserId(lobbyId, members);
    const ticketUserIds = members
      .filter((member) => member.user_id !== aiUserId)
      .map((member) => member.user_id);
    rankedHumanUserIds = ticketUserIds;
    const abortSignals = await getRankedDraftAbortSignals(lobbyId, ticketUserIds);
    const blockingSignals = abortSignals.filter((signal) => signal.cancelled || signal.absentAfterGrace);
    if (blockingSignals.length > 0) {
      await abortRankedDraftBeforeMatchCreation(
        io,
        lobby,
        ticketUserIds,
        'cancelled_or_absent_before_ticket_consumption',
        abortSignals
      );
      return null;
    }

    if (ticketUserIds.length > 0) {
      const consumedTickets = await consumeRankedTicketsWithConflictRetry(lobbyId, ticketUserIds);
      if (!consumedTickets) {
        logger.warn(
          { lobbyId, ticketUserIds },
          'Ranked match creation aborted: insufficient tickets'
        );
        await abortRankedDraftStartForTickets(io, lobby, ticketUserIds);
        return null;
      }
      logger.info(
        { lobbyId, ticketUserIds, wallets: consumedTickets.wallets },
        'Ranked match creation consumed tickets'
      );
      consumedRankedTicketUserIds = ticketUserIds;
    }

    const postTicketAbortSignals = await getRankedDraftAbortSignals(lobbyId, ticketUserIds);
    const postTicketBlockingSignals = postTicketAbortSignals.filter((signal) => signal.cancelled || signal.absentAfterGrace);
    if (postTicketBlockingSignals.length > 0) {
      if (consumedRankedTicketUserIds.length > 0) {
        await refundRankedTicketsWithRetry(consumedRankedTicketUserIds, {
          lobbyId,
          reason: 'draft_abort_before_match_creation',
        });
      }
      await abortRankedDraftBeforeMatchCreation(
        io,
        lobby,
        ticketUserIds,
        'cancelled_or_absent_after_ticket_consumption',
        postTicketAbortSignals
      );
      return null;
    }
  }

  io.to(`lobby:${lobbyId}`).emit('draft:complete', { halfOneCategoryId });
  logger.info({ lobbyId, halfOneCategoryId }, 'Draft complete');

  let result;
  try {
    result = await matchesService.createMatchFromLobby({
      lobbyId,
      mode: lobby.mode,
      variant: 'ranked_sim',
      hostUserId: lobby.host_user_id,
      categoryAId: halfOneCategoryId,
      categoryBId: null,
    });
  } catch (error) {
    if (consumedRankedTicketUserIds.length > 0) {
      await refundRankedTicketsWithRetry(consumedRankedTicketUserIds, {
        lobbyId,
        reason: 'match_creation_failure',
      });
    }
    logger.warn(
      { lobbyId, error: error instanceof Error ? error.message : error },
      'Failed to create match from draft; restarting draft'
    );
    await startDraft(io, lobbyId);
    return null;
  }

  const matchId = result.match.id;
  logger.info(
    { lobbyId, matchId, mode: lobby.mode, halfOneCategoryId },
    'Match created from draft'
  );

  // Recently played categories: the drafted survivor is now ACTUALLY used by
  // this match, so record it for the real (non-AI) players — this is what the
  // next draft's recent-category filter reads. Best-effort: never blocks the
  // match start.
  if (lobby.mode === 'ranked' && rankedHumanUserIds.length > 0) {
    void userRecentCategoriesRepo
      .recordPlayedCategoryForUsers({
        userIds: rankedHumanUserIds,
        categoryId: halfOneCategoryId,
        mode: RANKED_RECENT_CATEGORY_MODE,
      })
      .catch((error) => {
        logger.warn(
          { error, lobbyId, matchId, halfOneCategoryId },
          'Failed to record recently played category (draft)'
        );
      });
  }

  // Analytics: per-member draft_completed event. Duration relative to
  // the match created_at timestamp is the closest proxy we have without
  // dedicated draft-start tracking.
  try {
    const matchStartedAt = result.match.started_at ? new Date(result.match.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - matchStartedAt);
    for (const member of members) {
      trackDraftCompleted({ userId: member.user_id, lobbyId, matchId, durationMs });
    }
  } catch (err) {
    logger.warn({ err, lobbyId, matchId }, 'draft_completed analytics failed');
  }

  const redis = getRedisClient();
  if (redis) {
    const absentFlags = await Promise.all(
      members.map((member) => redis.exists(draftAbsentAfterGraceKey(lobbyId, member.user_id)))
    );
    const absentMembers = members.filter((_, index) => absentFlags[index] === 1);
    if (absentMembers.length > 0) {
      // Single-absent non-ranked: forfeit the absent player. If BOTH players
      // are absent there is no legitimate winner — fall through to the abandon
      // path below (shared with ranked) instead of crediting absentMembers[0]'s
      // opponent with a win they weren't present for.
      if (lobby.mode !== 'ranked' && absentMembers.length === 1) {
        const forfeitingMember = absentMembers[0];
        if (!forfeitingMember) return matchId;
        logger.info(
          { lobbyId, matchId, userId: forfeitingMember.user_id, absentUserIds: absentMembers.map((member) => member.user_id) },
          'Finalizing newly-created match as forfeit for player absent after draft grace'
        );
        const finalized = await finalizeMatchAsForfeit({
          matchId,
          forfeitingUserId: forfeitingMember.user_id,
          activeMatch: result.match,
          cleanupRedisKeys: [
            rankedAiMatchKey(matchId),
            matchPauseKey(matchId),
            matchGraceKey(matchId),
            matchResumeCountdownKey(matchId),
            ...members.flatMap((member) => [
              matchDisconnectKey(matchId, member.user_id),
              matchPresenceKey(matchId, member.user_id),
              matchReconnectCountKey(matchId, member.user_id),
            ]),
          ],
        });
        if (finalized.completed) {
          const finalPayload = await buildFinalResultsPayload(matchId, finalized.resultVersion);
          if (finalPayload) {
            await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
          }
        }
        await redis.del(absentMembers.map((member) => draftAbsentAfterGraceKey(lobbyId, member.user_id)));
        return matchId;
      }

      logger.warn(
        { lobbyId, matchId, mode: lobby.mode, absentUserIds: absentMembers.map((member) => member.user_id) },
        'Abandoning newly-created match because player(s) became absent before playable state'
      );
      try {
        await matchesService.abandonMatch(matchId);
      } catch (error) {
        // Do NOT refund or tear down surrounding state while the match row is
        // still active — that would orphan a live match with its artifacts
        // removed (and double-credit tickets if it later completes). Leave
        // everything in place for the stale-match sweeper / terminal resolver.
        logger.error(
          { error, lobbyId, matchId },
          'Failed to abandon newly-created pre-match ranked match; skipping refund and cleanup'
        );
        return matchId;
      }
      if (consumedRankedTicketUserIds.length > 0) {
        await refundRankedTicketsWithRetry(consumedRankedTicketUserIds, {
          lobbyId,
          matchId,
          reason: 'pre_match_ranked_abandon',
        });
      }
      await redis.del([
        rankedAiMatchKey(matchId),
        rankedAiLobbyKey(lobbyId),
        ...absentMembers.map((member) => draftAbsentAfterGraceKey(lobbyId, member.user_id)),
      ]);
      return matchId;
    }
  }

  await beginMatchForLobby(io, lobbyId, matchId);

  return matchId;
}

function getAiBanDelayMs(): number {
  return Math.floor(getRandom() * (AI_BAN_DELAY_MAX_MS - AI_BAN_DELAY_MIN_MS + 1)) + AI_BAN_DELAY_MIN_MS;
}

async function clearPendingAiBanTimer(lobbyId: string): Promise<void> {
  try {
    await cancelRealtimeTimer('draft_ai_ban', lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft AI ban timer');
  }
}

async function clearPendingAutoBanTimer(lobbyId: string): Promise<void> {
  try {
    await cancelRealtimeTimer('draft_auto_ban', lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to cancel draft auto-ban timer');
  }
}

async function clearDraftTimers(lobbyId: string): Promise<void> {
  await Promise.all([
    clearPendingAiBanTimer(lobbyId),
    clearPendingAutoBanTimer(lobbyId),
  ]);
}

async function resolveRankedAiUserId(
  lobbyId: string,
  members: Array<{ user_id: string }>
): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    const aiUserId = await redis.get(rankedAiLobbyKey(lobbyId));
    if (aiUserId && members.some((member) => member.user_id === aiUserId)) {
      return aiUserId;
    }
  }

  const usersById = await usersRepo.getByIds(members.map((member) => member.user_id));
  const users = members.map((member) => ({
    userId: member.user_id,
    user: usersById.get(member.user_id) ?? null,
  }));
  const aiMember = users.find((entry) => entry.user?.is_ai);
  if (!aiMember) return null;

  if (redis) {
    await redis.set(rankedAiLobbyKey(lobbyId), aiMember.userId, { EX: AI_LOBBY_KEY_TTL_SEC });
  }
  return aiMember.userId;
}

async function completeDraftIfReady(io: QuizballServer, lobbyId: string): Promise<string | null> {
  // Cheap pre-check before taking the lock so we don't serialize every ban
  // event on the not-ready path (the common case mid-draft).
  const preLobby = await lobbiesRepo.getById(lobbyId);
  if (!preLobby || preLobby.status !== 'active') {
    await clearDraftTimers(lobbyId);
    return null;
  }
  if ((await lobbiesRepo.listLobbyCategoryBans(lobbyId)).length < 2) return null;

  // Exactly-once guard: several paths (ban handler, AI ban callback, auto-ban
  // watchdog, reconnect resume) can all observe "2 bans, ready to complete" at
  // the same moment. Only one may proceed to startMatchFromDraft — concurrent
  // ticket consumption for the same wallets exhausts the CAS retries (409
  // CONFLICT) and aborts the match. Losers skip: the winner either creates the
  // match (lobby leaves 'active', later attempts no-op) or fails through
  // startMatchFromDraft's own recovery (draft restart / abort), which re-arms
  // timers that will call back in here.
  const lock = await acquireLock(draftCompleteLockKey(lobbyId), DRAFT_COMPLETE_LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) {
    logger.info({ lobbyId }, 'Draft completion already in progress; skipping duplicate attempt');
    return null;
  }
  const heartbeat = startLockHeartbeat(draftCompleteLockKey(lobbyId), lock.token, DRAFT_COMPLETE_LOCK_TTL_MS);

  try {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') {
      await clearDraftTimers(lobbyId);
      return null;
    }

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    if (bans.length < 2) return null;

    const bannedIds = new Set(bans.map((ban) => ban.category_id));
    const remaining = categories.filter((category) => !bannedIds.has(category.id));
    if (remaining.length !== 1) {
      logger.warn(
        {
          lobbyId,
          totalCategories: categories.length,
          bannedCount: bans.length,
          remainingCount: remaining.length,
          bannedCategoryIds: Array.from(bannedIds),
        },
        'Insufficient categories remaining after bans in draft'
      );
      return null;
    }

    // NOTE: we deliberately do NOT clearDraftTimers() before starting the match.
    // startMatchFromDraft's terminal paths handle teardown (match creation,
    // abort, or draft restart). Clearing timers early would, if this handler
    // crashed mid-flight, leave an active lobby with 2 bans and no scheduled
    // recovery once the lock expires.
    const halfOneCategoryId = remaining[0].id;
    const matchId = await startMatchFromDraft(io, lobbyId, halfOneCategoryId);

    if (matchId) {
      // Match created → draft is done; safe to drop any leftover timers.
      await clearDraftTimers(lobbyId);
    } else {
      // No match and no terminal transition (e.g. an early bail in
      // startMatchFromDraft): if the lobby is still active with bans pending,
      // re-arm the auto-ban watchdog so completion is retried rather than
      // wedged. Terminal paths (abort/restart) already left the lobby inactive
      // or re-armed timers, so this is a no-op for them.
      await rearmDraftCompletionIfStuck(io, lobbyId);
    }
    return matchId;
  } catch (error) {
    // A throw mid-completion must not leave the lobby wedged: re-arm recovery.
    logger.warn(
      {
        error: error instanceof Error ? error.message : error,
        // AppError details (e.g. { userId, operation, attempts } from the ticket
        // CAS) are essential for diagnosing WHO/WHAT conflicted — without them
        // this log line is just "something threw".
        errorDetails: error instanceof AppError ? error.details ?? null : null,
        errorName: error instanceof Error ? error.name : null,
        lobbyId,
      },
      'Draft completion threw; re-arming recovery'
    );
    await rearmDraftCompletionIfStuck(io, lobbyId);
    return null;
  } finally {
    heartbeat.stop();
    await releaseLock(draftCompleteLockKey(lobbyId), lock.token).catch(() => {});
  }
}

// Re-arm the auto-ban watchdog when a completion attempt ended without a
// terminal transition but the lobby is still active and ready (2 bans). This
// guarantees a stuck draft is always retried instead of wedging when the lock
// holder bailed early or crashed.
async function rearmDraftCompletionIfStuck(io: QuizballServer, lobbyId: string): Promise<void> {
  try {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;
    if (await hasPendingRealtimeTimer('draft_auto_ban', lobbyId)) return;
    scheduleDraftAutoBan(io, lobbyId);
    logger.info({ lobbyId }, 'Re-armed draft auto-ban after non-terminal completion');
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : error, lobbyId },
      'Failed to re-arm draft completion recovery'
    );
  }
}

interface ScheduleDraftAutoBanOptions {
  delayMs?: number;
  requireUiReady?: boolean;
  forceAtMs?: number | null;
  turnUserId?: string;
  banCount?: number;
}

export function scheduleDraftAutoBan(
  _io: QuizballServer,
  lobbyId: string,
  options: ScheduleDraftAutoBanOptions = {}
): void {
  const autoBanMs = harnessDelayMs(options.delayMs ?? DRAFT_AUTO_BAN_MS);
  void scheduleRealtimeTimer('draft_auto_ban', lobbyId, new Date(Date.now() + autoBanMs), {
    kind: 'draft_auto_ban',
    lobbyId,
    requireUiReady: options.requireUiReady,
    forceAtMs: options.forceAtMs ?? null,
    turnUserId: options.turnUserId,
    banCount: options.banCount,
  }).catch((error) => {
    logger.error({ error, lobbyId, delayMs: autoBanMs }, 'Failed to schedule draft auto-ban timer');
  });
  logger.debug(
    {
      lobbyId,
      delayMs: options.delayMs ?? DRAFT_AUTO_BAN_MS,
      requireUiReady: options.requireUiReady ?? false,
      forceAtMs: options.forceAtMs ?? null,
    },
    'Scheduled automatic draft ban fallback'
  );
}

export async function scheduleDraftAutoBanForCurrentTurn(
  io: QuizballServer,
  lobbyId: string,
  options: { forceAtMs?: number | null } = {}
): Promise<void> {
  const redis = getRedisClient();
  if (redis && await redis.exists(draftPauseKey(lobbyId))) {
    logger.info({ lobbyId }, 'Not scheduling draft auto-ban while draft is paused');
    return;
  }

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') return;

  const [categories, bans, members] = await Promise.all([
    lobbiesService.getLobbyCategories(lobbyId),
    lobbiesRepo.listLobbyCategoryBans(lobbyId),
    lobbiesRepo.listMembersWithUser(lobbyId),
  ]);
  if (members.length !== 2 || categories.length === 0 || bans.length >= 2) return;

  const turnState = await readDraftTurnState(lobbyId);
  if (!turnState || turnState.banCount !== bans.length || !turnState.nextActorUserId) {
    logger.warn({ lobbyId, banCount: bans.length }, 'Draft turn state missing or out of sync');
    return;
  }
  const { aiUserId } = turnState;
  const expectedUserId = turnState.nextActorUserId;

  if (lobby.mode === 'ranked' && aiUserId && expectedUserId === aiUserId) {
    if (!(await hasPendingRealtimeTimer('draft_ai_ban', lobbyId))) {
      const forceAtMs = scheduleRankedAiBan(io, lobbyId, aiUserId);
      io.to(`lobby:${lobbyId}`).emit('draft:begin', {
        lobbyId,
        turnUserId: expectedUserId,
        forceAtMs,
      });
    }
    return;
  }

  const humanUserIds = members
    .filter((member) => member.user_id !== aiUserId)
    .map((member) => member.user_id);
  const readyState = isHarnessFastTimers()
    ? { readyUserIds: humanUserIds, waitingUserIds: [] }
    : await getDraftReadyState(lobbyId, humanUserIds, bans.length);
  if (readyState.waitingUserIds.length === 0) {
    const redis = getRedisClient();
    const gateDeadlineExists = redis?.isOpen
      ? (await redis.exists(draftUiReadyDeadlineKey(lobbyId, bans.length))) === 1
      : false;
    if (!gateDeadlineExists && await hasPendingRealtimeTimer('draft_auto_ban', lobbyId)) {
      return;
    }
    // Replace the gate watchdog with a fresh turn watchdog. They deliberately
    // share a timer kind/key, so leaving the gate timer in place would fire at
    // the old cancellation deadline and instantly auto-ban a late-ready turn.
    await clearPendingAutoBanTimer(lobbyId);
    if (redis?.isOpen) {
      await redis.del(draftUiReadyDeadlineKey(lobbyId, bans.length));
    }
    const forceAtMs = Date.now() + harnessDelayMs(DRAFT_AUTO_BAN_MS);
    scheduleDraftAutoBan(io, lobbyId, {
      delayMs: Math.max(0, forceAtMs - Date.now()),
      forceAtMs,
      turnUserId: expectedUserId,
      banCount: bans.length,
    });
    io.to(`lobby:${lobbyId}`).emit('draft:begin', {
      lobbyId,
      turnUserId: expectedUserId,
      forceAtMs,
    });
    logger.info(
      { lobbyId, turnUserId: expectedUserId, banCount: bans.length, forceAtMs },
      'Draft turn began after UI-ready gate'
    );
    return;
  }

  const forceAtMs = options.forceAtMs ?? await getOrCreateDraftUiReadyDeadline(lobbyId, bans.length);
  io.to(`lobby:${lobbyId}`).emit('draft:waiting_for_ready', {
    lobbyId,
    readyUserIds: readyState.readyUserIds,
    waitingUserIds: readyState.waitingUserIds,
    forceCancelAt: new Date(forceAtMs).toISOString(),
  });
  scheduleDraftAutoBan(io, lobbyId, {
    delayMs: Math.max(0, forceAtMs - Date.now()),
    requireUiReady: true,
    forceAtMs,
    turnUserId: expectedUserId,
    banCount: bans.length,
  });
  logger.info({ lobbyId, expectedUserId, forceAtMs }, 'Draft auto-ban waiting for client ui_ready');
}

export async function runDraftAutoBan(
  io: QuizballServer,
  lobbyId: string,
  options: {
    requireUiReady?: boolean;
    forceAtMs?: number | null;
    turnUserId?: string;
    banCount?: number;
  } = {}
): Promise<void> {
  try {
    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      logger.info({ lobbyId }, 'Skipping draft auto-ban while draft is paused');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;

    const [categories, bans, members] = await Promise.all([
      lobbiesService.getLobbyCategories(lobbyId),
      lobbiesRepo.listLobbyCategoryBans(lobbyId),
      lobbiesRepo.listMembersWithUser(lobbyId),
    ]);
    if (members.length !== 2 || categories.length === 0) return;
    // Recovery path: both bans already exist but the lobby is still active —
    // a prior completion attempt bailed early or crashed before creating the
    // match. Retry completion instead of bailing so the draft can't wedge.
    if (bans.length >= 2) {
      await completeDraftIfReady(io, lobbyId);
      return;
    }

    const turnState = await readDraftTurnState(lobbyId);
    if (!turnState || turnState.banCount !== bans.length || !turnState.nextActorUserId) {
      logger.warn({ lobbyId, banCount: bans.length }, 'Draft turn state missing or out of sync');
      return;
    }
    const { aiUserId } = turnState;
    const expectedUserId = turnState.nextActorUserId;
    if (bans.some((ban) => ban.user_id === expectedUserId)) return;
    if (
      (options.turnUserId !== undefined && options.turnUserId !== expectedUserId)
      || (options.banCount !== undefined && options.banCount !== bans.length)
    ) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
      return;
    }
    const expectedActorIsRankedHuman = lobby.mode === 'ranked' && expectedUserId !== aiUserId;
    if ((options.requireUiReady || expectedActorIsRankedHuman) && !isHarnessFastTimers()) {
      const humanUserIds = members
        .filter((member) => member.user_id !== aiUserId)
        .map((member) => member.user_id);
      const readyState = await getDraftReadyState(lobbyId, humanUserIds, bans.length);
      if (options.requireUiReady && readyState.waitingUserIds.length === 0) {
        await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
        return;
      }
      if (readyState.waitingUserIds.length > 0) {
        const forceAtMs = options.forceAtMs ?? null;
        if (forceAtMs === null) {
          await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
          return;
        }
        if (Date.now() < forceAtMs) {
          await scheduleDraftAutoBanForCurrentTurn(io, lobbyId, { forceAtMs });
          return;
        }
        if (expectedActorIsRankedHuman) {
          await abortRankedDraftWithoutUiReady({
            io,
            lobby,
            members,
            aiUserId,
            expectedUserId,
            banCount: bans.length,
            forceAtMs: options.forceAtMs,
          });
          return;
        }
        logger.warn(
          { lobbyId, expectedUserId, forceAtMs },
          'Draft auto-ban force-opened without client ui_ready'
        );
      }
    }

    const bannedIds = new Set(bans.map((ban) => ban.category_id));
    const candidates = categories.filter((category) => !bannedIds.has(category.id));
    const autoChoice = candidates[Math.floor(getRandom() * candidates.length)];
    if (!autoChoice) return;

    let committedBan: Awaited<ReturnType<typeof lobbiesRepo.insertLobbyCategoryBan>> | null = null;
    try {
      const ban = await lobbiesRepo.insertLobbyCategoryBan(lobbyId, expectedUserId, autoChoice.id);
      if (ban.user_id === expectedUserId) committedBan = ban;
    } catch (error) {
      logger.warn({ error, lobbyId, userId: expectedUserId }, 'Failed to insert automatic draft ban');
    }

    const nextForceAtMs = null;
    const advancedState = committedBan
      ? await advanceDraftTurnState(lobbyId, expectedUserId, bans.length)
      : null;
    if (committedBan && advancedState) {
      io.to(`lobby:${lobbyId}`).emit('draft:banned', {
        actorId: expectedUserId,
        categoryId: committedBan.category_id,
        turnUserId: advancedState.nextActorUserId,
        forceAtMs: nextForceAtMs,
      });
      logger.info(
        { lobbyId, userId: expectedUserId, categoryId: committedBan.category_id, delayMs: DRAFT_AUTO_BAN_MS },
        'Draft ban applied automatically after timeout'
      );
    }

    await completeDraftIfReady(io, lobbyId);

    // Re-arm even when this run committed nothing (transient insert failure,
    // or a concurrent ban won the advance) — a still-open turn must never be
    // left without a watchdog.
    const latestState = advancedState ?? await readDraftTurnState(lobbyId);
    if (latestState?.nextActorUserId) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId, {
        forceAtMs: nextForceAtMs,
      });
    }
  } catch (error) {
    logger.error({ error, lobbyId, delayMs: DRAFT_AUTO_BAN_MS }, 'Scheduled automatic draft ban callback failed');
  }
}

/**
 * Durable draft disconnect-grace expiry handler. Fired by the Redis-backed
 * realtime timer scheduler (kind `draft_grace_expiry`), so it survives
 * redeploys / instance hops — unlike the old in-memory setTimeout.
 *
 * Recovery is driven by the durable timer + DB/Redis state, NOT by a short-lived
 * grace key. Concretely:
 *  - The pending-recovery marker (`draftGraceKey`) has a generous TTL
 *    (`DRAFT_GRACE_TTL_SEC`) that comfortably outlives the grace window plus any
 *    realistic delayed delivery (redeploy / scheduler lag), so a late-delivered
 *    timer still finds it and recovers instead of no-opping.
 *  - Mutual exclusion between duplicate/concurrent firings is a SHORT-lived
 *    processing lock (NX, auto-expiring) — so a crashed handler releases the lock
 *    and a retry can re-run, rather than the dedup token being consumed forever.
 *  - The grace marker is only cleared AFTER recovery work succeeds. On failure we
 *    leave it in place and rethrow, so the scheduler reschedules the timer and the
 *    recovery is retried (the scheduler only deletes the payload on success).
 *  - noop if the player already reconnected (grace key cleared + timer cancelled
 *    by resumeDraftForReconnectedPlayer), or the lobby/draft is already completed.
 *  - No duplicate ban / completion: downstream runDraftAutoBan /
 *    completeDraftIfReady re-read state and re-check ban counts + lobby status.
 *    (Duplicate *match* rows under a rare concurrent completion are not fully
 *    excluded at the DB level yet — see the matches.lobby_id uniqueness follow-up.)
 */
export async function runDraftGraceExpiry(
  io: QuizballServer,
  lobbyId: string,
  disconnectedUserId: string
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  // Is recovery still pending? Read (don't consume) — the durable marker is the
  // source of truth and must survive until the work actually completes.
  const gracePending = (await redis.exists(draftGraceKey(lobbyId))) === 1;
  if (!gracePending) {
    // Reconnect cleared it, or a prior firing already recovered this draft.
    logger.info({ lobbyId, disconnectedUserId }, 'draft_grace_expiry_noop');
    return;
  }

  // Short-lived processing lock for mutual exclusion across duplicate/concurrent
  // firings. Token-checked (acquireLock/releaseLock) so that if this handler
  // outlives the lock TTL and another worker re-acquires, our release can't
  // delete the new owner's lock. Auto-expires so a crash doesn't wedge recovery.
  const lock = await acquireLock(draftGraceLockKey(lobbyId), DRAFT_GRACE_LOCK_TTL_SEC * 1000);
  if (!lock.acquired || !lock.token) {
    logger.info({ lobbyId, disconnectedUserId }, 'draft_grace_expiry_noop');
    return;
  }

  try {
    const activeLobby = await lobbiesRepo.getById(lobbyId);
    if (!activeLobby || activeLobby.status !== 'active') {
      // Draft already completed/gone — clear pending state, nothing to recover.
      await redis.del([draftPauseKey(lobbyId), draftGraceKey(lobbyId)]);
      logger.info({ lobbyId, disconnectedUserId }, 'draft_grace_expiry_noop');
      return;
    }

    const activeMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
    const disconnectedExists = await Promise.all(
      activeMembers.map((member) => redis.exists(draftDisconnectKey(lobbyId, member.user_id)))
    );
    const disconnectedUserIds = activeMembers
      .filter((_, index) => disconnectedExists[index] === 1)
      .map((member) => member.user_id);
    if (disconnectedUserIds.length === 0) {
      // Everyone reconnected between the pending check and now — resume cleanly.
      await redis.del([draftPauseKey(lobbyId), draftGraceKey(lobbyId)]);
      logger.info({ lobbyId, disconnectedUserId }, 'draft_grace_expiry_noop');
      return;
    }

    await Promise.all(
      disconnectedUserIds.map((absentUserId) =>
        redis.set(draftAbsentAfterGraceKey(lobbyId, absentUserId), '1', { EX: DRAFT_DISCONNECT_TTL_SEC })
      )
    );

    const currentActorId = await getCurrentDraftActorId(lobbyId);
    logger.info(
      { lobbyId, disconnectedUserIds, currentActorId },
      'draft_grace_expiry_fired'
    );

    if (activeLobby.mode === 'ranked') {
      const aiUserId = await resolveRankedAiUserId(lobbyId, activeMembers);
      const humanUserIds = activeMembers
        .filter((member) => member.user_id !== aiUserId)
        .map((member) => member.user_id);
      const absentHumanUserIds = humanUserIds.filter((userId) => disconnectedUserIds.includes(userId));

      if (absentHumanUserIds.length > 0) {
        const abortSignals = await getRankedDraftAbortSignals(lobbyId, humanUserIds);
        await abortRankedDraftBeforeMatchCreation(
          io,
          activeLobby,
          humanUserIds,
          'draft_grace_expired_before_ticket_consumption',
          abortSignals
        );
        await clearDraftTimers(lobbyId);
        await cancelRealtimeTimer('draft_grace_expiry', lobbyId).catch((error) => {
          logger.warn({ error, lobbyId }, 'Failed to cancel draft grace timer after ranked draft abort');
        });
        await redis.del([
          draftPauseKey(lobbyId),
          draftGraceKey(lobbyId),
          ...disconnectedUserIds.map((absentUserId) => draftDisconnectKey(lobbyId, absentUserId)),
        ]);
        logger.info(
          { lobbyId, disconnectedUserIds, absentHumanUserIds },
          'draft_grace_expiry_aborted_ranked_draft'
        );
        return;
      }
    }

    // The pause key must go BEFORE recovery (runDraftAutoBan and
    // resumeActiveDraftTimers both no-op while it exists), but the disconnect
    // keys are the retry evidence: if recovery throws, the rescheduled timer
    // must still see disconnectedUserIds.length > 0 — so they are only
    // deleted after recovery succeeds.
    await redis.del(draftPauseKey(lobbyId));

    if (currentActorId && disconnectedUserIds.includes(currentActorId)) {
      await runDraftAutoBan(io, lobbyId);
    } else {
      await resumeActiveDraftTimers(io, lobbyId);
    }

    // Recovery succeeded — only now consume the evidence + pending marker.
    await Promise.all(disconnectedUserIds.map((absentUserId) => redis.del(draftDisconnectKey(lobbyId, absentUserId))));
    await redis.del(draftGraceKey(lobbyId));
    logger.info({ lobbyId, disconnectedUserIds, currentActorId }, 'draft_grace_expiry_recovered');
  } catch (error) {
    // Leave draftGraceKey in place and rethrow so the scheduler reschedules and
    // retries — a transient DB/Redis blip must not permanently lose recovery.
    logger.error({ error, lobbyId, disconnectedUserId }, 'Draft disconnect grace expiry failed; will retry');
    throw error;
  } finally {
    await releaseLock(draftGraceLockKey(lobbyId), lock.token).catch(() => {});
  }
}

async function getCurrentDraftActorId(lobbyId: string): Promise<string | null> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') return null;
  return (await readDraftTurnState(lobbyId))?.nextActorUserId ?? null;
}

async function anyDraftDisconnectExists(lobbyId: string, userIds: string[]): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return false;

  const existsResults = await Promise.all(
    userIds.map((userId) => redis.exists(draftDisconnectKey(lobbyId, userId)))
  );
  return existsResults.some((exists) => exists === 1);
}

function scheduleRankedAiBan(_io: QuizballServer, lobbyId: string, aiUserId: string): number {
  const delayMs = getAiBanDelayMs();
  const forceAtMs = Date.now() + delayMs;

  void scheduleRealtimeTimer('draft_ai_ban', lobbyId, new Date(forceAtMs), {
    kind: 'draft_ai_ban',
    lobbyId,
    aiUserId,
  }).catch((error) => {
    logger.error({ error, lobbyId, aiUserId, delayMs }, 'Failed to schedule draft AI ban timer');
  });
  logger.debug({ lobbyId, aiUserId, delayMs }, 'Scheduled delayed AI draft ban');
  return forceAtMs;
}

export async function runRankedAiDraftBan(io: QuizballServer, lobbyId: string, aiUserId: string): Promise<void> {
  const delayMs = 0;
  try {
    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      logger.info({ lobbyId, aiUserId }, 'Skipping AI draft ban while draft is paused');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active' || lobby.mode !== 'ranked') return;

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasAiMember = members.some((member) => member.user_id === aiUserId);
    if (!hasAiMember) return;

    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const turnState = await readDraftTurnState(lobbyId);
    if (!turnState || turnState.aiUserId !== aiUserId || turnState.banCount !== bans.length) return;
    if (turnState.nextActorUserId !== aiUserId) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
      return;
    }

    // The AI already banned — nothing to do.
    if (bans.some((ban) => ban.user_id === aiUserId)) return;

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const bannedIds = new Set(bans.map((ban) => ban.category_id));
    const candidates = categories.filter((category) => !bannedIds.has(category.id));
    const aiChoice = candidates[Math.floor(getRandom() * candidates.length)];
    if (!aiChoice) {
      // No category left for the AI to ban — let auto-ban recovery settle it.
      scheduleDraftAutoBan(io, lobbyId);
      return;
    }

    let ban: Awaited<ReturnType<typeof lobbiesRepo.insertLobbyCategoryBan>>;
    try {
      ban = await lobbiesRepo.insertLobbyCategoryBan(lobbyId, aiUserId, aiChoice.id);
    } catch (error) {
      // e.g. the picked category collided on the (lobby_id, category_id) UNIQUE
      // constraint due to a race. Don't dead-end — recover via auto-ban.
      logger.warn({ error, lobbyId, aiUserId }, 'Failed to insert delayed AI draft ban; recovering via auto-ban');
      scheduleDraftAutoBan(io, lobbyId);
      return;
    }
    if (ban.user_id !== aiUserId) {
      scheduleDraftAutoBan(io, lobbyId);
      return;
    }

    const advancedState = await advanceDraftTurnState(lobbyId, aiUserId, bans.length);
    if (!advancedState) return;

    io.to(`lobby:${lobbyId}`).emit('draft:banned', {
      actorId: aiUserId,
      categoryId: ban.category_id,
      turnUserId: advancedState.nextActorUserId,
      forceAtMs: null,
    });
    logger.info(
      { lobbyId, userId: aiUserId, categoryId: ban.category_id, delayMs },
      'Draft ban applied (AI)'
    );

    await completeDraftIfReady(io, lobbyId);
    if (advancedState.nextActorUserId) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
    }
  } catch (error) {
    logger.error({ error, lobbyId, aiUserId, delayMs }, 'Scheduled AI draft ban callback failed');
  }
}

export async function resumeActiveDraftTimers(
  io: QuizballServer,
  lobbyId: string,
  options: { restartTimers?: boolean } = {}
): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') {
    await clearDraftTimers(lobbyId);
    return;
  }

  const redis = getRedisClient();
  if (redis && await redis.exists(draftPauseKey(lobbyId))) {
    await clearDraftTimers(lobbyId);
    logger.info({ lobbyId }, 'Draft timers remain paused because a player is disconnected');
    return;
  }

  if (options.restartTimers) {
    await clearDraftTimers(lobbyId);
  }

  const [categories, bans, members] = await Promise.all([
    lobbiesService.getLobbyCategories(lobbyId),
    lobbiesRepo.listLobbyCategoryBans(lobbyId),
    lobbiesRepo.listMembersWithUser(lobbyId),
  ]);
  if (members.length !== 2 || categories.length === 0) return;

  if (bans.length >= 2) {
    await completeDraftIfReady(io, lobbyId);
    return;
  }

  const turnState = await readDraftTurnState(lobbyId);
  if (!turnState || turnState.banCount !== bans.length || !turnState.nextActorUserId) return;
  const { aiUserId } = turnState;
  const expectedUserId = turnState.nextActorUserId;
  const needsAiTimer = Boolean(
    aiUserId
      && expectedUserId === aiUserId
      && !bans.some((ban) => ban.user_id === aiUserId)
      && !(await hasPendingRealtimeTimer('draft_ai_ban', lobbyId))
  );

  // Normal reconnect hydration preserves existing deadlines. A draft resume
  // after pause restarts timers because the old deadlines were canceled.
  if (options.restartTimers || needsAiTimer || !(await hasPendingRealtimeTimer('draft_auto_ban', lobbyId))) {
    await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
  }
}

export const draftRealtimeService = {
  async handleUiReady(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { lobbyId?: string; turnUserId?: string; banCount?: number } = {}
  ): Promise<void> {
    const lobbyId = payload.lobbyId ?? socket.data.lobbyId;
    if (!lobbyId) {
      logger.warn({ userId: socket.data.user.id }, 'Draft ui_ready ignored: no lobbyId on socket');
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') {
      logger.info({ lobbyId, status: lobby?.status ?? null }, 'Draft ui_ready ignored: lobby inactive');
      return;
    }

    const [members, bans] = await Promise.all([
      lobbiesRepo.listMembersWithUser(lobbyId),
      lobbiesRepo.listLobbyCategoryBans(lobbyId),
    ]);
    if (!members.some((member) => member.user_id === socket.data.user.id)) {
      logger.warn({ lobbyId, userId: socket.data.user.id }, 'Draft ui_ready ignored: user not in lobby');
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in this draft lobby' });
      return;
    }
    if (members.length !== 2 || bans.length >= 2) return;

    const turnState = await readDraftTurnState(lobbyId);
    if (!turnState || turnState.banCount !== bans.length || !turnState.nextActorUserId) return;
    const expectedUserId = turnState.nextActorUserId;
    if (payload.turnUserId && payload.turnUserId !== expectedUserId) {
      logger.debug({ lobbyId, payloadTurnUserId: payload.turnUserId, expectedUserId }, 'Draft ui_ready ignored: stale actor');
      return;
    }
    if (payload.banCount !== undefined && payload.banCount !== bans.length) {
      logger.debug({ lobbyId, payloadBanCount: payload.banCount, currentBanCount: bans.length }, 'Draft ui_ready ignored: stale turn');
      return;
    }

    const alreadyReady = await isDraftUserUiReady(lobbyId, socket.data.user.id, bans.length);
    if (alreadyReady) {
      logger.debug(
        { lobbyId, userId: socket.data.user.id, banCount: bans.length, socketId: socket.id },
        'Duplicate draft ui_ready ignored'
      );
      return;
    }

    await markDraftUiReady(lobbyId, socket.data.user.id, bans.length);
    const presenceTimerKey = `${lobbyId}:${socket.data.user.id}`;
    const presenceTimer = draftPresenceRecheckTimers.get(presenceTimerKey);
    if (presenceTimer) {
      clearTimeout(presenceTimer);
      draftPresenceRecheckTimers.delete(presenceTimerKey);
    }
    trackDraftUiReady({
      userId: socket.data.user.id,
      lobbyId,
      mode: lobby.mode,
      banCount: bans.length,
      socketId: socket.id,
    });
    logger.info(
      { lobbyId, userId: socket.data.user.id, banCount: bans.length, socketId: socket.id, mode: lobby.mode },
      'Draft UI ready'
    );
    await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
  },

  async pauseDraftForDisconnectedPlayer(
    io: QuizballServer,
    lobbyId: string,
    userId: string,
    options: DraftDisconnectPresenceOptions = {}
  ): Promise<void> {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'active') return;

    const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
    const sameUserSockets = sockets.filter((socket) =>
      socket.id !== options.ignoreSocketId &&
      socket.data.user.id === userId
    );
    const replacementSocketPresent = !options.knownDisconnected && sameUserSockets.some((socket) => {
      if (typeof options.disconnectedConnectedAt !== 'number') return true;
      const connectedAt = socket.data.connectedAt;
      return typeof connectedAt !== 'number' || connectedAt >= options.disconnectedConnectedAt;
    });

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    if (!members.some((member) => member.user_id === userId)) return;

    const redis = getRedisClient();
    if (!redis) return;

    await redis.set(draftDisconnectKey(lobbyId, userId), String(Date.now()), { EX: DRAFT_DISCONNECT_TTL_SEC });
    await redis.set(draftPauseKey(lobbyId), String(Date.now()), { EX: DRAFT_DISCONNECT_TTL_SEC });
    await clearDraftTimers(lobbyId);

    const remainingPlayers = members.filter((member) => member.user_id !== userId);
    remainingPlayers.forEach((member) => {
      io.to(`user:${member.user_id}`).emit('draft:opponent_disconnected', {
        lobbyId,
        opponentId: userId,
        graceMs: DRAFT_DISCONNECT_GRACE_MS,
      });
    });
    logger.info(
      { lobbyId, userId, graceMs: DRAFT_DISCONNECT_GRACE_MS },
      'Draft paused for disconnected player'
    );

    const acquired = await redis.set(draftGraceKey(lobbyId), String(Date.now()), { NX: true, EX: DRAFT_GRACE_TTL_SEC });
    if (acquired !== 'OK') return;

    // Recovery is driven by a durable Redis-backed timer (not an in-memory
    // setTimeout) so the grace window survives redeploys / instance hops. Keyed
    // by lobbyId, so a repeat disconnect just overwrites the same deadline.
    await scheduleRealtimeTimer(
      'draft_grace_expiry',
      lobbyId,
      new Date(Date.now() + harnessDelayMs(DRAFT_DISCONNECT_GRACE_MS)),
      { kind: 'draft_grace_expiry', lobbyId, disconnectedUserId: userId }
    ).catch((error) => {
      // draftDisconnectKey/draftPauseKey/draftGraceKey are already written; if
      // the durable timer fails to schedule, nothing would ever fire and the
      // draft would stay paused until key TTLs expire. Fall back to an
      // in-memory timer: runDraftGraceExpiry is lock-guarded + idempotent, so
      // a duplicate firing (if the durable timer actually landed) is harmless.
      // The fallback doesn't survive a process restart, but that's strictly
      // better than no timer at all.
      logger.error({ error, lobbyId, userId }, 'Failed to schedule draft grace expiry timer; arming in-memory fallback');
      const fallback = setTimeout(() => {
        runDraftGraceExpiry(io, lobbyId, userId).catch((fallbackError) => {
          logger.error({ error: fallbackError, lobbyId, userId }, 'In-memory draft grace expiry fallback failed');
        });
      }, harnessDelayMs(DRAFT_DISCONNECT_GRACE_MS));
      fallback.unref?.();
    });
    logger.info(
      { lobbyId, userId, graceMs: DRAFT_DISCONNECT_GRACE_MS },
      'draft_grace_expiry_scheduled'
    );

    if (replacementSocketPresent) {
      logger.info(
        { lobbyId, userId, socketCount: sockets.length, sameUserSocketCount: sameUserSockets.length },
        'Draft auto-resuming after fast socket replacement'
      );
      await draftRealtimeService.resumeDraftForReconnectedPlayer(io, lobbyId, userId);
    } else if (!options.knownDisconnected && sameUserSockets.length > 0) {
      // The user still has OLDER live socket(s) in the lobby room. They can't
      // instantly prove presence — an in-flight zombie looks identical (the
      // S15 incident, see #60) — but a genuine zombie cannot outlive the
      // socket.io ping timeout. Re-check shortly: if a live same-user socket
      // remains, the "disconnect" was a short-lived ghost socket dying next to
      // a healthy connection (page-transition duplicate), and the draft should
      // resume instead of freezing for the full grace and aborting.
      scheduleDraftPresenceRecheck(
        lobbyId,
        userId,
        DRAFT_PRESENCE_RECHECK_MS,
        async () => {
          const liveSockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
          const stillPresent = liveSockets.some((socket) => socket.data.user.id === userId);
          if (!stillPresent) {
            logger.info(
              { lobbyId, userId },
              'Draft presence re-check: player has no live sockets; grace continues'
            );
            return;
          }
          logger.info(
            { lobbyId, userId },
            'Draft presence re-check: live socket survived ping timeout; resuming draft'
          );
          await draftRealtimeService.resumeDraftForReconnectedPlayer(io, lobbyId, userId);
        }
      );
      logger.info(
        {
          lobbyId,
          userId,
          sameUserSocketCount: sameUserSockets.length,
          recheckMs: DRAFT_PRESENCE_RECHECK_MS,
        },
        'draft_presence_recheck_scheduled'
      );
    }
  },

  async resumeDraftForReconnectedPlayer(
    io: QuizballServer,
    lobbyId: string,
    userId: string
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const wasDisconnected = (await redis.exists(draftDisconnectKey(lobbyId, userId))) === 1
      || (await redis.exists(draftAbsentAfterGraceKey(lobbyId, userId))) === 1;
    if (!wasDisconnected) return;

    await redis.del([draftDisconnectKey(lobbyId, userId), draftAbsentAfterGraceKey(lobbyId, userId)]);
    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const memberIds = members.map((member) => member.user_id);
    if (!(await anyDraftDisconnectExists(lobbyId, memberIds))) {
      const banCount = (await lobbiesRepo.listLobbyCategoryBans(lobbyId)).length;
      await redis.del([draftPauseKey(lobbyId), draftGraceKey(lobbyId)]);
      // A reconnect is a new proof-of-presence round. Old acknowledgements are
      // intentionally invalidated so both visible clients must confirm the
      // board again before a fresh, full turn deadline is armed.
      await redis.del([
        draftUiReadyDeadlineKey(lobbyId, banCount),
        ...memberIds.map((memberId) => draftUiReadyKey(lobbyId, memberId, banCount)),
      ]);
      // Cancel the pending durable grace-expiry timer; clearing the grace key
      // already makes a stray firing a noop, but cancelling avoids the wasted poll.
      await cancelRealtimeTimer('draft_grace_expiry', lobbyId);
      io.to(`lobby:${lobbyId}`).emit('draft:resume', { lobbyId });
      await resumeActiveDraftTimers(io, lobbyId, { restartTimers: true });
      logger.info({ lobbyId, userId }, 'Draft resumed after player reconnected');
    }
  },

  async handleBan(
    io: QuizballServer,
    socket: QuizballSocket,
    categoryId: string
  ): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) {
      logger.warn({ userId: socket.data.user.id }, 'Draft ban failed: no lobbyId on socket');
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      logger.warn({ lobbyId }, 'Draft ban failed: lobby not found');
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
      return;
    }
    if (lobby.status !== 'active') {
      logger.warn({ lobbyId, status: lobby.status }, 'Draft ban failed: lobby not active');
      socket.emit('error', { code: 'LOBBY_NOT_ACTIVE', message: 'Draft has not started yet' });
      return;
    }

    const redis = getRedisClient();
    if (redis && await redis.exists(draftPauseKey(lobbyId))) {
      socket.emit('error', {
        code: 'DRAFT_PAUSED',
        message: 'Draft is paused while a player reconnects',
      });
      return;
    }

    const categories = await lobbiesService.getLobbyCategories(lobbyId);
    const categoryIds = new Set(categories.map((c) => c.id));
    if (!categoryIds.has(categoryId)) {
      logger.warn({ lobbyId, categoryId }, 'Category not in lobby pool');
      socket.emit('error', { code: 'INVALID_CATEGORY', message: 'Category not available for banning' });
      return;
    }

    const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const turnState = await readDraftTurnState(lobbyId);
    if (!turnState || turnState.banCount !== bans.length || !turnState.nextActorUserId) {
      logger.warn({ lobbyId, banCount: bans.length }, 'Draft turn state missing or out of sync');
      socket.emit('error', { code: 'BAN_FAILED', message: 'Draft state is unavailable — retry shortly.' });
      return;
    }
    const { aiUserId } = turnState;
    const expectedUserId = turnState.nextActorUserId;
    if (socket.data.user.id !== expectedUserId) {
      logger.warn(
        { lobbyId, userId: socket.data.user.id, expectedUserId },
        'Draft ban out of turn'
      );
      socket.emit('error', { code: 'NOT_YOUR_TURN', message: 'It is not your turn to ban' });
      return;
    }

    let ban: Awaited<ReturnType<typeof lobbiesRepo.insertLobbyCategoryBan>>;
    try {
      ban = await lobbiesRepo.insertLobbyCategoryBan(lobbyId, socket.data.user.id, categoryId);
    } catch (error) {
      // Only thrown on a transient inconsistency now (the conflicting row
      // vanished mid-write). Tell the client to retry and arm the auto-ban
      // watchdog so the draft still progresses if they don't.
      logger.warn({ error, lobbyId, userId: socket.data.user.id, categoryId }, 'Failed to insert lobby ban');
      socket.emit('error', { code: 'BAN_FAILED', message: 'That category is unavailable — pick another.' });
      scheduleDraftAutoBan(io, lobbyId);
      return;
    }
    // insertLobbyCategoryBan is idempotent: a foreign collision (the opponent or
    // a racing auto-ban already banned this category) returns THEIR ban row, not
    // this user's. That means this user's pick didn't land — prompt them to pick
    // another rather than falsely broadcasting it as their ban.
    if (ban.user_id !== socket.data.user.id) {
      logger.warn(
        { lobbyId, userId: socket.data.user.id, categoryId, existingBannerId: ban.user_id },
        'Draft ban collided with an existing ban for the same category'
      );
      socket.emit('error', { code: 'BAN_FAILED', message: 'That category is unavailable — pick another.' });
      scheduleDraftAutoBan(io, lobbyId);
      return;
    }
    logger.info(
      { lobbyId, userId: socket.data.user.id, categoryId: ban.category_id },
      'Draft ban applied'
    );

    const advancedState = await advanceDraftTurnState(lobbyId, socket.data.user.id, bans.length);
    if (!advancedState) {
      logger.warn({ lobbyId, userId: socket.data.user.id, banCount: bans.length }, 'Draft turn advance lost a concurrent race');
      return;
    }
    const updatedBans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
    const isRankedVsAi = lobby.mode === 'ranked' && aiUserId !== null;
    // A committed ban closes the active turn. The next human turn only gets a
    // deadline after the UI-ready gate completes (`draft:begin`); AI turns
    // intentionally carry no countdown.
    const forceAtMs = null;
    io.to(`lobby:${lobbyId}`).emit('draft:banned', {
      actorId: socket.data.user.id,
      categoryId: ban.category_id,
      turnUserId: advancedState.nextActorUserId,
      forceAtMs,
    });
    if (isRankedVsAi && updatedBans.length === 1 && socket.data.user.id !== aiUserId) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId);
      return;
    }
    if (updatedBans.length < 2) {
      await scheduleDraftAutoBanForCurrentTurn(io, lobbyId, { forceAtMs });
      return;
    }

    await completeDraftIfReady(io, lobbyId);
  },
};
