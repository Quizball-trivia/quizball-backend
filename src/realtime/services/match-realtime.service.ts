import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { QUESTION_TIME_MS, cancelMatchQuestionTimer, resolveRound, sendMatchQuestion } from '../match-flow.js';
import type { MatchAnswerPayload } from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { rankedAiLobbyKey, rankedAiMatchKey } from '../ai-ranked.constants.js';

const MATCH_DISCONNECT_GRACE_MS = 30000;
const PRESENCE_TTL_SEC = 45;
const DISCONNECT_TTL_SEC = 60;
const GRACE_TTL_SEC = 35;
const FORFEIT_TTL_SEC = 600;

function matchPresenceKey(matchId: string, userId: string): string {
  return `match:presence:${matchId}:${userId}`;
}

function matchDisconnectKey(matchId: string, userId: string): string {
  return `match:disconnect:${matchId}:${userId}`;
}

function matchPauseKey(matchId: string): string {
  return `match:pause:${matchId}`;
}

function matchGraceKey(matchId: string): string {
  return `match:grace:${matchId}`;
}

function matchForfeitKey(matchId: string): string {
  return `match:forfeit:${matchId}`;
}

function lastMatchKey(userId: string): string {
  return `user:last_match:${userId}`;
}

async function getOpponentInfo(matchId: string, userId: string): Promise<{
  id: string;
  username: string;
  avatarUrl: string | null;
}> {
  const players = await matchesRepo.listMatchPlayers(matchId);
  const opponent = players.find((player) => player.user_id !== userId);
  if (!opponent) {
    return {
      id: 'opponent',
      username: 'Opponent',
      avatarUrl: null,
    };
  }

  const opponentUser = await usersRepo.getById(opponent.user_id);
  return {
    id: opponent.user_id,
    username: opponentUser?.nickname ?? 'Player',
    avatarUrl: opponentUser?.avatar_url ?? null,
  };
}

async function emitRejoinAvailable(
  socket: QuizballSocket,
  match: { id: string; mode: 'friendly' | 'ranked' },
  userId: string,
  graceMs: number
): Promise<void> {
  const opponent = await getOpponentInfo(match.id, userId);
  socket.emit('match:rejoin_available', {
    matchId: match.id,
    mode: match.mode,
    opponent,
    graceMs,
  });
}

async function buildFinalResultsPayload(matchId: string): Promise<{
  matchId: string;
  winnerId: string | null;
  players: Record<string, { totalPoints: number; correctAnswers: number; avgTimeMs: number | null }>;
  durationMs: number;
} | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'completed') return null;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const payloadPlayers: Record<string, { totalPoints: number; correctAnswers: number; avgTimeMs: number | null }> = {};
  for (const player of players) {
    payloadPlayers[player.user_id] = {
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      avgTimeMs: player.avg_time_ms,
    };
  }

  // Calculate endedAt and durationMs deterministically
  let endedAt: number;
  let durationMs: number;

  if (match.ended_at) {
    // Normal case: ended_at is present
    endedAt = new Date(match.ended_at).getTime();
    durationMs = endedAt - new Date(match.started_at).getTime();
  } else if (match.status === 'completed') {
    // Match is completed but ended_at is missing - data inconsistency
    logger.warn(
      { matchId, startedAt: match.started_at, status: match.status },
      'Match is completed but ended_at is null - using started_at as fallback'
    );
    endedAt = new Date(match.started_at).getTime();
    durationMs = 0; // Duration is 0 since we don't have accurate end time
  } else {
    // Match is in-progress (shouldn't happen due to line 48 check, but defensive)
    endedAt = Date.now();
    durationMs = endedAt - new Date(match.started_at).getTime();
  }

  return {
    matchId,
    winnerId: match.winner_user_id,
    players: payloadPlayers,
    durationMs,
  };
}

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

  // Lobby is no longer needed for membership tracking once match starts.
  await lobbiesRepo.setLobbyStatus(lobbyId, 'closed');
  await Promise.all(members.map((member) => lobbiesRepo.removeMember(lobbyId, member.user_id)));

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

  const redis = getRedisClient();
  if (redis) {
    const match = await matchesRepo.getMatch(matchId);
    if (match?.mode === 'ranked') {
      const aiUserId = await redis.get(rankedAiLobbyKey(lobbyId));
      if (aiUserId) {
        await redis.set(rankedAiMatchKey(matchId), aiUserId, { EX: FORFEIT_TTL_SEC });
      }
      await redis.del(rankedAiLobbyKey(lobbyId));
    }

    await Promise.all([
      redis.set(matchPresenceKey(matchId, memberA.user_id), '1', { EX: PRESENCE_TTL_SEC }),
      redis.set(matchPresenceKey(matchId, memberB.user_id), '1', { EX: PRESENCE_TTL_SEC }),
    ]);
  }

  await sendMatchQuestion(io, matchId, 0);
}

