import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { countryPayload } from '../../core/country.js';
import { logger } from '../../core/logger.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { appMetrics } from '../../core/metrics.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchQuestionsRepo } from '../../modules/matches/match-questions.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { resolveMatchVariant, type PossessionStatePayload } from '../../modules/matches/matches.service.js';
import type { MatchPlayerRow, MatchRow } from '../../modules/matches/matches.types.js';
import { parseStoredAvatarCustomization } from '../../modules/users/avatar-customization.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { storeService } from '../../modules/store/store.service.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { getMatchCache, type MatchCache } from '../match-cache.js';
import { getCurrentCountriesForUsers } from '../session-country.js';
import {
  cancelMatchQuestionTimer,
  sendMatchQuestion,
} from '../match-flow.js';
import {
  matchDisconnectKey,
  matchExitPendingKey,
  matchForfeitPendingUserKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import {
  cancelPossessionHalftimeTimer,
  deferPossessionQuestionTimerForPause,
  emitPossessionStateToSocket,
  ensurePossessionActiveTimers,
  fireAndForget,
  resumePossessionHalftimeAfterPause,
  resumePossessionMatchQuestion,
} from '../possession-match-flow.js';
import { completePossessionMatchFromProgress } from '../possession-completion.js';
import {
  emitPartyQuizStateToSocket,
  ensurePartyQuizActiveTimer,
  resumePartyQuizQuestion,
  sendPartyQuizQuestion,
} from '../party-quiz-match-flow.js';
import {
  getActivePartyPlayers,
  isPartyQuizDropped,
  sanitizePartyQuizState,
} from '../party-quiz-state.js';
import { getRedisClient } from '../redis.js';
import {
  cancelRealtimeTimer,
  scheduleRealtimeTimer,
} from '../realtime-timer-scheduler.js';
import type { MatchRejoinAvailablePayload } from '../socket.types.js';
import type { MatchResumeUiReadyPayload } from '../schemas/match.schemas.js';
import {
  acknowledgeMatchUiReady,
  openMatchUiReadyGate,
  type MatchUiReadyDispatchReason,
} from '../match-ui-ready-gate.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import {
  buildOpponentForfeitPendingPayload,
  buildReconnectLimitForfeitPendingPayload,
  finalizeMatchAsForfeit,
  setForfeitPendingForUser,
} from './match-forfeit.service.js';
import {
  applyPartyQuizDropouts,
  buildPartyDropoutPayload,
  setPartyDropoutPendingForUser,
} from './party-quiz-dropout.service.js';
import {
  buildParticipantPayloads,
  getOpponentInfo,
  getOpponentInfoFromParticipants,
  getParticipantSnapshot,
  resolveMatchCategoryName,
  type MatchParticipantSnapshot,
} from './match-participants.helpers.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { resolveMatchPresence } from './match-presence.service.js';
import { abandonMatchWithCompleteLock } from './match-terminal.service.js';
import {
  findOpponentInDisconnectGrace,
  markExcusedExitPending,
} from './match-excused-exit.service.js';
import {
  hasMatchStagePresenceFromSocketIds,
  type MatchStageKey,
} from './match-stage-presence.service.js';

const MATCH_DISCONNECT_GRACE_MS = 20000;
const MAX_MATCH_DISCONNECTS = 3;
const MATCH_RESUME_COUNTDOWN_MS = 5000;
const MATCH_RESUME_UI_READY_CEILING_MS = 8_000;
const LIVE_SOCKET_SKIP_PAUSE_MIN_AGE_MS = 5000;
const PRESENCE_TTL_SEC = 75;
const DISCONNECT_TTL_SEC = 75;
// Redis TTL on the grace key; must stay above the grace window (20s) so the key
// outlives the durable grace-expiry timer with a small margin.
const GRACE_TTL_SEC = 25;
const RESUME_COUNTDOWN_TTL_SEC = 15;
const FORFEIT_TTL_SEC = 600;
/**
 * How far the paused round's question-timeout timer is pushed back instead of
 * being cancelled. Must comfortably exceed grace (20s) + resume countdown (5s)
 * so it never fires during a healthy pause/resume cycle; it exists purely as
 * the last-resort resolver when every other path (resume, grace expiry,
 * forfeit) was dropped. A successful resume re-bases the timer to the rebased
 * question deadline; a terminal match makes the fire a no-op that clears it.
 */
const PAUSE_QUESTION_BACKSTOP_MS = 90_000;

type PossessionTerminalPlayer = MatchPlayerRow | MatchParticipantSnapshot;

export async function getRemainingDisconnectGraceMs(matchId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return MATCH_DISCONNECT_GRACE_MS;

  try {
    const graceKey = matchGraceKey(matchId);
    const rawStartedAt = await redis.get(graceKey);
    const startedAtMs = Number(rawStartedAt);
    if (Number.isFinite(startedAtMs) && startedAtMs > 0) {
      const remainingMs = MATCH_DISCONNECT_GRACE_MS - (Date.now() - startedAtMs);
      return Math.max(0, Math.min(MATCH_DISCONNECT_GRACE_MS, remainingMs));
    }

    const ttl = await redis.ttl(graceKey);
    return ttl > 0 ? Math.min(ttl * 1000, MATCH_DISCONNECT_GRACE_MS) : MATCH_DISCONNECT_GRACE_MS;
  } catch (error) {
    logger.warn({ error, matchId }, 'Failed to compute remaining disconnect grace');
    return MATCH_DISCONNECT_GRACE_MS;
  }
}

async function resolveHumanReadyUserIds(matchId: string, userIds: string[]): Promise<string[]> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return [];

  const redis = getRedisClient();
  const rankedAiUserId = redis?.isOpen ? await redis.get(rankedAiMatchKey(matchId)) : null;
  try {
    const usersById = await usersRepo.getByIds(uniqueUserIds);
    return uniqueUserIds.filter((userId) => userId !== rankedAiUserId && usersById.get(userId)?.is_ai !== true);
  } catch (error) {
    logger.warn({ error, matchId }, 'Failed to resolve AI users for resume UI-ready gate');
    return uniqueUserIds.filter((userId) => userId !== rankedAiUserId);
  }
}

function getPausePresenceStageKeys(
  match: MatchRow,
  variant: ReturnType<typeof resolveMatchVariant>
): MatchStageKey[] {
  const state = match.state_payload ?? {};

  if (variant === 'friendly_party_quiz') {
    const currentQuestion = (state as { currentQuestion?: unknown }).currentQuestion;
    return currentQuestion ? ['party_quiz'] : ['kickoff', 'party_quiz'];
  }

  const possessionState = state as Partial<PossessionStatePayload>;
  if (possessionState.phase === 'HALFTIME') return ['category_ban'];
  if (
    possessionState.phase === 'PENALTY_SHOOTOUT' ||
    possessionState.currentQuestion?.phaseKind === 'penalty'
  ) {
    return ['penalties'];
  }
  if (possessionState.currentQuestion) return ['question'];
  return ['kickoff', 'question'];
}

