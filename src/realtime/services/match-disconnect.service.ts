import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchQuestionsRepo } from '../../modules/matches/match-questions.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { objectivesService } from '../../modules/objectives/index.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { parseStoredAvatarCustomization } from '../../modules/users/avatar-customization.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { rankedAiMatchKey } from '../ai-ranked.constants.js';
import { deleteMatchCache } from '../match-cache.js';
import {
  QUESTION_TIME_MS,
  cancelMatchQuestionTimer,
  sendMatchQuestion,
} from '../match-flow.js';
import {
  lastMatchKey,
  matchDisconnectKey,
  matchForfeitPendingUserKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import { buildStandings } from '../match-utils.js';
import {
  cancelPossessionHalftimeTimer,
  emitPossessionStateToSocket,
  ensurePossessionActiveTimers,
  resumePossessionMatchQuestion,
} from '../possession-match-flow.js';
import {
  emitPartyQuizStateToSocket,
  ensurePartyQuizActiveTimer,
  resumePartyQuizQuestion,
} from '../party-quiz-match-flow.js';
import { getRedisClient } from '../redis.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';
import {
  buildOpponentForfeitPendingPayload,
  buildReconnectLimitForfeitPendingPayload,
  finalizeMatchAsForfeit,
  matchForfeitKey,
  setForfeitPendingForUser,
} from './match-forfeit.service.js';
import {
  buildParticipantPayloads,
  getOpponentInfo,
  getOpponentInfoFromParticipants,
  getParticipantSnapshot,
  resolveMatchCategoryName,
} from './match-participants.helpers.js';
import { userSessionGuardService } from './user-session-guard.service.js';

const MATCH_DISCONNECT_GRACE_MS = 60000;
const MAX_MATCH_DISCONNECTS = 3;
const MATCH_RESUME_COUNTDOWN_MS = 5000;
const PRESENCE_TTL_SEC = 75;
const DISCONNECT_TTL_SEC = 75;
const GRACE_TTL_SEC = 65;
const RESUME_COUNTDOWN_TTL_SEC = 15;
const FORFEIT_TTL_SEC = 600;

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

async function emitRejoinAvailable(
  socket: QuizballSocket,
  match: { id: string; mode: 'friendly' | 'ranked'; state_payload: unknown },
  userId: string,
  graceMs: number,
  remainingReconnects: number
): Promise<void> {
  const opponent = await getOpponentInfo(match.id, userId);
  const players = await matchPlayersRepo.listMatchPlayers(match.id);
  const usersById = await usersRepo.getByIds(players.map((player) => player.user_id));
  socket.emit('match:rejoin_available', {
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
      };
    }),
    graceMs,
    remainingReconnects,
  });
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

      const pauseResult = await pauseMatchForDisconnectedPlayer(io, activeMatch.id, userId);

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

      socket.join(`match:${match.id}`);
      socket.data.matchId = match.id;

      const redis = getRedisClient();
      if (redis) {
        await redis.set(matchPresenceKey(match.id, userId), '1', { EX: PRESENCE_TTL_SEC });
      }

      const opponent = await getOpponentInfoFromParticipants(participants, userId, match.mode, match.ranked_context);
      const participantPayloads = await buildParticipantPayloads(participants, match.mode, match.ranked_context);
      const mySeat = participants.find((player) => player.user_id === userId)?.seat;
      const variant = resolveMatchVariant(match.state_payload, match.mode);
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
        await resumePausedMatch(io, match.id, userId);
        return;
      }

      if (variant === 'friendly_party_quiz') {
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

export async function handleMatchDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
  const matchId = socket.data.matchId;
  if (!matchId) return;

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active') return;

  const userId = socket.data.user.id;
  const completed = await userSessionGuardService.runWithUserTransitionLock(io, socket, async () => {
    await pauseMatchForDisconnectedPlayer(io, matchId, userId);
  }, {
    operation: 'match:disconnect',
  });
  if (!completed) return;
  await userSessionGuardService.emitState(io, userId);
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
  await redis.del(matchDisconnectKey(matchId, userId));

  const roster = await matchPlayersRepo.listMatchPlayers(matchId);
  const stillDisconnectedExists = await Promise.all(
    roster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
  );
  const stillDisconnected = roster
    .filter((_, index) => stillDisconnectedExists[index])
    .map((player) => player.user_id);

  if (stillDisconnected.length > 0) {
    const ttl = await redis.ttl(matchGraceKey(matchId));
    const graceMs = ttl > 0 ? ttl * 1000 : MATCH_DISCONNECT_GRACE_MS;
    const remainingReconnects = toRemainingReconnects(
      await getDisconnectCount(matchId, stillDisconnected[0] ?? userId)
    );
    io.to(`user:${userId}`).emit('match:opponent_disconnected', {
      matchId,
      opponentId: stillDisconnected[0],
      graceMs,
      remainingReconnects,
    });
    return;
  }

  await redis.del(matchGraceKey(matchId));

  const countdownEndsAtMs = Date.now() + MATCH_RESUME_COUNTDOWN_MS;
  const countdownKey = matchResumeCountdownKey(matchId);
  const acquired = await redis.set(countdownKey, String(countdownEndsAtMs), {
    NX: true,
    EX: RESUME_COUNTDOWN_TTL_SEC,
  });

  if (acquired !== 'OK') {
    const rawEndsAt = await redis.get(countdownKey);
    const existingEndsAtMs = Number(rawEndsAt);
    if (Number.isFinite(existingEndsAtMs) && existingEndsAtMs > Date.now()) {
      io.to(`user:${userId}`).emit('match:countdown', {
        matchId,
        seconds: Math.max(1, Math.ceil((existingEndsAtMs - Date.now()) / 1000)),
        startsAt: new Date(existingEndsAtMs).toISOString(),
        reason: 'resume',
      });
    }
    return;
  }

  io.to(`match:${matchId}`).emit('match:countdown', {
    matchId,
    seconds: Math.ceil(MATCH_RESUME_COUNTDOWN_MS / 1000),
    startsAt: new Date(countdownEndsAtMs).toISOString(),
    reason: 'resume',
  });

  setTimeout(() => {
    void (async () => {
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

        io.to(`match:${matchId}`).emit('match:resume', {
          matchId,
          nextQIndex: activeMatch.current_q_index,
        });

        const activeQuestion = await matchQuestionsRepo.getMatchQuestion(matchId, activeMatch.current_q_index);
        if (activeQuestion) {
          const effectivePauseStartedAtMs = Number.isFinite(pauseStartedAtMs) && pauseStartedAtMs > 0
            ? pauseStartedAtMs
            : Date.now();
          const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
          const resumed = variant === 'friendly_party_quiz'
            ? await resumePartyQuizQuestion(io, matchId, activeMatch.current_q_index, effectivePauseStartedAtMs)
            : await resumePossessionMatchQuestion(io, matchId, activeMatch.current_q_index, effectivePauseStartedAtMs);
          if (resumed) return;
        }
        await sendMatchQuestion(io, matchId, activeMatch.current_q_index);
      } catch (err) {
        logger.warn({ err, matchId }, 'Failed to resume paused match after countdown');
      }
    })();
  }, MATCH_RESUME_COUNTDOWN_MS);
}

