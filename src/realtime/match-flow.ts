import type { QuizballServer } from './socket-server.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { matchesService } from '../modules/matches/matches.service.js';
import { acquireLock, releaseLock } from './locks.js';
import { logger } from '../core/logger.js';
import { RANKED_AI_CORRECTNESS, rankedAiMatchKey } from './ai-ranked.constants.js';
import { getRedisClient } from './redis.js';
import {
  cancelPossessionQuestionTimer,
  resolvePossessionRound,
  sendPossessionMatchQuestion,
} from './possession-match-flow.js';

export const QUESTION_TIME_MS = 10000;
const FRONTEND_REVEAL_MS = 2000; // Frontend shows question text before unlocking options
const ROUND_RESULT_DELAY_MS = 1800;
const TIMEOUT_RESOLVE_GRACE_MS = 250;
const TIMEOUT_RESOLVE_BUFFER_MS = 50; // Small event-loop scheduling margin before timeout resolution.
const LAST_MATCH_REPLAY_TTL_SEC = 600;

const questionTimers = new Map<string, NodeJS.Timeout>();
const aiAnswerTimers = new Map<string, NodeJS.Timeout>();

function getAiAnswerDelayMs(): number {
  return Math.floor(Math.random() * 4200) + 400;
}

function pickIncorrectIndex(correctIndex: number, optionCount: number): number {
  const candidates = Array.from({ length: optionCount }, (_, index) => index).filter(
    (index) => index !== correctIndex
  );
  const picked = candidates[Math.floor(Math.random() * candidates.length)];
  return picked ?? correctIndex;
}

async function scheduleRankedAiAnswer(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  correctIndex: number,
  optionCount: number
): Promise<void> {
  const key = timerKey(matchId, qIndex);
  const existing = aiAnswerTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'active' || match.mode !== 'ranked') return;

  const redis = getRedisClient();
  if (!redis) return;

  const aiUserId = await redis.get(rankedAiMatchKey(matchId));
  if (!aiUserId) {
    // Human-vs-human ranked matches do not have an AI key; skip AI answer scheduling.
    return;
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  const hasAi = players.some((player) => player.user_id === aiUserId);
  if (!hasAi) return;

  const delayMs = getAiAnswerDelayMs();
  const timeout = setTimeout(async () => {
    // Clear timer entry on first execution to avoid leaks.
    const stored = aiAnswerTimers.get(key);
    if (stored) {
      clearTimeout(stored);
      aiAnswerTimers.delete(key);
    }
    try {
      const freshMatch = await matchesRepo.getMatch(matchId);
      if (!freshMatch || freshMatch.status !== 'active' || freshMatch.current_q_index !== qIndex) {
        return;
      }

      const existing = await matchesRepo.getAnswerForUser(matchId, qIndex, aiUserId);
      if (existing) return;

      const isCorrect = Math.random() < RANKED_AI_CORRECTNESS;
      const selectedIndex = isCorrect
        ? correctIndex
        : pickIncorrectIndex(correctIndex, optionCount);
      const timeMs = Math.min(QUESTION_TIME_MS, Math.max(0, delayMs));
      const remainingMs = Math.max(0, QUESTION_TIME_MS - timeMs);
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const pointsEarned = isCorrect ? remainingSeconds * 10 : 0;

      await matchesRepo.insertMatchAnswer({
        matchId,
        qIndex,
        userId: aiUserId,
        selectedIndex,
        isCorrect,
        timeMs,
        pointsEarned,
      });
      const updatedAiPlayer = await matchesRepo.updatePlayerTotals(matchId, aiUserId, pointsEarned, isCorrect);

      io.to(`match:${matchId}`).emit('match:opponent_answered', {
        matchId,
        qIndex,
        opponentTotalPoints: updatedAiPlayer?.total_points ?? 0,
        pointsEarned,
        isCorrect,
      });

      const refreshedPlayers = await matchesRepo.listMatchPlayers(matchId);
      const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
      if (answers.length >= refreshedPlayers.length) {
        await resolveRound(io, matchId, qIndex, false);
      }
    } catch (error) {
      logger.warn({ error, matchId, qIndex }, 'Ranked AI answer scheduling failed');
    }
  }, delayMs);
  aiAnswerTimers.set(key, timeout);
}

function timerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}

export function cancelMatchQuestionTimer(matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const timer = questionTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    questionTimers.delete(key);
  }
  cancelPossessionQuestionTimer(matchId, qIndex);
}

function cancelAiAnswerTimer(matchId: string, qIndex: number): void {
  const key = timerKey(matchId, qIndex);
  const timer = aiAnswerTimers.get(key);
  if (!timer) return;
  clearTimeout(timer);
  aiAnswerTimers.delete(key);
}

export async function sendMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number
): Promise<{ correctIndex: number } | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) {
    logger.warn({ matchId, qIndex }, 'Match not found for question');
    return null;
  }

  if (match.engine === 'possession_v1') {
    return sendPossessionMatchQuestion(io, matchId, qIndex);
  }

  const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
  if (!payload) {
    logger.warn({ matchId, qIndex }, 'Unable to build match question payload');
    return null;
  }

  const totalQuestions = match.total_questions ?? 10;
  const deadlineAt = new Date(Date.now() + QUESTION_TIME_MS);
  await matchesRepo.setQuestionTiming(matchId, qIndex, new Date(), deadlineAt);

  const questionPayload = {
    matchId,
    engine: 'classic' as const,
    qIndex,
    total: totalQuestions,
    question: payload.question,
    deadlineAt: deadlineAt.toISOString(),
    phaseKind: payload.phaseKind,
    phaseRound: payload.phaseRound,
    shooterSeat: payload.shooterSeat,
    attackerSeat: payload.attackerSeat,
  };

  logger.info({
    matchId,
    qIndex,
    total: totalQuestions,
    promptPreview: payload.question.prompt
      ? (payload.question.prompt.length > 80
        ? `${payload.question.prompt.substring(0, 80)}...`
        : payload.question.prompt)
      : '',
    optionsCount: payload.question.options?.length,
    categoryName: payload.question.categoryName,
  }, 'Match question being emitted');
  logger.debug({
    matchId,
    qIndex,
    total: totalQuestions,
    payloadQuestionJson: JSON.stringify(payload.question),
  }, 'Match question debug payload');

  io.to(`match:${matchId}`).emit('match:question', questionPayload);
  logger.info({ matchId, qIndex, total: totalQuestions }, 'Match question sent');

  const key = timerKey(matchId, qIndex);
  const existing = questionTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(() => {
    logger.info({ matchId, qIndex }, 'Match question timeout reached');
    void resolveRound(io, matchId, qIndex, true).catch((error) => {
      logger.error({ error, matchId, qIndex }, 'Failed to resolve round after timeout');
    });
  }, QUESTION_TIME_MS + FRONTEND_REVEAL_MS + TIMEOUT_RESOLVE_GRACE_MS + TIMEOUT_RESOLVE_BUFFER_MS);

  questionTimers.set(key, timeout);

  void scheduleRankedAiAnswer(
    io,
    matchId,
    qIndex,
    payload.correctIndex,
    payload.question.options.length
  ).catch((error) => {
    logger.warn({ error, matchId, qIndex }, 'Failed to schedule ranked AI answer');
  });

  return { correctIndex: payload.correctIndex };
}

