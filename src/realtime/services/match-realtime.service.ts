import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { QUESTION_TIME_MS, resolveRound, sendMatchQuestion } from '../match-flow.js';
import type { MatchAnswerPayload } from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';

export async function beginMatchForLobby(
  io: QuizballServer,
  lobbyId: string,
  matchId: string
): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length !== 2) {
    logger.warn({ lobbyId, memberCount: members.length }, 'Match start aborted: invalid member count');
    return;
  }

  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
    socket.join(`match:${matchId}`);
    socket.data.matchId = matchId;
  });

  const memberA = members[0];
  const memberB = members[1];

  io.to(`user:${memberA.user_id}`).emit('match:start', {
    matchId,
    opponent: {
      id: memberB.user_id,
      username: memberB.nickname ?? 'Player',
      avatarUrl: memberB.avatar_url,
    },
  });

  io.to(`user:${memberB.user_id}`).emit('match:start', {
    matchId,
    opponent: {
      id: memberA.user_id,
      username: memberA.nickname ?? 'Player',
      avatarUrl: memberA.avatar_url,
    },
  });

  await sendMatchQuestion(io, matchId, 0);
}

function calculatePoints(isCorrect: boolean, timeMs: number): number {
  if (!isCorrect) return 0;
  const clamped = Math.max(0, Math.min(timeMs, QUESTION_TIME_MS));
  const bonus = Math.floor(100 * (1 - clamped / QUESTION_TIME_MS));
  return 100 + bonus;
}

export const matchRealtimeService = {
  async handleAnswer(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: MatchAnswerPayload
  ): Promise<void> {
    const { matchId, qIndex, selectedIndex, timeMs } = payload;

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') {
      logger.warn({ matchId, qIndex }, 'Match answer ignored: match not active');
      return;
    }

    if (match.current_q_index !== qIndex) {
      logger.warn(
        { matchId, qIndex, current: match.current_q_index },
        'Answer for non-current question'
      );
      return;
    }

    const existing = await matchesRepo.getAnswerForUser(matchId, qIndex, socket.data.user.id);
    if (existing) {
      logger.debug({ matchId, qIndex, userId: socket.data.user.id }, 'Duplicate answer ignored');
      return;
    }

    const questionPayload = await matchesService.buildMatchQuestionPayload(matchId, qIndex);
    if (!questionPayload) {
      logger.warn({ matchId, qIndex }, 'Match answer ignored: question not found');
      return;
    }

    const isCorrect =
      selectedIndex !== null && selectedIndex === questionPayload.correctIndex;
    const pointsEarned = calculatePoints(isCorrect, timeMs);

    try {
      await matchesRepo.insertMatchAnswer({
        matchId,
        qIndex,
        userId: socket.data.user.id,
        selectedIndex,
        isCorrect,
        timeMs,
        pointsEarned,
      });
    } catch (error) {
      logger.warn({ error, matchId, qIndex }, 'Failed to insert match answer');
      return;
    }

    const updatedPlayer = await matchesRepo.updatePlayerTotals(
      matchId,
      socket.data.user.id,
      pointsEarned,
      isCorrect
    );
    if (!updatedPlayer) {
      logger.warn({ matchId, userId: socket.data.user.id }, 'Match answer ignored: player not found');
      return;
    }

    const players = await matchesRepo.listMatchPlayers(matchId);
    const opponent = players.find((p) => p.user_id !== socket.data.user.id);
    const opponentAnswer = opponent
      ? await matchesRepo.getAnswerForUser(matchId, qIndex, opponent.user_id)
      : null;

    socket.emit('match:answer_ack', {
      matchId,
      qIndex,
      selectedIndex,
      isCorrect,
      correctIndex: questionPayload.correctIndex,
      myTotalPoints: updatedPlayer.total_points,
      oppAnswered: !!opponentAnswer,
    });

    socket.to(`match:${matchId}`).emit('match:opponent_answered', {
      matchId,
      qIndex,
    });

    const answers = await matchesRepo.listAnswersForQuestion(matchId, qIndex);
    if (answers.length >= players.length) {
      await resolveRound(io, matchId, qIndex, false);
    }
  },
};