export async function pauseMatchForDisconnectedPlayer(
  io: QuizballServer,
  matchId: string,
  userId: string
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

  const sockets = await io.in(`match:${matchId}`).fetchSockets();
  const stillPresent = sockets.some((connectedSocket) => connectedSocket.data.user.id === userId);
  if (stillPresent) {
    logger.info(
      { matchId, userId, socketCount: sockets.length },
      'Match disconnect pause skipped because user still has a live match socket'
    );
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects: toRemainingReconnects(await getDisconnectCount(matchId, userId)),
      finalized: false,
    };
  }

  const disconnectedAtMs = Date.now();
  const disconnectCount = await incrementDisconnectCount(matchId, userId);
  const remainingReconnects = toRemainingReconnects(disconnectCount);
  logger.info(
    {
      matchId,
      userId,
      qIndex: match.current_q_index,
      disconnectCount,
      remainingReconnects,
      graceMs: MATCH_DISCONNECT_GRACE_MS,
    },
    'Match disconnect pause requested'
  );
  await redis.set(matchDisconnectKey(matchId, userId), String(disconnectedAtMs), { EX: DISCONNECT_TTL_SEC });
  await redis.set(matchPauseKey(matchId), String(disconnectedAtMs), { EX: PRESENCE_TTL_SEC });

  cancelMatchQuestionTimer(matchId, match.current_q_index);
  if (variant !== 'friendly_party_quiz') {
    cancelPossessionHalftimeTimer(matchId);
  }

  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const remainingPlayers = players.filter((player) => player.user_id !== userId);
  remainingPlayers.forEach((player) => {
    io.to(`user:${player.user_id}`).emit('match:opponent_disconnected', {
      matchId,
      opponentId: userId,
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
    });
  });

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
    const pendingPayload = buildReconnectLimitForfeitPendingPayload(matchId);
    await setForfeitPendingForUser(userId, pendingPayload);
    io.to(`user:${userId}`).emit('match:forfeit_pending', pendingPayload);
    const { participants: roster, cache } = await getParticipantSnapshot(matchId);
    const opponentPendingPayload = buildOpponentForfeitPendingPayload(matchId, 'opponent_reconnect_limit');
    for (const player of roster) {
      if (player.user_id === userId) continue;
      io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPendingPayload);
    }
    const cleanupKeys = [
      matchPauseKey(matchId),
      matchGraceKey(matchId),
      matchResumeCountdownKey(matchId),
      ...roster.flatMap((player) => [
        matchDisconnectKey(matchId, player.user_id),
        matchPresenceKey(matchId, player.user_id),
        matchReconnectCountKey(matchId, player.user_id),
      ]),
      rankedAiMatchKey(matchId),
    ];
    const finalized = await finalizeMatchAsForfeit({
      matchId,
      forfeitingUserId: userId,
      activeMatch: match,
      cacheSnapshot: cache,
      cleanupRedisKeys: cleanupKeys,
    });
    const finalPayload = await buildFinalResultsPayload(matchId, finalized.resultVersion);
    if (finalPayload) {
      await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
    }
    await redis.del(cleanupKeys);
    await redis.del(matchForfeitPendingUserKey(userId));
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
      finalized: true,
    };
  }

  const graceKey = matchGraceKey(matchId);
  const acquired = await redis.set(graceKey, String(Date.now()), { NX: true, EX: GRACE_TTL_SEC });
  if (acquired !== 'OK') {
    return {
      graceMs: MATCH_DISCONNECT_GRACE_MS,
      remainingReconnects,
      finalized: false,
    };
  }

  setTimeout(async () => {
    try {
      const graceStillActive = (await redis.exists(matchGraceKey(matchId))) === 1;
      if (!graceStillActive) return;

      const activeMatch = await matchesRepo.getMatch(matchId);
      if (!activeMatch || activeMatch.status !== 'active') return;

      const roster = await matchPlayersRepo.listMatchPlayers(matchId);
      const disconnectedExists = await Promise.all(
        roster.map((player) => redis.exists(matchDisconnectKey(matchId, player.user_id)))
      );
      const disconnected = roster
        .filter((_, index) => disconnectedExists[index])
        .map((player) => player.user_id);

      if (disconnected.length === 0) return;

      if (disconnected.length === roster.length) {
        if (activeMatch.mode === 'ranked') {
          const finalized = await finalizeMatchAsForfeit({
            matchId,
            forfeitingUserId: userId,
            activeMatch,
            cleanupRedisKeys: [
              rankedAiMatchKey(matchId),
              ...roster.flatMap((player) => [
                matchDisconnectKey(matchId, player.user_id),
                matchPresenceKey(matchId, player.user_id),
                matchReconnectCountKey(matchId, player.user_id),
              ]),
            ],
          });
          if (finalized.completed) {
            const finalPayload = await buildFinalResultsPayload(matchId, finalized.resultVersion);
            if (finalPayload) {
              await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
            }
            return;
          }
        }

        await matchesService.abandonMatch(matchId);
        await deleteMatchCache(matchId);
        if (variant !== 'friendly_party_quiz') {
          cancelPossessionHalftimeTimer(matchId);
        }
        io.to(`match:${matchId}`).emit('error', {
          code: 'MATCH_ABANDONED',
          message: 'Match abandoned because all players disconnected',
        });
        await redis.del(rankedAiMatchKey(matchId));
        await Promise.all(
          roster.map((player) =>
            redis.set(lastMatchKey(player.user_id), matchId, { EX: FORFEIT_TTL_SEC })
          )
        );
        await redis.del(matchPauseKey(matchId));
        return;
      }

      const winnerId =
        variant === 'friendly_party_quiz'
          ? buildStandings(
              (await matchPlayersRepo.listMatchPlayers(matchId)).filter((player) => !disconnected.includes(player.user_id))
            )[0]?.userId ?? null
          : roster.find((player) => !disconnected.includes(player.user_id))?.user_id ?? null;
      const opponentPendingPayload = buildOpponentForfeitPendingPayload(matchId, 'opponent_reconnect_limit');
      for (const player of roster) {
        if (disconnected.includes(player.user_id)) continue;
        io.to(`user:${player.user_id}`).emit('match:forfeit_pending', opponentPendingPayload);
      }
      if (winnerId && variant !== 'friendly_party_quiz') {
        const fullPoints = Math.floor((QUESTION_TIME_MS / 1000) * 10 * activeMatch.total_questions);
        const fullCorrectAnswers = activeMatch.total_questions;

        // Fetch current player stats to compute max values (business logic in service)
        const players = await matchPlayersRepo.listMatchPlayers(matchId);
        const winnerPlayer = players.find((p) => p.user_id === winnerId);
        const currentPoints = winnerPlayer?.total_points ?? 0;
        const currentCorrect = winnerPlayer?.correct_answers ?? 0;

        // Apply max logic here instead of in SQL
        const finalPoints = Math.max(currentPoints, fullPoints);
        const finalCorrect = Math.max(currentCorrect, fullCorrectAnswers);

        await matchPlayersRepo.setPlayerForfeitWinTotals(
          matchId,
          winnerId,
          finalPoints,
          finalCorrect
        );
      }

      // Mark decision method as forfeit before completing
      const statePayload = (activeMatch.state_payload ?? {}) as Record<string, unknown>;
      await matchesRepo.setMatchStatePayload(matchId, {
        ...statePayload,
        winnerDecisionMethod: 'forfeit',
      });

      await matchesService.completeMatch(matchId, winnerId);
      await deleteMatchCache(matchId);
      if (variant !== 'friendly_party_quiz') {
        cancelPossessionHalftimeTimer(matchId);
      }

      if (activeMatch.mode === 'ranked') {
        try { await rankedService.settleCompletedRankedMatch(matchId); }
        catch (err) { logger.warn({ err, matchId }, 'Ranked settlement failed in grace expiry'); }
      }

      try { await progressionService.awardCompletedMatchXp(matchId); }
      catch (err) { logger.warn({ err, matchId }, 'Match XP award failed in grace expiry'); }

      try { await objectivesService.evaluateForMatchBestEffort(matchId); }
      catch (err) { logger.warn({ err, matchId }, 'Objectives evaluation failed in grace expiry'); }

      const avgTimes = await matchesService.computeAvgTimes(matchId);
      for (const player of roster) {
        await matchPlayersRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
      }

      const resultVersion = Date.now();
      const finalPayload = await buildFinalResultsPayload(matchId, resultVersion);

      await redis.del(rankedAiMatchKey(matchId));
      await redis.set(matchForfeitKey(matchId), winnerId ?? 'draw', { EX: FORFEIT_TTL_SEC });
      await Promise.all(
        roster.map((player) =>
          redis.set(
            lastMatchKey(player.user_id),
            JSON.stringify({ matchId, resultVersion }),
            { EX: FORFEIT_TTL_SEC }
          )
        )
      );
      if (finalPayload) {
        await emitFinalResultsToMatchParticipants(io, matchId, finalPayload);
      }
    } finally {
      await redis.del(matchGraceKey(matchId));
      await redis.del(matchPauseKey(matchId));
    }
  }, MATCH_DISCONNECT_GRACE_MS);

  return {
    graceMs: MATCH_DISCONNECT_GRACE_MS,
    remainingReconnects,
    finalized: false,
  };
}