async function hasReplacementMatchUiSocket(params: {
  match: MatchRow;
  variant: ReturnType<typeof resolveMatchVariant>;
  userId: string;
  socketIds: string[];
}): Promise<boolean> {
  const stageKeys = getPausePresenceStageKeys(params.match, params.variant);
  const presenceResults = await Promise.all(
    stageKeys.map((stageKey) =>
      hasMatchStagePresenceFromSocketIds({
        matchId: params.match.id,
        userId: params.userId,
        stageKey,
        socketIds: params.socketIds,
      })
    )
  );
  return presenceResults.some(Boolean);
}

function possessionTerminalCleanupKeys(matchId: string, roster: PossessionTerminalPlayer[]): string[] {
  return [
    matchPauseKey(matchId),
    matchGraceKey(matchId),
    matchResumeCountdownKey(matchId),
    rankedAiMatchKey(matchId),
    ...roster.flatMap((player) => [
      matchDisconnectKey(matchId, player.user_id),
      matchExitPendingKey(matchId, player.user_id),
      matchPresenceKey(matchId, player.user_id),
      matchReconnectCountKey(matchId, player.user_id),
    ]),
  ];
}

async function cleanupPossessionTerminalRedisKeys(matchId: string, roster: PossessionTerminalPlayer[]): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  await redis.del(possessionTerminalCleanupKeys(matchId, roster));
}

async function emitForfeitFinalResults(
  io: QuizballServer,
  matchId: string,
  resultVersion: number
): Promise<void> {
  const finalPayload = await buildFinalResultsPayload(matchId, resultVersion);
  if (finalPayload) {
    await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
  }
}

// Exported for direct unit testing of the no-contest ticket-refund behavior
// (the full undecidable→abandon path is impractical to drive end-to-end through
// the cache/lock plumbing in an integration mock).
export async function abandonPossessionTerminalMatch(
  io: QuizballServer,
  match: MatchRow,
  roster: PossessionTerminalPlayer[],
  source: string
): Promise<boolean> {
  const abandoned = await abandonMatchWithCompleteLock(match.id);
  if (!abandoned.abandoned) return false;

  cancelPossessionHalftimeTimer(match.id);
  await cleanupPossessionTerminalRedisKeys(match.id, roster);

  // A ranked match that abandons as a no-contest (e.g. both players dropped and
  // progress is undecidable) must refund every human's consumed ranked ticket —
  // the same courtesy the single-forfeiter early-forfeit cancel already gives
  // (match-forfeit.service.ts). Without this a round-1 double-drop silently
  // costs both players a ticket. Best-effort; party-quiz uses its own flow.
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (match.mode === 'ranked' && variant !== 'friendly_party_quiz') {
    const rosterUsers = await usersRepo.getByIds(roster.map((player) => player.user_id));
    // Only refund players whose row resolved AND is explicitly human. An
    // unresolved id (deleted/missing user) is excluded, not assumed human, so a
    // ghost id is never passed to refundRankedTickets.
    const humanUserIds = roster
      .map((player) => rosterUsers.get(player.user_id))
      .filter((user): user is NonNullable<typeof user> => user != null && user.is_ai === false)
      .map((user) => user.id);
    if (humanUserIds.length > 0) {
      try {
        await storeService.refundRankedTickets(humanUserIds);
      } catch (error) {
        logger.warn(
          { error, matchId: match.id, humanUserIds },
          'Failed to refund ranked tickets on no-contest abandon'
        );
      }
    }
  }

  io.to(`match:${match.id}`).emit('error', {
    code: 'MATCH_ABANDONED',
    message: 'Match abandoned because it could not be resolved from active progress',
  });
  logger.info(
    { matchId: match.id, mode: match.mode, source, playerCount: roster.length },
    'Possession match abandoned terminally without RP settlement'
  );
  return true;
}

async function resolvePossessionTerminalAfterDisconnect(params: {
  io: QuizballServer;
  match: MatchRow;
  roster: PossessionTerminalPlayer[];
  cacheSnapshot?: MatchCache | null;
  disconnectedUserIds: string[];
  source: string;
  // When the forfeiter is already DEFINITIVE (e.g. they exceeded the reconnect
  // limit), pass their id here. The resolver then forfeits THAT player directly,
  // skipping the presence-based fork. This is critical: a player who exceeded
  // the limit must lose even if a racing reconnect makes them look "present"
  // again, and even when the opponent is an AI (whose synthetic presence can
  // leave the presence fork unable to isolate a single absent player) — that
  // race let a winning, limit-breaking player WIN from progress instead of
  // forfeiting (the ranked-vs-AI reconnect_limit bug).
  definiteForfeiterUserId?: string;
}): Promise<{ finalized: boolean; abandoned: boolean }> {
  const { io, match, roster, cacheSnapshot, disconnectedUserIds, source, definiteForfeiterUserId } = params;

  // Definitive-forfeiter fast path: the caller already knows who must lose
  // (e.g. reconnect-limit exceeded). Forfeit them directly — do NOT re-derive
  // absence from presence, which is racy (a just-in-time reconnect clears the
  // disconnect marker) and unreliable vs an AI opponent. The opponent (human or
  // AI) is the winner.
  if (definiteForfeiterUserId && roster.some((player) => player.user_id === definiteForfeiterUserId)) {
    const presentForPending = roster.filter((player) => player.user_id !== definiteForfeiterUserId);
    const opponentPendingPayload = buildOpponentForfeitPendingPayload(match.id, 'opponent_reconnect_limit');
    for (const player of presentForPending) {
      io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPendingPayload);
    }
    const finalized = await finalizeMatchAsForfeit({
      matchId: match.id,
      forfeitingUserId: definiteForfeiterUserId,
      activeMatch: match,
      cacheSnapshot,
      cleanupRedisKeys: possessionTerminalCleanupKeys(match.id, roster),
    });
    if (!finalized.completed) return { finalized: false, abandoned: false };
    await emitForfeitFinalResults(io, match.id, finalized.resultVersion);
    logger.info(
      { matchId: match.id, source, forfeitingUserId: definiteForfeiterUserId, winnerId: finalized.winnerId },
      'Disconnect terminal resolver finalized match as forfeit (definitive forfeiter)'
    );
    return { finalized: true, abandoned: false };
  }

  // Forfeit-first: a player who disconnected and never came back must always
  // lose by forfeit, no matter what the score/progress says. The player who
  // stayed must never be penalized for the opponent's disconnect (previously a
  // disconnector ahead on total points was awarded the win via the
  // progress-based decision, e.g. mid-penalty-shootout). Progress-based
  // completion only remains as the fallback when presence cannot identify a
  // single absent player (e.g. both sides gone after a restart).
  // includeUserRoomSockets: a player whose socket re-authenticated (e.g. after
  // a token-refresh reconnect) but never re-entered the match room is online,
  // not absent — they must be credited the forfeit win, not dragged into the
  // progress fallback.
  const presence = await resolveMatchPresence(io, match.id, roster, {
    disconnectedUserIds,
    includeUserRoomSockets: true,
  });
  if (presence.absentPlayers.length === 1 && presence.presentPlayers.length > 0) {
    const forfeitingUserId = presence.absentPlayers[0]?.user_id;
    if (!forfeitingUserId) return { finalized: false, abandoned: false };

    const opponentPendingPayload = buildOpponentForfeitPendingPayload(match.id, 'opponent_reconnect_limit');
    for (const player of presence.presentPlayers) {
      io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPendingPayload);
    }

    const finalized = await finalizeMatchAsForfeit({
      matchId: match.id,
      forfeitingUserId,
      activeMatch: match,
      cacheSnapshot,
      cleanupRedisKeys: possessionTerminalCleanupKeys(match.id, roster),
    });
    if (!finalized.completed) return { finalized: false, abandoned: false };
    await emitForfeitFinalResults(io, match.id, finalized.resultVersion);
    logger.info(
      {
        matchId: match.id,
        source,
        forfeitingUserId,
        winnerId: finalized.winnerId,
        presentUserIds: presence.presentPlayers.map((player) => player.user_id),
      },
      'Disconnect terminal resolver finalized match as forfeit'
    );
    return { finalized: true, abandoned: false };
  }

  const progressResult = await completePossessionMatchFromProgress(io, match.id, source);
  if (progressResult.completed) {
    await cleanupPossessionTerminalRedisKeys(match.id, roster);
    logger.info(
      { matchId: match.id, source, winnerId: progressResult.winnerId, decisionBasis: progressResult.decisionBasis },
      'Disconnect terminal resolver completed match from existing progress'
    );
    return { finalized: true, abandoned: false };
  }
  if (progressResult.reason === 'lock_not_acquired' || progressResult.reason === 'not_active') {
    return { finalized: false, abandoned: false };
  }

  const abandoned = await abandonPossessionTerminalMatch(io, match, roster, source);
  return { finalized: abandoned, abandoned };
}

