import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { matchAnswerSchema } from '../schemas/match.schemas.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { resolveRound, QUESTION_TIME_MS } from '../match-flow.js';
import { logger } from '../../core/logger.js';

function clampTimeMs(timeMs: number): number {
  if (timeMs < 0) return 0;
  if (timeMs > QUESTION_TIME_MS) return QUESTION_TIME_MS;
  return timeMs;
}

function calculatePoints(isCorrect: boolean, timeMs: number): number {
  if (!isCorrect) return 0;
  const clamped = clampTimeMs(timeMs);
  const bonus = Math.max(0, Math.floor(100 * (1 - clamped / QUESTION_TIME_MS)));
  return 100 + bonus;
}

export function registerMatchHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('match:answer', async (payload) => {
    const parsed = matchAnswerSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:answer payload');
      return;
    }

    const { matchId, qIndex, selectedIndex, timeMs } = parsed.data;

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    if (match.current_q_index !== qIndex) {
      logger.warn({ matchId, qIndex, current: match.current_q_index }, 'Answer for non-current question');
      return;
    }

    const questionPayload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
    if (!questionPayload) return;

    const isCorrect = selectedIndex !== null && selectedIndex === questionPayload.correctIndex;
    const pointsEarned = calculatePoints(isCorrect, timeMs);
    logger.info(
      {
        matchId,
        qIndex,
        userId: socket.data.user.id,
        selectedIndex,
        timeMs: clampTimeMs(timeMs),
        isCorrect,
        pointsEarned,
      },
      'Match answer received'
    );

    try {
      await matchesRepo.insertMatchAnswer({
        matchId,
        qIndex,
        userId: socket.data.user.id,
        selectedIndex,
        isCorrect,
        timeMs: clampTimeMs(timeMs),
        pointsEarned,
      });
    } catch (error) {
      logger.warn({ error, matchId, qIndex }, 'Duplicate or invalid match answer');
      return;
    }

    const updatedPlayer = await matchesRepo.updatePlayerTotals(
      matchId,
      socket.data.user.id,
      pointsEarned,
      isCorrect
    );

    const players = await matchesRepo.listMatchPlayers(matchId);
    const opponent = players.find((p) => p.user_id !== socket.data.user.id);
    const opponentAnswer = opponent
      ? await matchesRepo.getAnswerForUser(matchId, qIndex, opponent.user_id)
      : null;

    const myTotalPoints = updatedPlayer?.total_points ?? 0;
    const oppTotalPoints = opponent?.total_points ?? 0;

    socket.emit('match:answer_ack', {
      matchId,
      qIndex,
      selectedIndex,
      isCorrect,
      correctIndex: questionPayload.correctIndex,
      myTotalPoints,
      oppTotalPoints,
      oppAnswered: !!opponentAnswer,
    });

    if (opponent) {
      io.to(`user:${opponent.user_id}`).emit('match:opponent_answered', {
        matchId,
        qIndex,
      });
    }

    const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    if (answers.length >= players.length) {
      logger.info({ matchId, qIndex }, 'All answers received, resolving round');
      await resolveRound(io, matchId, qIndex, false);
    }
  });
}
