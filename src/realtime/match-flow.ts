import type { QuizballServer } from './socket-server.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { matchesService } from '../modules/matches/matches.service.js';
import { acquireLock, releaseLock } from './locks.js';
import { logger } from '../core/logger.js';

export const QUESTION_TIME_MS = 6000;
const ROUND_RESULT_DELAY_MS = 2000;

const questionTimers = new Map<string, NodeJS.Timeout>();

function timerKey(matchId: string, qIndex: number): string {
  return `${matchId}:${qIndex}`;
}

export async function sendMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number
): Promise<{ correctIndex: number } | null> {
  const payload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
  if (!payload) {
    logger.warn({ matchId, qIndex }, 'Unable to build match question payload');
    return null;
  }

  const deadlineAt = new Date(Date.now() + QUESTION_TIME_MS);
  await matchesRepo.setQuestionTiming(matchId, qIndex, new Date(), deadlineAt);

  io.to(`match:${matchId}`).emit('match:question', {
    matchId,
    qIndex,
    total: 10,
    question: payload.question,
    deadlineAt: deadlineAt.toISOString(),
  });
  logger.info({ matchId, qIndex, total: 10 }, 'Match question sent');

  const key = timerKey(matchId, qIndex);
  const existing = questionTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(() => {
    logger.info({ matchId, qIndex }, 'Match question timeout reached');
    void resolveRound(io, matchId, qIndex, true);
  }, QUESTION_TIME_MS + 50);

  questionTimers.set(key, timeout);

  return { correctIndex: payload.correctIndex };
}

export async function resolveRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const lockKey = `lock:match:${matchId}:${qIndex}`;
  const locked = await acquireLock(lockKey, 3000);
  if (!locked) return;

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
        void sendMatchQuestion(io, matchId, nextIndex);
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

    io.to(`match:${matchId}`).emit('match:final_results', {
      matchId,
      winnerId: winner.userId,
      players: finalPlayers,
      durationMs: matchDurationMs,
    });
    logger.info(
      { matchId, durationMs: matchDurationMs, players: Object.keys(finalPlayers).length },
      'Match final results broadcast'
    );
  } finally {
    await releaseLock(lockKey);
    const key = timerKey(matchId, qIndex);
    const timer = questionTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      questionTimers.delete(key);
    }
  }
}
