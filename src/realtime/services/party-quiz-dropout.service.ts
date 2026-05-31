import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import type { MatchPlayerRow, MatchRow } from '../../modules/matches/matches.types.js';
import { objectivesService } from '../../modules/objectives/index.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { cancelMatchQuestionTimer } from '../match-flow.js';
import { deleteMatchCache } from '../match-cache.js';
import { acquireLock, releaseLock } from '../locks.js';
import {
  lastMatchKey,
  matchDisconnectKey,
  matchGraceKey,
  matchPartyDropoutPendingUserKey,
  matchPauseKey,
  matchPresenceKey,
  matchReconnectCountKey,
  matchResumeCountdownKey,
} from '../match-keys.js';
import { buildStandings, bumpStateVersion } from '../match-utils.js';
import {
  emitPartyQuizState,
  resumePartyQuizQuestion,
  sendPartyQuizQuestion,
} from '../party-quiz-match-flow.js';
import {
  getActivePartyPlayers,
  sanitizePartyQuizState,
} from '../party-quiz-state.js';
import { getRedisClient } from '../redis.js';
import type { MatchForfeitPendingPayload, MatchPartyDropoutPayload } from '../socket.types.js';
import {
  buildFinalResultsPayload,
  emitFinalResultsToMatchParticipants,
} from './match-final-results.service.js';

const FORFEIT_TTL_SEC = 600;
const PARTY_DROPOUT_PENDING_TTL_SEC = 600;

export type PartyDropoutReason = 'disconnect_timeout' | 'self_forfeit';

export function buildPartyDropoutPayload(
  matchId: string,
  reason: PartyDropoutReason
): MatchPartyDropoutPayload {
  return {
    matchId,
    reason,
    message: reason === 'self_forfeit'
      ? 'You left this party quiz. You can view the results when it ends.'
      : 'You did not reconnect in time. You can view the results when it ends.',
  };
}

function buildPartyOpponentForfeitPendingPayload(
  matchId: string,
  reason: PartyDropoutReason
): MatchForfeitPendingPayload {
  const pendingReason = reason === 'self_forfeit' ? 'opponent_forfeit' : 'opponent_reconnect_limit';
  return {
    matchId,
    reason: pendingReason,
    message: pendingReason === 'opponent_forfeit'
      ? 'Opponent forfeited. Finalizing results...'
      : 'Opponent did not reconnect in time. Finalizing results...',
  };
}

function emitPartyOpponentForfeitPending(
  io: QuizballServer,
  matchId: string,
  activePlayers: MatchPlayerRow[],
  reason: PartyDropoutReason
): void {
  const payload = buildPartyOpponentForfeitPendingPayload(matchId, reason);
  for (const player of activePlayers) {
    io.to(`user:${player.user_id}`).emit('match:forfeit_pending', payload);
  }
  logger.info(
    {
      eventName: 'match:forfeit_pending',
      matchId,
      recipientUserIds: activePlayers.map((player) => player.user_id),
      reason: payload.reason,
      source: 'party_dropout',
    },
    'Party quiz opponent forfeit pending emitted'
  );
}

function parsePartyDropoutPayload(raw: string): MatchPartyDropoutPayload | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MatchPartyDropoutPayload>;
    if (
      typeof parsed.matchId !== 'string' ||
      !(parsed.reason === 'disconnect_timeout' || parsed.reason === 'self_forfeit')
    ) {
      return null;
    }
    return {
      matchId: parsed.matchId,
      reason: parsed.reason,
      message: typeof parsed.message === 'string'
        ? parsed.message
        : buildPartyDropoutPayload(parsed.matchId, parsed.reason).message,
    };
  } catch {
    return null;
  }
}

export async function setPartyDropoutPendingForUser(
  userId: string,
  payload: MatchPartyDropoutPayload
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.set(matchPartyDropoutPendingUserKey(userId), JSON.stringify(payload), {
    EX: PARTY_DROPOUT_PENDING_TTL_SEC,
  });
}