export function toRemainingReconnects(disconnectCount: number): number {
  return Math.max(0, MAX_MATCH_DISCONNECTS - disconnectCount);
}

export async function getDisconnectCount(matchId: string, userId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;
  const raw = await redis.get(matchReconnectCountKey(matchId, userId));
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function incrementDisconnectCount(matchId: string, userId: string): Promise<number> {
  const redis = getRedisClient();
  if (!redis) return 0;
  const nextCount = (await getDisconnectCount(matchId, userId)) + 1;
  await redis.set(matchReconnectCountKey(matchId, userId), String(nextCount), { EX: FORFEIT_TTL_SEC });
  return nextCount;
}

async function buildRejoinAvailablePayload(
  match: { id: string; mode: 'friendly' | 'ranked'; state_payload: unknown },
  userId: string,
  graceMs: number,
  remainingReconnects: number
): Promise<MatchRejoinAvailablePayload> {
  const opponent = await getOpponentInfo(match.id, userId);
  const players = await matchPlayersRepo.listMatchPlayers(match.id);
  const usersById = await usersRepo.getByIds(players.map((player) => player.user_id));
  const currentCountriesByUserId = await getCurrentCountriesForUsers(players.map((player) => player.user_id));
  return {
    matchId: match.id,
    mode: match.mode,
    variant: resolveMatchVariant(match.state_payload, match.mode),
    opponent,
    participants: players.map((player) => {
      const user = usersById.get(player.user_id);
      return {
        userId: player.user_id,
        username: user?.nickname ?? 'Player',
        avatarUrl: user?.avatar_url ?? null,
        avatarCustomization: parseStoredAvatarCustomization(user?.avatar_customization),
        seat: player.seat,
        ...countryPayload(currentCountriesByUserId.get(player.user_id) ?? user?.country),
      };
    }),
    graceMs,
    remainingReconnects,
  };
}

async function emitRejoinAvailable(
  socket: QuizballSocket,
  match: { id: string; mode: 'friendly' | 'ranked'; state_payload: unknown },
  userId: string,
  graceMs: number,
  remainingReconnects: number
): Promise<void> {
  socket.emit(
    'match:rejoin_available',
    await buildRejoinAvailablePayload(match, userId, graceMs, remainingReconnects)
  );
}

async function emitRejoinAvailableToUser(
  io: QuizballServer,
  match: { id: string; mode: 'friendly' | 'ranked'; state_payload: unknown },
  userId: string,
  graceMs: number,
  remainingReconnects: number
): Promise<void> {
  const payload = await buildRejoinAvailablePayload(match, userId, graceMs, remainingReconnects);
  io.to(`user:${userId}`).emit('match:rejoin_available', payload);
  logger.info(
    {
      eventName: 'match:rejoin_available',
      matchId: match.id,
      userId,
      variant: payload.variant,
      graceMs,
      remainingReconnects,
      source: 'party_replacement_socket',
    },
    'Match rejoin available emitted to user room'
  );
}

export async function handleMatchLeave(
  io: QuizballServer,
  socket: QuizballSocket,
  requestedMatchId: string | null
): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      const activeMatch =
        (requestedMatchId ? await matchesRepo.getMatch(requestedMatchId) : null) ??
        (socket.data.matchId ? await matchesRepo.getMatch(socket.data.matchId) : null) ??
        (await matchesRepo.getActiveMatchForUser(userId));

      if (!activeMatch || activeMatch.status !== 'active') {
        socket.emit('error', {
          code: 'MATCH_NOT_ACTIVE',
          message: 'No active match to leave',
        });
        return;
      }

      const { participants } = await getParticipantSnapshot(activeMatch.id);
      const isParticipant = participants.some((player) => player.user_id === userId);
      if (!isParticipant) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'You are not a participant in this match',
        });
        return;
      }
      const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
      if (variant !== 'friendly_party_quiz') {
        const disconnectedOpponentId = await findOpponentInDisconnectGrace(
          activeMatch.id,
          userId,
          participants
        );
        if (disconnectedOpponentId) {
          await markExcusedExitPending({
            matchId: activeMatch.id,
            userId,
            opponentId: disconnectedOpponentId,
            source: 'match_leave',
          });
          socket.leave(`match:${activeMatch.id}`);
          socket.data.matchId = undefined;
          return;
        }
      }

      if (variant === 'friendly_party_quiz') {
        const partyState = sanitizePartyQuizState(activeMatch.state_payload, activeMatch.total_questions);
        if (isPartyQuizDropped(partyState, userId)) {
          const payload = buildPartyDropoutPayload(activeMatch.id, 'disconnect_timeout');
          await setPartyDropoutPendingForUser(userId, payload);
          socket.emit('match:party_dropout', payload);
          socket.leave(`match:${activeMatch.id}`);
          socket.data.matchId = undefined;
          return;
        }
      }

      const pauseResult = await pauseMatchForDisconnectedPlayer(io, activeMatch.id, userId, {
        ignoreSocketId: socket.id,
        disconnectedConnectedAt: socket.data.connectedAt,
      });

      socket.leave(`match:${activeMatch.id}`);
      socket.data.matchId = undefined;

      if (!pauseResult.finalized) {
        await emitRejoinAvailable(
          socket,
          activeMatch,
          userId,
          pauseResult.graceMs,
          pauseResult.remainingReconnects
        );
      }
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Match transition is in progress. Please retry.',
      operation: 'match:leave',
    }
  );
  if (!completed) return;

  await userSessionGuardService.emitState(io, userId);
}