function calculatePoints(isCorrect: boolean, timeMs: number): number {
  if (!isCorrect) return 0;
  const clamped = Math.max(0, Math.min(timeMs, QUESTION_TIME_MS));
  const remainingMs = Math.max(0, QUESTION_TIME_MS - clamped);
  return Math.floor(remainingMs / 10);
}

export const matchRealtimeService = {
  async rejoinActiveMatchOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const match = await matchesRepo.getActiveMatchForUser(userId);
    if (!match) return;

    socket.join(`match:${match.id}`);
    socket.data.matchId = match.id;

    const redis = getRedisClient();
    if (redis) {
      await redis.set(matchPresenceKey(match.id, userId), '1', { EX: PRESENCE_TTL_SEC });
    }

    if (!redis) return;

    const disconnectKey = matchDisconnectKey(match.id, userId);
    const pauseKey = matchPauseKey(match.id);
    const isPaused = (await redis.exists(pauseKey)) === 1;
    const wasDisconnected = (await redis.exists(disconnectKey)) === 1;

    if (isPaused && wasDisconnected) {
      await this.resumePausedMatch(io, match.id, userId);
    }
  },

  async handleMatchLeave(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const activeMatch =
      (socket.data.matchId ? await matchesRepo.getMatch(socket.data.matchId) : null) ??
      (await matchesRepo.getActiveMatchForUser(userId));

    if (!activeMatch || activeMatch.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match to leave',
      });
      return;
    }

    await this.pauseMatchForDisconnectedPlayer(io, activeMatch.id, userId);

    socket.leave(`match:${activeMatch.id}`);
    socket.data.matchId = undefined;

    await emitRejoinAvailable(socket, activeMatch, userId, MATCH_DISCONNECT_GRACE_MS);
  },

  async handleMatchRejoin(io: QuizballServer, socket: QuizballSocket, requestedMatchId: string | null): Promise<void> {
    const userId = socket.data.user.id;
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

    const players = await matchesRepo.listMatchPlayers(match.id);
    const isParticipant = players.some((player) => player.user_id === userId);
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

    const opponent = await getOpponentInfo(match.id, userId);
    socket.emit('match:start', {
      matchId: match.id,
      opponent,
    });

    if (!redis) return;

    const isPaused = (await redis.exists(matchPauseKey(match.id))) === 1;
    const wasDisconnected = (await redis.exists(matchDisconnectKey(match.id, userId))) === 1;
    if (isPaused && wasDisconnected) {
      await this.resumePausedMatch(io, match.id, userId);
    }
  },

  async emitLastMatchResultIfAny(_io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const userId = socket.data.user.id;
    const lastMatchId = await redis.get(lastMatchKey(userId));
    if (!lastMatchId) return;

    const lastMatch = await matchesRepo.getMatch(lastMatchId);
    if (!lastMatch) {
      await redis.del(lastMatchKey(userId));
      return;
    }

    if (lastMatch.status === 'abandoned') {
      socket.emit('error', {
        code: 'MATCH_ABANDONED',
        message: 'Match was abandoned due to disconnects.',
      });
      await redis.del(lastMatchKey(userId));
      return;
    }

    const payload = await buildFinalResultsPayload(lastMatchId);
    if (payload) {
      socket.emit('match:final_results', payload);
    }
    await redis.del(lastMatchKey(userId));
  },

  async resumePausedMatch(io: QuizballServer, matchId: string, userId: string): Promise<void> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    const redis = getRedisClient();
    if (!redis) return;

    await redis.del(matchDisconnectKey(matchId, userId));

    const roster = await matchesRepo.listMatchPlayers(matchId);
    const stillDisconnected: string[] = [];
    for (const player of roster) {
      const exists = await redis.exists(matchDisconnectKey(matchId, player.user_id));
      if (exists) stillDisconnected.push(player.user_id);
    }

    if (stillDisconnected.length > 0) {
      const ttl = await redis.ttl(matchGraceKey(matchId));
      const graceMs = ttl > 0 ? ttl * 1000 : MATCH_DISCONNECT_GRACE_MS;
      io.to(`user:${userId}`).emit('match:opponent_disconnected', {
        matchId,
        opponentId: stillDisconnected[0],
        graceMs,
      });
      return;
    }

    await redis.del([matchPauseKey(matchId), matchGraceKey(matchId)]);

    io.to(`match:${matchId}`).emit('match:resume', {
      matchId,
      nextQIndex: match.current_q_index,
    });

    await resolveRound(io, matchId, match.current_q_index, true);
  },

  async handleMatchDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const matchId = socket.data.matchId;
    if (!matchId) return;

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    const userId = socket.data.user.id;
    await this.pauseMatchForDisconnectedPlayer(io, matchId, userId);
  },

  async pauseMatchForDisconnectedPlayer(io: QuizballServer, matchId: string, userId: string): Promise<void> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    const redis = getRedisClient();
    if (!redis) return;

    await redis.set(matchDisconnectKey(matchId, userId), String(Date.now()), { EX: DISCONNECT_TTL_SEC });
    await redis.set(matchPauseKey(matchId), '1', { EX: PRESENCE_TTL_SEC });

    cancelMatchQuestionTimer(matchId, match.current_q_index);

    const players = await matchesRepo.listMatchPlayers(matchId);
    const opponent = players.find((player) => player.user_id !== userId);
    if (opponent) {
      io.to(`user:${opponent.user_id}`).emit('match:opponent_disconnected', {
        matchId,
        opponentId: userId,
        graceMs: MATCH_DISCONNECT_GRACE_MS,
      });
    }

    const graceKey = matchGraceKey(matchId);
    const acquired = await redis.set(graceKey, String(Date.now()), { NX: true, EX: GRACE_TTL_SEC });
    if (acquired !== 'OK') return;

    setTimeout(async () => {
      try {
        const graceStillActive = (await redis.exists(matchGraceKey(matchId))) === 1;
        if (!graceStillActive) return;

        const activeMatch = await matchesRepo.getMatch(matchId);
        if (!activeMatch || activeMatch.status !== 'active') return;

        const roster = await matchesRepo.listMatchPlayers(matchId);
        const disconnected: string[] = [];
        for (const player of roster) {
          const exists = await redis.exists(matchDisconnectKey(matchId, player.user_id));
          if (exists) disconnected.push(player.user_id);
        }

        if (disconnected.length === 0) return;

        if (disconnected.length === roster.length) {
          await matchesRepo.abandonMatch(matchId);
          io.to(`match:${matchId}`).emit('error', {
            code: 'MATCH_ABANDONED',
            message: 'Match abandoned due to both players disconnecting',
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

        const winnerId = roster.find((player) => !disconnected.includes(player.user_id))?.user_id ?? null;
        if (winnerId) {
          const fullPoints = Math.floor((QUESTION_TIME_MS / 10) * activeMatch.total_questions);
          await matchesRepo.setPlayerForfeitWinTotals(
            matchId,
            winnerId,
            fullPoints,
            activeMatch.total_questions
          );
        }
        await matchesRepo.completeMatch(matchId, winnerId);

        const avgTimes = await matchesService.computeAvgTimes(matchId);
        for (const player of roster) {
          await matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
        }

        const finalPayload = await buildFinalResultsPayload(matchId);
        if (finalPayload) {
          io.to(`match:${matchId}`).emit('match:final_results', finalPayload);
        }

        await redis.del(rankedAiMatchKey(matchId));
        await redis.set(matchForfeitKey(matchId), winnerId ?? 'draw', { EX: FORFEIT_TTL_SEC });
        await Promise.all(
          roster.map((player) => redis.set(lastMatchKey(player.user_id), matchId, { EX: FORFEIT_TTL_SEC }))
        );
      } finally {
        await redis.del(matchGraceKey(matchId));
        await redis.del(matchPauseKey(matchId));
      }
    }, MATCH_DISCONNECT_GRACE_MS);
  },

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

    const redis = getRedisClient();
    if (redis) {
      const paused = await redis.exists(matchPauseKey(matchId));
      if (paused) {
        socket.emit('error', {
          code: 'MATCH_PAUSED',
          message: 'Match is paused. Please wait for your opponent to return.',
        });
        return;
      }
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