export async function resolveRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const candidateMatch = await matchesRepo.getMatch(matchId);
  if (candidateMatch?.engine === 'possession_v1') {
    await resolvePossessionRound(io, matchId, qIndex, fromTimeout);
    return;
  }

  const lockKey = `lock:match:${matchId}:resolve`;
  const lock = await acquireLock(lockKey, 5000);
  if (!lock.acquired || !lock.token) return;

  try {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;
    if (match.current_q_index > qIndex) return;

    const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
    if (!payload) return;

    const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    const players = await matchesRepo.listMatchPlayers(matchId);

    const answeredUserIds = new Set(answers.map((a) => a.user_id));

    if (!fromTimeout && answers.length < players.length) {
      return;
    }

    for (const player of players) {
      if (answeredUserIds.has(player.user_id)) continue;
      await matchesRepo.insertMatchAnswer({
        matchId,
        qIndex,
        userId: player.user_id,
        selectedIndex: null,
        isCorrect: false,
        timeMs: QUESTION_TIME_MS,
        pointsEarned: 0,
      });
    }

    const finalAnswers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    const playerRows = await matchesRepo.listMatchPlayers(matchId);

    const playersPayload: Record<string, {
      selectedIndex: number | null;
      isCorrect: boolean;
      timeMs: number;
      pointsEarned: number;
      totalPoints: number;
    }> = {};

    for (const answer of finalAnswers) {
      const player = playerRows.find((p) => p.user_id === answer.user_id);
      if (!player) continue;
      playersPayload[answer.user_id] = {
        selectedIndex: answer.selected_index,
        isCorrect: answer.is_correct,
        timeMs: answer.time_ms,
        pointsEarned: answer.points_earned,
        totalPoints: player.total_points,
      };
    }

    io.to(`match:${matchId}`).emit('match:round_result', {
      matchId,
      qIndex,
      correctIndex: payload.correctIndex,
      players: playersPayload,
    });
    logger.info(
      { matchId, qIndex, answers: finalAnswers.length, players: players.length, fromTimeout },
      'Match round resolved'
    );

    const nextIndex = qIndex + 1;
    await matchesRepo.setMatchCurrentIndex(matchId, nextIndex);

    if (nextIndex < match.total_questions) {
      logger.info({ matchId, nextIndex }, 'Scheduling next match question');
      setTimeout(() => {
        void sendMatchQuestion(io, matchId, nextIndex).catch((error) => {
          logger.error({ error, matchId, nextIndex }, 'Failed to send next match question');
        });
      }, ROUND_RESULT_DELAY_MS);
      return;
    }

    const updatedPlayers = await matchesRepo.listMatchPlayers(matchId);
    const winner = updatedPlayers.reduce<{
      userId: string | null;
      points: number;
    }>(
      (acc, player) => {
        if (player.total_points > acc.points) {
          return { userId: player.user_id, points: player.total_points };
        }
        if (player.total_points === acc.points) {
          return { userId: null, points: acc.points };
        }
        return acc;
      },
      { userId: null, points: -1 }
    );

    await matchesRepo.completeMatch(matchId, winner.userId);
    logger.info(
      { matchId, winnerId: winner.userId, totalQuestions: match.total_questions },
      'Match completed'
    );

    const avgTimes = await matchesService.computeAvgTimes(matchId);
    for (const player of updatedPlayers) {
      await matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
    }

    const finalPlayers: Record<string, { totalPoints: number; correctAnswers: number; avgTimeMs: number | null }> = {};
    const refreshedPlayers = await matchesRepo.listMatchPlayers(matchId);
    for (const player of refreshedPlayers) {
      finalPlayers[player.user_id] = {
        totalPoints: player.total_points,
        correctAnswers: player.correct_answers,
        avgTimeMs: player.avg_time_ms,
      };
    }

    const matchDurationMs = Date.now() - new Date(match.started_at).getTime();

    const resultVersion = Date.now();
    io.to(`match:${matchId}`).emit('match:final_results', {
      matchId,
      winnerId: winner.userId,
      players: finalPlayers,
      durationMs: matchDurationMs,
      resultVersion,
    });

    const redis = getRedisClient();
    if (redis) {
      await redis.del(rankedAiMatchKey(matchId));
      await Promise.all(
        refreshedPlayers.map((player) =>
          redis.set(
            lastMatchKey(player.user_id),
            JSON.stringify({ matchId, resultVersion }),
            { EX: LAST_MATCH_REPLAY_TTL_SEC }
          )
        )
      );
    }

    logger.info(
      { matchId, durationMs: matchDurationMs, players: Object.keys(finalPlayers).length },
      'Match final results broadcast'
    );
  } finally {
    await releaseLock(lockKey, lock.token);
    const key = timerKey(matchId, qIndex);
    const timer = questionTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      questionTimers.delete(key);
    }
    cancelAiAnswerTimer(matchId, qIndex);
  }
}