export async function handleMatchRejoin(
  io: QuizballServer,
  socket: QuizballSocket,
  requestedMatchId: string | null
): Promise<void> {
  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(
    io,
    socket,
    async () => {
      let match = requestedMatchId ? await matchesRepo.getMatch(requestedMatchId) : null;

      if (!match || match.status !== 'active') {
        match = await matchesRepo.getActiveMatchForUser(userId);
      }

      if (!match || match.status !== 'active') {
        socket.emit('error', {
          code: 'MATCH_NOT_ACTIVE',
          message: 'No active match to rejoin',
        });
        return;
      }

      const { participants } = await getParticipantSnapshot(match.id);
      const isParticipant = participants.some((player) => player.user_id === userId);
      if (!isParticipant) {
        socket.emit('error', {
          code: 'MATCH_NOT_ALLOWED',
          message: 'You are not a participant in this match',
        });
        return;
      }
      const variant = resolveMatchVariant(match.state_payload, match.mode);
      if (variant === 'friendly_party_quiz') {
        const partyState = sanitizePartyQuizState(match.state_payload, match.total_questions);
        if (isPartyQuizDropped(partyState, userId)) {
          const payload = buildPartyDropoutPayload(match.id, 'disconnect_timeout');
          await setPartyDropoutPendingForUser(userId, payload);
          socket.emit('match:party_dropout', payload);
          logger.info(
            {
              eventName: 'match:party_dropout',
              matchId: match.id,
              userId,
              reason: payload.reason,
              source: 'rejoin_rejected_dropped',
            },
            'Dropped party quiz player tried to rejoin live match'
          );
          return;
        }
      }

      socket.join(`match:${match.id}`);
      socket.data.matchId = match.id;

      const redis = getRedisClient();
      if (redis) {
        await redis.del(matchExitPendingKey(match.id, userId));
        await redis.set(matchPresenceKey(match.id, userId), '1', { EX: PRESENCE_TTL_SEC });
      }

      const opponent = await getOpponentInfoFromParticipants(participants, userId, match.mode, match.ranked_context);
      const participantPayloads = await buildParticipantPayloads(participants, match.mode, match.ranked_context);
      const mySeat = participants.find((player) => player.user_id === userId)?.seat;
      const categoryName = await resolveMatchCategoryName(match.category_a_id);
      socket.emit('match:start', {
        matchId: match.id,
        mode: match.mode,
        variant,
        mySeat: mySeat ?? undefined,
        opponent,
        participants: participantPayloads,
        ...(categoryName ? { categoryName } : {}),
      });

      const isPaused = redis ? (await redis.exists(matchPauseKey(match.id))) === 1 : false;
      const wasDisconnected = redis ? (await redis.exists(matchDisconnectKey(match.id, userId))) === 1 : false;
      if (redis && isPaused && wasDisconnected) {
        if (variant === 'friendly_party_quiz') {
          logger.info(
            { eventName: 'party_rejoin_resume_requested', matchId: match.id, userId },
            'Party quiz rejoin requested resume'
          );
          await emitPartyQuizStateToSocket(socket, match.id);
        }
        await resumePausedMatch(io, match.id, userId);
        return;
      }

      if (variant === 'friendly_party_quiz') {
        logger.info(
          {
            eventName: 'party_rejoin_live',
            matchId: match.id,
            userId,
            isPaused,
            wasDisconnected,
          },
          'Party quiz live match rejoined'
        );
        await emitPartyQuizStateToSocket(socket, match.id);
        await ensurePartyQuizActiveTimer(io, match.id);
      } else {
        await emitPossessionStateToSocket(socket, match.id);
        await ensurePossessionActiveTimers(io, match.id);
      }
    },
    {
      code: 'TRANSITION_IN_PROGRESS',
      message: 'Match transition is in progress. Please retry.',
      operation: 'match:rejoin',
    }
  );
  if (!completed) return;
  await userSessionGuardService.emitState(io, userId);
}

const MATCH_DISCONNECT_LOCK_ATTEMPTS = 3;
const MATCH_DISCONNECT_LOCK_RETRY_DELAY_MS = 1_000;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startResumeCountdown(params: {
  io: QuizballServer;
  matchId: string;
  notifyUserId?: string | null;
  pauseStartedAtMs: number;
  readyReason: MatchUiReadyDispatchReason;
  missingUserIds: string[];
}): Promise<void> {
  const { io, matchId, notifyUserId, pauseStartedAtMs, readyReason, missingUserIds } = params;
  const redis = getRedisClient();
  if (!redis) return;

  const resumeCountdownMs = harnessDelayMs(MATCH_RESUME_COUNTDOWN_MS);
  const countdownEndsAtMs = Date.now() + resumeCountdownMs;
  const countdownKey = matchResumeCountdownKey(matchId);
  const acquired = await redis.set(countdownKey, String(countdownEndsAtMs), {
    NX: true,
    EX: RESUME_COUNTDOWN_TTL_SEC,
  });

  if (acquired !== 'OK') {
    const rawEndsAt = await redis.get(countdownKey);
    const existingEndsAtMs = Number(rawEndsAt);
    if (Number.isFinite(existingEndsAtMs) && existingEndsAtMs > Date.now()) {
      const nowMs = Date.now();
      const payload = {
        matchId,
        seconds: Math.max(1, Math.ceil((existingEndsAtMs - nowMs) / 1000)),
        startsAt: new Date(existingEndsAtMs).toISOString(),
        serverNow: new Date(nowMs).toISOString(),
        reason: 'resume' as const,
      };
      if (notifyUserId) {
        io.to(`user:${notifyUserId}`).emit('match:countdown', payload);
      } else {
        io.to(`match:${matchId}`).emit('match:countdown', payload);
      }
    }
    return;
  }

  io.to(`match:${matchId}`).emit('match:countdown', {
    matchId,
    seconds: Math.ceil(MATCH_RESUME_COUNTDOWN_MS / 1000),
    startsAt: new Date(countdownEndsAtMs).toISOString(),
    serverNow: new Date().toISOString(),
    reason: 'resume',
  });
  logger.info(
    {
      eventName: 'match:countdown',
      matchId,
      reason: 'resume',
      readyReason,
      missingUserIds,
    },
    'Match resume countdown scheduled'
  );

  // Durable: the countdown completion used to be an in-process setTimeout —
  // a restart in the 5s window stranded the match paused (pause key set, no
  // timer, nothing to re-dispatch the question) until key TTLs / a rejoin /
  // the stale sweeper recovered it. The Redis-backed timer survives restarts;
  // completeResumeCountdown re-checks every condition so a late or duplicate
  // fire is a no-op.
  await scheduleRealtimeTimer(
    'match_resume_countdown',
    matchId,
    new Date(countdownEndsAtMs),
    {
      kind: 'match_resume_countdown',
      matchId,
      pauseStartedAtMs: Number.isFinite(pauseStartedAtMs) && pauseStartedAtMs > 0 ? pauseStartedAtMs : null,
    }
  );
}