export async function emitPendingPartyDropoutIfAny(socket: QuizballSocket): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const raw = await redis.get(matchPartyDropoutPendingUserKey(socket.data.user.id));
  if (!raw) return;
  const payload = parsePartyDropoutPayload(raw);
  if (!payload) {
    await redis.del(matchPartyDropoutPendingUserKey(socket.data.user.id));
    return;
  }
  socket.emit('match:party_dropout', payload);
  logger.info(
    {
      eventName: 'match:party_dropout',
      matchId: payload.matchId,
      userId: socket.data.user.id,
      reason: payload.reason,
      source: 'pending_replay',
    },
    'Pending party dropout emitted to reconnecting socket'
  );
}

async function completePartyQuizDropoutMatch(params: {
  io: QuizballServer;
  match: MatchRow;
  players: MatchPlayerRow[];
  winnerId: string | null;
  winnerDecisionMethod: 'forfeit' | 'total_points';
}): Promise<void> {
  const { io, match, players, winnerId, winnerDecisionMethod } = params;
  const state = sanitizePartyQuizState(match.state_payload, match.total_questions);
  state.currentQuestion = null;
  state.answeredUserIds = [];
  state.winnerDecisionMethod = winnerDecisionMethod;
  bumpStateVersion(state);
  logger.info(
    {
      eventName: 'party_dropout_match_complete',
      matchId: match.id,
      winnerId,
      winnerDecisionMethod,
      playerCount: players.length,
      droppedUserIds: state.droppedUserIds,
      currentQIndex: match.current_q_index,
      totalQuestions: match.total_questions,
    },
    'Party quiz dropout completion started'
  );

  cancelMatchQuestionTimer(match.id, match.current_q_index);
  await matchesRepo.setMatchStatePayload(match.id, state, match.current_q_index);
  await matchesService.completeMatch(match.id, winnerId);
  await deleteMatchCache(match.id);

  try {
    const avgTimes = await matchesService.computeAvgTimes(match.id);
    await Promise.all(
      players.map((player) =>
        matchPlayersRepo.updatePlayerAvgTime(match.id, player.user_id, avgTimes.get(player.user_id) ?? null)
      )
    );
  } catch (error) {
    logger.warn({ error, matchId: match.id }, 'Party dropout avg-time update failed');
  }

  try { await progressionService.awardCompletedMatchXp(match.id); }
  catch (error) { logger.warn({ error, matchId: match.id }, 'Party dropout XP award failed'); }

  try { await objectivesService.evaluateForMatchBestEffort(match.id); }
  catch (error) { logger.warn({ error, matchId: match.id }, 'Party dropout objectives evaluation failed'); }

  const resultVersion = Date.now();
  const redis = getRedisClient();
  if (redis) {
    await redis.del([
      matchPauseKey(match.id),
      matchGraceKey(match.id),
      matchResumeCountdownKey(match.id),
      ...players.flatMap((player) => [
        matchDisconnectKey(match.id, player.user_id),
        matchPresenceKey(match.id, player.user_id),
        matchReconnectCountKey(match.id, player.user_id),
        matchPartyDropoutPendingUserKey(player.user_id),
      ]),
    ]);
    await Promise.all(
      players.map((player) =>
        redis.set(
          lastMatchKey(player.user_id),
          JSON.stringify({ matchId: match.id, resultVersion }),
          { EX: FORFEIT_TTL_SEC }
        )
      )
    );
  }

  const finalPayload = await buildFinalResultsPayload(match.id, resultVersion);
  if (finalPayload) {
    await emitFinalResultsToMatchParticipants(io, match.id, finalPayload);
    logger.info(
      {
        eventName: 'match:final_results',
        matchId: match.id,
        resultVersion,
        winnerId: finalPayload.winnerId,
        winnerDecisionMethod: finalPayload.winnerDecisionMethod,
        source: 'party_dropout',
      },
      'Party quiz dropout final results emitted'
    );
  }
}