export async function handleMatchDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
  const userId = socket.data.user.id;
  const boundMatchId = socket.data.matchId;

  // Fallback: a socket can lose (or never gain) its match binding — e.g. a
  // reconnected socket that re-authenticated but never completed the
  // match:rejoin handshake (diagnosed prod pattern during token-refresh
  // flap storms). Its disconnect previously no-oped silently, so the match
  // never paused and no grace timer was armed. Resolve the user's active
  // match from the DB instead of dropping the event.
  const match = boundMatchId
    ? await matchesRepo.getMatch(boundMatchId)
    : await matchesRepo.getActiveMatchForUser(userId);
  if (!match || match.status !== 'active') return;
  const matchId = match.id;

  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (!boundMatchId) {
    // Fallback is scoped to 1v1 possession variants: their pause flow skips
    // when the user still has a stable live match socket, so a menu/re-auth
    // socket disconnect cannot pause a healthy match. Party quiz has no such
    // guard (its pause flow is variant-gated) — a binding-less disconnect
    // there would arm pause/grace for a live N-player match, so it keeps the
    // old behavior (only bound sockets drive party disconnects).
    if (variant === 'friendly_party_quiz') {
      logger.info(
        { userId, matchId, socketId: socket.id, variant },
        'Match disconnect fallback skipped for party quiz match'
      );
      return;
    }
    logger.info(
      { userId, matchId, socketId: socket.id },
      'Match disconnect resolved active match for socket without match binding'
    );
  }
  // Bounded retry: the per-user transition lock can be busy at the exact
  // moment a socket drops (connect hydration, queue ops). Previously a single
  // failed attempt silently dropped the pause — no grace timer, no opponent
  // banner — leaving the match to the 15-minute sweeper. Everything inside
  // pauseMatchForDisconnectedPlayer re-checks state (match still active,
  // replacement sockets, disconnect-episode dedupe), so a delayed retry is
  // safe even if the player already reconnected.
  for (let attempt = 1; attempt <= MATCH_DISCONNECT_LOCK_ATTEMPTS; attempt += 1) {
    const completed = await userSessionGuardService.runWithUserTransitionLock(io, socket, async () => {
      await pauseMatchForDisconnectedPlayer(io, matchId, userId, {
        ignoreSocketId: socket.id,
        disconnectedConnectedAt: socket.data.connectedAt,
        autoResumeReplacementSocket: true,
      });
    }, {
      operation: 'match:disconnect',
      ...(variant === 'friendly_party_quiz' ? { waitMs: 5000 } : {}),
    });
    if (completed) {
      await userSessionGuardService.emitState(io, userId);
      return;
    }
    if (attempt < MATCH_DISCONNECT_LOCK_ATTEMPTS) {
      await waitMs(MATCH_DISCONNECT_LOCK_RETRY_DELAY_MS * attempt);
      const stillActive = await matchesRepo.getMatch(matchId);
      if (!stillActive || stillActive.status !== 'active') return;
    }
  }
  logger.warn(
    { userId, matchId, socketId: socket.id, attempts: MATCH_DISCONNECT_LOCK_ATTEMPTS },
    'Match disconnect pause abandoned after transition-lock retries'
  );
}

export async function resumePausedMatch(
  io: QuizballServer,
  matchId: string,
  userId: string
): Promise<void> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;

  const redis = getRedisClient();
  if (!redis) return;

  const pauseStartedRaw = await redis.get(matchPauseKey(matchId));
  const pauseStartedAtMs = Number(pauseStartedRaw);

  const roster = await matchPlayersRepo.listMatchPlayers(matchId);
  const disconnectedExists = await Promise.all(
    roster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
  );
  const disconnectedBeforeResume = roster
    .filter((_, index) => disconnectedExists[index])
    .map((player) => player.user_id);
  const userWasDisconnected = disconnectedBeforeResume.includes(userId);

  const otherDisconnected = disconnectedBeforeResume.filter((disconnectedUserId) => disconnectedUserId !== userId);
  if (otherDisconnected.length > 0) {
    if (userWasDisconnected) {
      await redis.del(matchDisconnectKey(matchId, userId));
    }
    const disconnectedOpponentId = otherDisconnected[0];
    if (!disconnectedOpponentId) return;
    const graceMs = await getRemainingDisconnectGraceMs(matchId);
    const remainingReconnects = toRemainingReconnects(
      await getDisconnectCount(matchId, disconnectedOpponentId)
    );
    io.to(`user:${userId}`).emit('match:opponent_disconnected', {
      matchId,
      opponentId: disconnectedOpponentId,
      graceMs,
      remainingReconnects,
    });
    return;
  }

  const reconnectingDisconnectedUserIds = userWasDisconnected ? [userId] : [];

  const exitPendingExists = await Promise.all(
    roster.map((player) => redis.exists(matchExitPendingKey(matchId, player.user_id)))
  );
  const exitPendingUserIds = roster
    .filter((player, index) => player.user_id !== userId && exitPendingExists[index] === 1)
    .map((player) => player.user_id);
  if (exitPendingUserIds.length > 0) {
    await redis.del(matchGraceKey(matchId));
    if (disconnectedBeforeResume.includes(userId)) {
      await redis.del(matchDisconnectKey(matchId, userId));
    }
    for (const exitPendingUserId of exitPendingUserIds) {
      await redis.del(matchExitPendingKey(matchId, exitPendingUserId));
      const pauseResult = await pauseMatchForDisconnectedPlayer(io, matchId, exitPendingUserId);
      if (!pauseResult.finalized) {
        await emitRejoinAvailableToUser(
          io,
          match,
          exitPendingUserId,
          pauseResult.graceMs,
          pauseResult.remainingReconnects
        );
      }
    }
    logger.info(
      { matchId, rejoinedUserId: userId, exitPendingUserIds },
      'Opponent rejoined during grace; converted excused exits into normal disconnect grace'
    );
    return;
  }

  const countdownKey = matchResumeCountdownKey(matchId);
  const rawEndsAt = await redis.get(countdownKey);
  const existingEndsAtMs = Number(rawEndsAt);
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  const activeRoster = variant === 'friendly_party_quiz'
    ? getActivePartyPlayers(roster, sanitizePartyQuizState(match.state_payload, match.total_questions).droppedUserIds)
    : roster;
  const resumeReadyUserIds = await resolveHumanReadyUserIds(matchId, activeRoster.map((player) => player.user_id));
  const dispatchResumeCountdown = (params: { reason: MatchUiReadyDispatchReason; missingUserIds: string[] }) => {
    void (async () => {
      const missingRecoveringUsers = reconnectingDisconnectedUserIds.filter((recoveringUserId) =>
        params.missingUserIds.includes(recoveringUserId)
      );
      if (missingRecoveringUsers.length > 0) {
        const missingRecoveringUserId = missingRecoveringUsers[0];
        if (!missingRecoveringUserId) return;
        const graceMs = await getRemainingDisconnectGraceMs(matchId);
        const remainingReconnects = toRemainingReconnects(
          await getDisconnectCount(matchId, missingRecoveringUserId)
        );
        activeRoster
          .filter((player) => !missingRecoveringUsers.includes(player.user_id))
          .forEach((player) => {
            io.to(`user:${player.user_id}`).emit('match:opponent_disconnected', {
              matchId,
              opponentId: missingRecoveringUserId,
              graceMs,
              remainingReconnects,
            });
          });
        logger.info(
          { matchId, missingRecoveringUsers, readyReason: params.reason },
          'Match resume UI-ready gate timed out before reconnecting player restored match UI'
        );
        return;
      }

      const liveDisconnectedExists = await Promise.all(
        activeRoster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
      );
      const blockingDisconnectedUserIds = activeRoster
        .filter((_, index) => liveDisconnectedExists[index] === 1)
        .map((player) => player.user_id)
        .filter(
          (liveDisconnectedUserId) =>
            !reconnectingDisconnectedUserIds.includes(liveDisconnectedUserId) ||
            params.missingUserIds.includes(liveDisconnectedUserId)
        );
      if (blockingDisconnectedUserIds.length > 0) {
        for (const recoveredUserId of reconnectingDisconnectedUserIds) {
          await redis.del(matchDisconnectKey(matchId, recoveredUserId));
        }
        logger.info(
          { matchId, blockingDisconnectedUserIds, readyReason: params.reason },
          'Match resume UI-ready gate kept grace active because disconnect markers remain'
        );
        return;
      }

      for (const recoveredUserId of reconnectingDisconnectedUserIds) {
        await redis.del(matchDisconnectKey(matchId, recoveredUserId));
      }
      await redis.del(matchGraceKey(matchId));
      // The match resumed before the grace window expired — drop the pending durable
      // forfeit timer so it can't fire after a successful reconnect. (The handler also
      // re-checks the grace key, so this is belt-and-suspenders.)
      await cancelRealtimeTimer('match_disconnect_forfeit', matchId);

      await startResumeCountdown({
        io,
        matchId,
        pauseStartedAtMs,
        readyReason: params.reason,
        missingUserIds: params.missingUserIds,
      });
    })().catch((error) => {
      logger.warn({ error, matchId }, 'Failed to start resume countdown after UI-ready gate');
    });
  };

  if (Number.isFinite(existingEndsAtMs) && existingEndsAtMs > Date.now()) {
    dispatchResumeCountdown({ reason: 'all_ready', missingUserIds: [] });
    return;
  }

  if (resumeReadyUserIds.length > 0) {
    openMatchUiReadyGate({
      io,
      matchId,
      phase: 'resume',
      waitingUserIds: resumeReadyUserIds,
      ceilingMs: harnessDelayMs(MATCH_RESUME_UI_READY_CEILING_MS),
      dispatch: dispatchResumeCountdown,
    });
    logger.info(
      { eventName: 'match:waiting_for_ready', matchId, phase: 'resume', waitingUserIds: resumeReadyUserIds },
      'Match resume waiting for client UI ready'
    );
    return;
  }

  dispatchResumeCountdown({ reason: 'empty', missingUserIds: [] });
}

export async function handleResumeUiReady(
  io: QuizballServer,
  socket: QuizballSocket,
  payload: MatchResumeUiReadyPayload
): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;
  const acknowledged = acknowledgeMatchUiReady(io, userId, payload.matchId, 'resume');
  if (!acknowledged) {
    logger.debug({ eventName: 'match:resume_ui_ready', matchId: payload.matchId, userId }, 'Resume UI-ready ack ignored');
  }
}

/**
 * Complete a resume countdown (fired by the durable realtime timer). Safe to
 * fire late or twice: bails unless the countdown key is still present, the
 * match is still active, and nobody is marked disconnected.
 */
export async function completeResumeCountdown(
  io: QuizballServer,
  matchId: string,
  pauseStartedAtMs: number | null
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  const countdownKey = matchResumeCountdownKey(matchId);
  try {
    const countdownStillActive = (await redis.exists(countdownKey)) === 1;
    if (!countdownStillActive) return;

    const activeMatch = await matchesRepo.getMatch(matchId);
    if (!activeMatch || activeMatch.status !== 'active') {
      await redis.del([countdownKey, matchPauseKey(matchId)]);
      return;
    }

    const roster = await matchPlayersRepo.listMatchPlayers(matchId);
    const stillDisconnected = await Promise.all(
      roster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
    );
    if (stillDisconnected.some((exists) => exists === 1)) {
      await redis.del(countdownKey);
      return;
    }

    await redis.del([matchPauseKey(matchId), matchGraceKey(matchId), countdownKey]);

    const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
    if (variant !== 'friendly_party_quiz'
      && (activeMatch.state_payload as PossessionStatePayload | null | undefined)?.phase === 'HALFTIME') {
      const effectivePauseStartedAtMs = pauseStartedAtMs !== null && Number.isFinite(pauseStartedAtMs) && pauseStartedAtMs > 0
        ? pauseStartedAtMs
        : Date.now();
      const resumedHalftime = await resumePossessionHalftimeAfterPause(
        io,
        matchId,
        effectivePauseStartedAtMs
      );
      if (resumedHalftime) {
        io.to(`match:${matchId}`).emit('match:resume', {
          matchId,
          nextQIndex: activeMatch.current_q_index,
        });
        return;
      }
    }

    const activeQuestion = await matchQuestionsRepo.getMatchQuestion(matchId, activeMatch.current_q_index);
    if (activeQuestion) {
      const effectivePauseStartedAtMs = pauseStartedAtMs !== null && Number.isFinite(pauseStartedAtMs) && pauseStartedAtMs > 0
        ? pauseStartedAtMs
        : Date.now();
      const resumed = variant === 'friendly_party_quiz'
        ? await resumePartyQuizQuestion(io, matchId, activeMatch.current_q_index, effectivePauseStartedAtMs)
        : await resumePossessionMatchQuestion(io, matchId, activeMatch.current_q_index, effectivePauseStartedAtMs);
      if (resumed) {
        io.to(`match:${matchId}`).emit('match:resume', {
          matchId,
          nextQIndex: activeMatch.current_q_index,
        });
        return;
      }
    }

    io.to(`match:${matchId}`).emit('match:resume', {
      matchId,
      nextQIndex: activeMatch.current_q_index,
    });

    if (variant === 'friendly_party_quiz') {
      await sendPartyQuizQuestion(io, matchId, activeMatch.current_q_index);
      return;
    }
    await sendMatchQuestion(io, matchId, activeMatch.current_q_index);
  } catch (err) {
    logger.warn({ err, matchId }, 'Failed to resume paused match after countdown');
  }
}