export async function applyPartyQuizDropouts(params: {
  io: QuizballServer;
  match: MatchRow;
  players: MatchPlayerRow[];
  droppedUserIds: string[];
  reason: PartyDropoutReason;
  resumeIfContinuing: boolean;
  pauseStartedAtMs?: number | null;
}): Promise<{ completed: boolean; continued: boolean; activeCount: number }> {
  const { io, match, players: initialPlayers, droppedUserIds, reason } = params;
  if (resolveMatchVariant(match.state_payload, match.mode) !== 'friendly_party_quiz') {
    return { completed: false, continued: false, activeCount: initialPlayers.length };
  }
  logger.info(
    {
      eventName: 'party_dropouts_requested',
      matchId: match.id,
      requestedDroppedUserIds: droppedUserIds,
      reason,
      resumeIfContinuing: params.resumeIfContinuing,
    },
    'Party quiz dropouts requested'
  );

  // Serialize the read-modify-write of droppedUserIds + the completion/resume
  // logic: concurrent dropouts (two disconnects, or a disconnect-timeout racing
  // a self-forfeit) would otherwise read the same state_payload and clobber each
  // other's writes / double-complete the match.
  const lockKey = `lock:match:${match.id}:party-dropout`;
  const lock = await acquireLock(lockKey, 15_000);
  if (!lock.acquired || !lock.token) {
    logger.warn(
      { eventName: 'party_dropouts_skipped', matchId: match.id, reason: 'lock_not_acquired', requestedDroppedUserIds: droppedUserIds },
      'Party quiz dropouts skipped'
    );
    return { completed: false, continued: false, activeCount: initialPlayers.length };
  }

  try {
    const lockedMatch = await matchesRepo.getMatch(match.id);
    if (!lockedMatch || lockedMatch.status !== 'active') {
      logger.info(
        { eventName: 'party_dropouts_skipped', matchId: match.id, reason: 'match_not_active', status: lockedMatch?.status ?? null },
        'Party quiz dropouts skipped'
      );
      return { completed: false, continued: false, activeCount: 0 };
    }
    if (resolveMatchVariant(lockedMatch.state_payload, lockedMatch.mode) !== 'friendly_party_quiz') {
      return { completed: false, continued: false, activeCount: initialPlayers.length };
    }

    const players = await matchPlayersRepo.listMatchPlayers(lockedMatch.id);
    const playerIds = new Set(players.map((player) => player.user_id));
    const requestedDroppedUserIds = [...new Set(droppedUserIds)].filter((userId) => playerIds.has(userId));
    const state = sanitizePartyQuizState(lockedMatch.state_payload, lockedMatch.total_questions);
    const alreadyDroppedUserIds = new Set(state.droppedUserIds);
    const newlyDroppedUserIds = requestedDroppedUserIds.filter((userId) => !alreadyDroppedUserIds.has(userId));
    const nextDroppedUserIds = [
      ...new Set([
        ...state.droppedUserIds,
        ...requestedDroppedUserIds,
      ]),
    ];
    const redis = getRedisClient();
    if (newlyDroppedUserIds.length === 0) {
      if (redis && requestedDroppedUserIds.length > 0) {
        await redis.del([
          ...requestedDroppedUserIds.flatMap((userId) => [
            matchDisconnectKey(lockedMatch.id, userId),
            matchPresenceKey(lockedMatch.id, userId),
          ]),
        ]);
      }
      logger.info(
        {
          eventName: 'party_dropouts_noop',
          matchId: lockedMatch.id,
          requestedDroppedUserIds,
          existingDroppedUserIds: state.droppedUserIds,
          activeCount: getActivePartyPlayers(players, nextDroppedUserIds).length,
        },
        'Party quiz dropouts were already applied'
      );
      return {
        completed: false,
        continued: false,
        activeCount: getActivePartyPlayers(players, nextDroppedUserIds).length,
      };
    }

    state.droppedUserIds = nextDroppedUserIds;
    state.answeredUserIds = state.answeredUserIds.filter((userId) => !nextDroppedUserIds.includes(userId));
    bumpStateVersion(state);

    const activePlayers = getActivePartyPlayers(players, nextDroppedUserIds);
    await matchesRepo.setMatchStatePayload(lockedMatch.id, state, lockedMatch.current_q_index);
    logger.info(
      {
        eventName: 'party_dropouts_applied',
        matchId: lockedMatch.id,
        reason,
        newlyDroppedUserIds,
        droppedUserIds: nextDroppedUserIds,
        activeUserIds: activePlayers.map((player) => player.user_id),
        activeCount: activePlayers.length,
        currentQIndex: lockedMatch.current_q_index,
      },
      'Party quiz dropouts applied'
    );

    const payload = buildPartyDropoutPayload(lockedMatch.id, reason);
    await Promise.all(
      newlyDroppedUserIds.map(async (userId) => {
        await setPartyDropoutPendingForUser(userId, payload);
        io.to(`user:${userId}`).emit('match:party_dropout', payload);
      })
    );
    logger.info(
      {
        eventName: 'match:party_dropout',
        matchId: lockedMatch.id,
        recipientUserIds: newlyDroppedUserIds,
        reason,
      },
      'Party quiz dropout emitted'
    );

    if (activePlayers.length <= 1) {
      if (activePlayers.length === 1) {
        emitPartyOpponentForfeitPending(io, lockedMatch.id, activePlayers, reason);
      }
      const standingsWinnerId = buildStandings(players)[0]?.userId ?? null;
      await completePartyQuizDropoutMatch({
        io,
        match: {
          ...lockedMatch,
          state_payload: state as unknown as Record<string, unknown>,
        },
        players,
        winnerId: activePlayers[0]?.user_id ?? standingsWinnerId,
        winnerDecisionMethod: activePlayers.length === 1 ? 'forfeit' : 'total_points',
      });
      return { completed: true, continued: false, activeCount: activePlayers.length };
    }

    if (redis) {
      await redis.del([
        ...requestedDroppedUserIds.flatMap((userId) => [
          matchDisconnectKey(lockedMatch.id, userId),
          matchPresenceKey(lockedMatch.id, userId),
        ]),
      ]);
    }

    await emitPartyQuizState(io, lockedMatch.id);

    if (params.resumeIfContinuing && redis) {
      const disconnectedExists = await Promise.all(
        activePlayers.map((player) => redis.exists(matchDisconnectKey(lockedMatch.id, player.user_id)))
      );
      const stillWaitingForActivePlayer = disconnectedExists.some((exists) => exists === 1);
      if (!stillWaitingForActivePlayer) {
        await redis.del([
          matchPauseKey(lockedMatch.id),
          matchGraceKey(lockedMatch.id),
          matchResumeCountdownKey(lockedMatch.id),
        ]);
        io.to(`match:${lockedMatch.id}`).emit('match:resume', {
          matchId: lockedMatch.id,
          nextQIndex: lockedMatch.current_q_index,
        });
        logger.info(
          {
            eventName: 'match:resume',
            matchId: lockedMatch.id,
            nextQIndex: lockedMatch.current_q_index,
            source: 'party_dropout',
            activeUserIds: activePlayers.map((player) => player.user_id),
          },
          'Party quiz resumed after dropouts'
        );
        if (state.currentQuestion) {
          await resumePartyQuizQuestion(
            io,
            lockedMatch.id,
            state.currentQuestion.qIndex,
            params.pauseStartedAtMs ?? Date.now()
          );
        } else if (lockedMatch.current_q_index >= lockedMatch.total_questions) {
          await completePartyQuizDropoutMatch({
            io,
            match: {
              ...lockedMatch,
              state_payload: state as unknown as Record<string, unknown>,
            },
            players,
            winnerId: buildStandings(activePlayers)[0]?.userId ?? null,
            winnerDecisionMethod: 'total_points',
          });
          return { completed: true, continued: false, activeCount: activePlayers.length };
        } else {
          await sendPartyQuizQuestion(io, lockedMatch.id, lockedMatch.current_q_index);
        }
      } else {
        logger.info(
          {
            eventName: 'party_resume_waiting',
            matchId: lockedMatch.id,
            activeUserIds: activePlayers.map((player) => player.user_id),
            reason: 'active_player_still_disconnected',
          },
          'Party quiz remains paused after dropouts'
        );
      }
    }

    return { completed: false, continued: true, activeCount: activePlayers.length };
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