export async function pauseMatchForDisconnectedPlayer(
  io: QuizballServer,
  matchId: string,
  userId: string,
  options: {
    ignoreSocketId?: string;
    disconnectedConnectedAt?: number;
    autoResumeReplacementSocket?: boolean;
  } = {}
): Promise<{ graceMs: number; remainingReconnects: number; finalized: boolean }> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') {
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: 0,
      finalized: false,
    };
  }
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  appMetrics.matchPauses.add(1, { match_mode: match.mode, variant });

  const redis = getRedisClient();
  if (!redis) {
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: 0,
      finalized: false,
    };
  }

  const exitPending = (await redis.exists(matchExitPendingKey(matchId, userId))) === 1;
  if (exitPending && variant !== 'friendly_party_quiz') {
    logger.info(
      { matchId, userId, variant },
      'Match disconnect pause skipped because user already has an excused exit pending'
    );
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: toRemainingReconnects(await getDisconnectCount(matchId, userId)),
      finalized: false,
    };
  }

  const sockets = await io.in(`match:${matchId}`).fetchSockets();
  const sameUserSockets = sockets.filter(
    (connectedSocket) =>
      connectedSocket.id !== options.ignoreSocketId &&
      connectedSocket.data.user.id === userId
  );
  const replacementSocketIds = sameUserSockets.filter((connectedSocket) => {
    if (typeof options.disconnectedConnectedAt !== 'number') return true;
    const connectedAt = connectedSocket.data.connectedAt;
    return typeof connectedAt === 'number' && connectedAt >= options.disconnectedConnectedAt;
  }).map((connectedSocket) => connectedSocket.id);
  const replacementSocketPresent = replacementSocketIds.length > 0;
  const nowMs = Date.now();
  const stableLiveSocketIds = sameUserSockets.filter((connectedSocket) => {
    if (typeof options.disconnectedConnectedAt === 'number') {
      const connectedAt = connectedSocket.data.connectedAt;
      if (typeof connectedAt === 'number' && connectedAt < options.disconnectedConnectedAt) {
        return false;
      }
    }
    const connectedAt = connectedSocket.data.connectedAt;
    return typeof connectedAt !== 'number' || nowMs - connectedAt >= LIVE_SOCKET_SKIP_PAUSE_MIN_AGE_MS;
  }).map((connectedSocket) => connectedSocket.id);
  const matchUiReplacementSocketPresent = await hasReplacementMatchUiSocket({
    match,
    variant,
    userId,
    socketIds: replacementSocketIds,
  });
  const stableMatchUiSocketPresent = await hasReplacementMatchUiSocket({
    match,
    variant,
    userId,
    socketIds: stableLiveSocketIds,
  });
  if (stableMatchUiSocketPresent && variant !== 'friendly_party_quiz') {
    logger.info(
      {
        matchId,
        userId,
        socketCount: sockets.length,
        sameUserSocketCount: sameUserSockets.length,
        replacementSocketCount: replacementSocketIds.length,
        stableLiveSocketCount: stableLiveSocketIds.length,
      },
      'Match disconnect pause skipped because user still has live match UI presence'
    );
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: toRemainingReconnects(await getDisconnectCount(matchId, userId)),
      finalized: false,
    };
  }

  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const partyState = variant === 'friendly_party_quiz'
    ? sanitizePartyQuizState(match.state_payload, match.total_questions)
    : null;
  if (partyState && isPartyQuizDropped(partyState, userId)) {
    const payload = buildPartyDropoutPayload(matchId, 'disconnect_timeout');
    await setPartyDropoutPendingForUser(userId, payload);
    io.to(`user:${userId}`).emit('match:party_dropout', payload);
    logger.info(
      {
        eventName: 'match:party_dropout',
        matchId,
        userId,
        reason: payload.reason,
        source: 'disconnect_after_drop',
      },
      'Dropped party quiz player disconnected again'
    );
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: 0,
      finalized: false,
    };
  }

  const disconnectedAtMs = Date.now();
  // Do NOT count this as a fresh disconnect when:
  //  (a) the match:disconnect marker is already set — a duplicate handler for the
  //      SAME episode (socket `disconnect` + `match:leave`), which previously
  //      double-counted and forfeited players after only 2 real disconnects; or
  //  (b) a newer same-user socket is already present AND proving live match-UI
  //      presence (matchUiReplacementSocketPresent) — a STALE disconnect for a
  //      socket the user already replaced by reconnecting. A bare user/site
  //      socket is not enough: it can be on the menu while the player is absent
  //      from the actual match UI.
  // The marker is cleared on resume, so a genuinely new disconnect counts again.
  const alreadyDisconnected = (await redis.exists(matchDisconnectKey(matchId, userId))) === 1;
  const skipCount = alreadyDisconnected || matchUiReplacementSocketPresent;
  const disconnectCount = skipCount
    ? await getDisconnectCount(matchId, userId)
    : await incrementDisconnectCount(matchId, userId);
  const remainingReconnects = toRemainingReconnects(disconnectCount);
  logger.info(
    {
      matchId,
      userId,
      variant,
      qIndex: match.current_q_index,
      disconnectCount,
      remainingReconnects,
      alreadyDisconnected,
      replacementSocketPresent,
      matchUiReplacementSocketPresent,
      skippedCount: skipCount,
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      playerCount: players.length,
      activePartyPlayerCount: partyState
        ? getActivePartyPlayers(players, partyState.droppedUserIds).length
        : undefined,
      sameUserSocketCount: sameUserSockets.length,
      stableLiveSocketCount: stableLiveSocketIds.length,
      autoResumeReplacementSocket: Boolean(options.autoResumeReplacementSocket),
    },
    'Match disconnect pause requested'
  );
  await redis.set(matchDisconnectKey(matchId, userId), String(disconnectedAtMs), { EX: DISCONNECT_TTL_SEC });
  if (variant === 'friendly_party_quiz') {
    await redis.set(matchPauseKey(matchId), String(disconnectedAtMs), { NX: true, EX: PRESENCE_TTL_SEC });
  } else {
    await redis.set(matchPauseKey(matchId), String(disconnectedAtMs), { EX: PRESENCE_TTL_SEC });
  }

  if (variant === 'friendly_party_quiz') {
    cancelMatchQuestionTimer(matchId, match.current_q_index);
  } else {
    // Defer — never cancel — the possession question timer on pause. A
    // cancelled timer leaves the round with zero resolvers if the resume never
    // happens; prod audit (Jun 2026) showed matches freezing exactly this way,
    // concentrated on the 50s clue_chain window (~4× MCQ death rate).
    deferPossessionQuestionTimerForPause(matchId, match.current_q_index, PAUSE_QUESTION_BACKSTOP_MS);
  }
  if (variant !== 'friendly_party_quiz') {
    cancelPossessionHalftimeTimer(matchId);
    // Pause checkpoint (db-optimize.md #7): routine rounds no longer persist
    // the full state per round, so flush the live Redis state to Postgres at
    // pause time — the resume/grace/rebuild paths read the DB row and must
    // see the current question index and phase state here.
    fireAndForget('setMatchStatePayload(pauseCheckpoint)', async () => {
      const liveCache = await getMatchCache(matchId);
      if (liveCache && liveCache.status === 'active') {
        await matchesRepo.setMatchStatePayload(matchId, liveCache.statePayload, liveCache.currentQIndex);
      }
    });
  }

  const pauseRecipients = partyState
    ? getActivePartyPlayers(players, partyState.droppedUserIds)
        .filter((player) => player.user_id !== userId)
    : players.filter((player) => player.user_id !== userId);
  pauseRecipients.forEach((player) => {
    io.to(`user:${player.user_id}`).emit('match:opponent_disconnected', {
      matchId,
      opponentId: userId,
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
    });
  });
  if (variant === 'friendly_party_quiz') {
    logger.info(
      {
        eventName: 'match:opponent_disconnected',
        matchId,
        disconnectedUserId: userId,
        recipientUserIds: pauseRecipients.map((player) => player.user_id),
        graceMs: MATCH_DISCONNECT_GRACE_MS,
        remainingReconnects,
      },
      'Party quiz opponent disconnected emitted'
    );
  }
  if (variant === 'friendly_party_quiz' && options.autoResumeReplacementSocket && matchUiReplacementSocketPresent) {
    await emitRejoinAvailableToUser(io, match, userId, MATCH_DISCONNECT_GRACE_MS, remainingReconnects);
  }

  if (disconnectCount > MAX_MATCH_DISCONNECTS) {
    logger.warn(
      {
        matchId,
        userId,
        qIndex: match.current_q_index,
        disconnectCount,
        maxDisconnects: MAX_MATCH_DISCONNECTS,
      },
      'Match reconnect limit exceeded; finalizing as forfeit'
    );
    if (variant === 'friendly_party_quiz') {
      const activeMatch = await matchesRepo.getMatch(matchId);
      if (activeMatch && activeMatch.status === 'active') {
        const pauseStartedRaw = await redis.get(matchPauseKey(matchId));
        const pauseStartedAtMs = Number(pauseStartedRaw);
        const result = await applyPartyQuizDropouts({
          io,
          match: activeMatch,
          players,
          droppedUserIds: [userId],
          reason: 'disconnect_timeout',
          resumeIfContinuing: true,
          pauseStartedAtMs: Number.isFinite(pauseStartedAtMs) ? pauseStartedAtMs : disconnectedAtMs,
        });
        return {
          graceMs: MATCH_DISCONNECT_GRACE_MS,
          remainingReconnects,
          finalized: result.completed,
        };
      }
    }
    const pendingPayload = buildReconnectLimitForfeitPendingPayload(matchId);
    await setForfeitPendingForUser(userId, pendingPayload);
    io.to(`user:${userId}`).emit('match:forfeit_pending', pendingPayload);
    const { participants: roster, cache } = await getParticipantSnapshot(matchId);
    const resolved = await resolvePossessionTerminalAfterDisconnect({
      io,
      match,
      roster,
      cacheSnapshot: cache,
      disconnectedUserIds: [userId],
      source: 'reconnect_limit',
      // The reconnect limit was exceeded by `userId` — they MUST forfeit, even
      // if a racing reconnect makes them look present or the opponent is an AI.
      definiteForfeiterUserId: userId,
    });
    if (resolved.finalized) {
      await redis.del(matchForfeitPendingUserKey(userId));
    }
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
      finalized: resolved.finalized,
    };
  }

  const graceKey = matchGraceKey(matchId);
  const acquired = await redis.set(graceKey, String(Date.now()), { NX: true, EX: GRACE_TTL_SEC });
  if (variant === 'friendly_party_quiz') {
    logger.info(
      {
        eventName: 'party_grace_window',
        matchId,
        userId,
        acquired: acquired === 'OK',
        graceMs: MATCH_DISCONNECT_GRACE_MS,
      },
      acquired === 'OK' ? 'Party quiz shared grace window started' : 'Party quiz shared grace window already active'
    );
  }
  if (variant !== 'friendly_party_quiz' && options.autoResumeReplacementSocket && matchUiReplacementSocketPresent) {
    logger.info(
      { matchId, userId, socketCount: sameUserSockets.length },
      'Auto-resuming match after fast socket replacement'
    );
    await resumePausedMatch(io, matchId, userId);
  }
  if (acquired !== 'OK') {
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
      finalized: false,
    };
  }

  // Durable: the grace-expiry forfeit is scheduled on the Redis sorted-set timer
  // (the same mechanism question/halftime timers use) instead of an in-process
  // setTimeout. This survives a backend restart mid-grace — previously a restart
  // dropped the timer and orphaned the match in `status='active'` forever.
  await scheduleRealtimeTimer(
    'match_disconnect_forfeit',
    matchId,
    new Date(Date.now() + MATCH_DISCONNECT_GRACE_MS),
    { kind: 'match_disconnect_forfeit', matchId, disconnectedUserId: userId }
  );

  return {
    graceMs: MATCH_DISCONNECT_GRACE_MS,
    remainingReconnects,
    finalized: false,
  };
}

/**
 * Run when a disconnect grace window expires (fired by the durable realtime
 * timer scheduler). Resolves the match: drops party-quiz players, abandons /
 * forfeits when everyone is gone, or forfeits the disconnected side so the
 * present player is credited the win. Re-checks all state, so it is safe to
 * fire late (e.g. after a restart replays an overdue timer) and idempotent
 * against the `status='active'` guards in the finalize paths it calls.
 */
export async function resolveExpiredGraceWindow(
  io: QuizballServer,
  matchId: string,
  _disconnectedUserId: string
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const graceStillActive = (await redis.exists(matchGraceKey(matchId))) === 1;
    if (!graceStillActive) return;

    const activeMatch = await matchesRepo.getMatch(matchId);
    if (!activeMatch || activeMatch.status !== 'active') return;

    const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);

    const roster = await matchPlayersRepo.listMatchPlayers(matchId);
    const disconnectedExists = await Promise.all(
      roster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
    );
    const disconnected = roster
      .filter((_, index) => disconnectedExists[index])
      .map((player) => player.user_id);

    if (disconnected.length === 0) {
      // Everyone reconnected before the grace expired. The finally below
      // still clears the pause key, but the pause path cancelled the durable
      // question timer — if the resume flow lost the race (e.g. under
      // reconnect flapping), nothing would ever resolve the current round.
      // Re-arm (or immediately resolve an expired) question timer so the
      // match can never silently freeze here.
      // Party quiz intentionally skips this: it uses a shared NX pause window
      // and its own rejoin/resume flow (resumePartyQuizQuestion /
      // ensurePartyQuizActiveTimer) re-arms timers on reconnect; this fix is
      // scoped to the possession freeze, where the diagnosed race lives.
      if (variant !== 'friendly_party_quiz') {
        await redis.del(matchGraceKey(matchId));
        await redis.del(matchPauseKey(matchId));
        const ensured = await ensurePossessionActiveTimers(io, matchId);
        logger.info(
          { matchId, ensured, disconnectedUserIds: disconnected },
          'Grace expired with all players reconnected; ensured possession timers'
        );
      }
      return;
    }

    if (variant === 'friendly_party_quiz') {
      const state = sanitizePartyQuizState(activeMatch.state_payload, activeMatch.total_questions);
      const newlyDropped = disconnected.filter((droppedUserId) =>
        !isPartyQuizDropped(state, droppedUserId)
      );
      if (newlyDropped.length === 0) {
        logger.info(
          {
            eventName: 'party_grace_expired_noop',
            matchId,
            disconnectedUserIds: disconnected,
            droppedUserIds: state.droppedUserIds,
          },
          'Party quiz grace expired but disconnected users were already dropped'
        );
        return;
      }
      const pauseStartedRaw = await redis.get(matchPauseKey(matchId));
      const pauseStartedAtMs = Number(pauseStartedRaw);
      logger.info(
        {
          eventName: 'party_grace_expired',
          matchId,
          disconnectedUserIds: disconnected,
          newlyDroppedUserIds: newlyDropped,
          droppedUserIds: state.droppedUserIds,
          playerCount: roster.length,
        },
        'Party quiz grace expired; applying dropouts'
      );
      await applyPartyQuizDropouts({
        io,
        match: activeMatch,
        players: roster,
        droppedUserIds: newlyDropped,
        reason: 'disconnect_timeout',
        resumeIfContinuing: true,
        pauseStartedAtMs: Number.isFinite(pauseStartedAtMs) ? pauseStartedAtMs : Date.now(),
      });
      return;
    }

    // Forfeit finalization persists final totals from the cache snapshot;
    // without it the last answers before the disconnect could be lost.
    const cacheSnapshot = await getMatchCache(matchId);
    await resolvePossessionTerminalAfterDisconnect({
      io,
      match: activeMatch,
      roster,
      cacheSnapshot,
      disconnectedUserIds: disconnected,
      source: 'disconnect_grace_expired',
    });
  } catch (err) {
    logger.warn({ err, matchId }, 'Grace expiry handler failed');
  } finally {
    await redis.del(matchGraceKey(matchId));
    await redis.del(matchPauseKey(matchId));
  }
}
