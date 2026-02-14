import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { QUESTION_TIME_MS, cancelMatchQuestionTimer, resolveRound, sendMatchQuestion } from '../match-flow.js';
import type { MatchAnswerPayload, MatchFinalResultsAckPayload } from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../redis.js';
import { rankedAiLobbyKey, rankedAiMatchKey } from '../ai-ranked.constants.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import {
  buildInitialCache,
  deleteMatchCache,
  getMatchCacheOrRebuild,
  setMatchCache,
  type MatchCache,
} from '../match-cache.js';
import {
  cancelPossessionHalftimeTimer,
  emitPossessionStateToSocket,
  handlePossessionAnswer,
  handlePossessionTacticSelect,
} from '../possession-match-flow.js';

const MATCH_DISCONNECT_GRACE_MS = 30000;
const MATCH_START_COUNTDOWN_SEC = 5;
const PRESENCE_TTL_SEC = 45;
const DISCONNECT_TTL_SEC = 60;
const GRACE_TTL_SEC = 35;
const FORFEIT_TTL_SEC = 600;

type LastMatchReplay = {
  matchId: string;
  resultVersion: number;
};

type MatchParticipantSnapshot = {
  user_id: string;
  seat: 1 | 2;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
};

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

function parseLastMatchReplay(raw: string): LastMatchReplay {
  try {
    const parsed = JSON.parse(raw) as Partial<LastMatchReplay>;
    if (typeof parsed.matchId === 'string' && typeof parsed.resultVersion === 'number') {
      return {
        matchId: parsed.matchId,
        resultVersion: parsed.resultVersion,
      };
    }
  } catch {
    // Backward-compat path for legacy string format.
  }
  return {
    matchId: raw,
    resultVersion: Date.now(),
  };
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

function participantSnapshotFromCache(cache: MatchCache): MatchParticipantSnapshot[] {
  return cache.players.map((player) => ({
    user_id: player.userId,
    seat: player.seat,
    total_points: player.totalPoints,
    correct_answers: player.correctAnswers,
    goals: player.goals,
    penalty_goals: player.penaltyGoals,
    avg_time_ms: player.avgTimeMs,
  }));
}

function participantSnapshotFromRows(rows: Array<{
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
}>): MatchParticipantSnapshot[] {
  return rows.map((row) => ({
    user_id: row.user_id,
    seat: row.seat === 2 ? 2 : 1,
    total_points: row.total_points,
    correct_answers: row.correct_answers,
    goals: row.goals,
    penalty_goals: row.penalty_goals,
    avg_time_ms: row.avg_time_ms,
  }));
}

async function getParticipantSnapshot(matchId: string): Promise<{
  participants: MatchParticipantSnapshot[];
  cache: MatchCache | null;
}> {
  const cache = await getMatchCacheOrRebuild(matchId);
  if (cache && cache.players.length > 0) {
    return {
      participants: participantSnapshotFromCache(cache),
      cache,
    };
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  return {
    participants: participantSnapshotFromRows(players),
    cache: null,
  };
}

async function getOpponentInfoFromParticipants(
  participants: MatchParticipantSnapshot[],
  userId: string
): Promise<{
  id: string;
  username: string;
  avatarUrl: string | null;
}> {
  const opponent = participants.find((player) => player.user_id !== userId);
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

async function buildFinalResultsPayload(matchId: string, resultVersion: number): Promise<{
  matchId: string;
  winnerId: string | null;
  players: Record<string, {
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
    goals?: number;
    penaltyGoals?: number;
  }>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' | null;
  totalPointsFallbackUsed?: boolean;
} | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.status !== 'completed') return null;

  const players = await matchesRepo.listMatchPlayers(matchId);
  const payloadPlayers: Record<string, {
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
    goals?: number;
    penaltyGoals?: number;
  }> = {};
  for (const player of players) {
    payloadPlayers[player.user_id] = {
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      avgTimeMs: player.avg_time_ms,
      goals: player.goals,
      penaltyGoals: player.penalty_goals,
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

  const winnerDecisionMethod =
    (match.state_payload as { winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points_fallback' | 'forfeit' } | null)?.winnerDecisionMethod ?? null;

  return {
    matchId,
    winnerId: match.winner_user_id,
    players: payloadPlayers,
    durationMs,
    resultVersion,
    winnerDecisionMethod,
    totalPointsFallbackUsed: winnerDecisionMethod === 'total_points_fallback',
  };
}

export async function beginMatchForLobby(
  io: QuizballServer,
  lobbyId: string,
  matchId: string,
  options?: { countdownSec?: number }
): Promise<void> {
  const countdownSec = Math.max(
    0,
    Number.isFinite(options?.countdownSec)
      ? Math.floor(options?.countdownSec ?? MATCH_START_COUNTDOWN_SEC)
      : MATCH_START_COUNTDOWN_SEC
  );
  const countdownMs = countdownSec * 1000;

  const lobbyMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
  type MatchStartMember = Pick<(typeof lobbyMembers)[number], 'user_id' | 'nickname' | 'avatar_url'>;
  const match = await matchesRepo.getMatch(matchId);
  const players = await matchesRepo.listMatchPlayers(matchId);
  if (!match || players.length !== 2) {
    logger.warn(
      { lobbyId, matchId, hasMatch: Boolean(match), playerCount: players.length },
      'Match start aborted: invalid match context'
    );
    return;
  }

  let members: MatchStartMember[] = lobbyMembers.map((member) => ({
    user_id: member.user_id,
    nickname: member.nickname,
    avatar_url: member.avatar_url,
  }));
  if (members.length !== 2) {
    logger.warn(
      { lobbyId, matchId, memberCount: members.length },
      'Match start member count invalid, falling back to match players'
    );
    const users = await Promise.all(players.map((player) => usersRepo.getById(player.user_id)));
    members = players.map((player, index) => ({
      user_id: player.user_id,
      nickname: users[index]?.nickname ?? 'Player',
      avatar_url: users[index]?.avatar_url ?? null,
    }));
  }

  // Lobby is no longer needed for membership tracking once match starts.
  await lobbiesRepo.setLobbyStatus(lobbyId, 'closed');
  await Promise.all(lobbyMembers.map((member) => lobbiesRepo.removeMember(lobbyId, member.user_id)));

  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
    socket.join(`match:${matchId}`);
    socket.data.matchId = matchId;
  });

  await Promise.all(
    members.map(async (member) => {
      const userSockets = await io.in(`user:${member.user_id}`).fetchSockets();
      userSockets.forEach((socket) => {
        socket.leave(`lobby:${lobbyId}`);
        socket.data.lobbyId = undefined;
        socket.join(`match:${matchId}`);
        socket.data.matchId = matchId;
      });
    })
  );

  const memberA = members[0];
  const memberB = members[1];
  const cache = buildInitialCache({ match, players });
  await setMatchCache(cache);
  const seatByUserId = new Map(players.map((player) => [player.user_id, player.seat as 1 | 2]));

  io.to(`user:${memberA.user_id}`).emit('match:start', {
    matchId,
    mySeat: seatByUserId.get(memberA.user_id) ?? undefined,
    opponent: {
      id: memberB.user_id,
      username: memberB.nickname ?? 'Player',
      avatarUrl: memberB.avatar_url,
    },
  });

  io.to(`user:${memberB.user_id}`).emit('match:start', {
    matchId,
    mySeat: seatByUserId.get(memberB.user_id) ?? undefined,
    opponent: {
      id: memberA.user_id,
      username: memberA.nickname ?? 'Player',
      avatarUrl: memberA.avatar_url,
    },
  });

  const redis = getRedisClient();
  if (redis?.isOpen) {
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

  const startsAt = new Date(Date.now() + countdownMs).toISOString();
  io.to(`match:${matchId}`).emit('match:countdown', {
    matchId,
    seconds: countdownSec,
    startsAt,
  });
  logger.info(
    { matchId, seconds: countdownSec, startsAt },
    'Match start countdown scheduled'
  );

  setTimeout(() => {
    void sendMatchQuestion(io, matchId, 0).catch((error) => {
      logger.error({ error, matchId }, 'Failed to send first match question after countdown');
    });
  }, countdownMs);
}



export const matchRealtimeService = {
  async rejoinActiveMatchOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const match = await matchesRepo.getActiveMatchForUser(userId);
    if (!match) return;

    socket.join(`match:${match.id}`);
    socket.data.matchId = match.id;

    const { participants } = await getParticipantSnapshot(match.id);
    const opponent = await getOpponentInfoFromParticipants(participants, userId);
    const mySeat = participants.find((player) => player.user_id === userId)?.seat;
    socket.emit('match:start', {
      matchId: match.id,
      mySeat: mySeat === 1 || mySeat === 2 ? mySeat : undefined,
      opponent,
    });
    await emitPossessionStateToSocket(socket, match.id);

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

  async handleMatchLeave(
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

        await this.pauseMatchForDisconnectedPlayer(io, activeMatch.id, userId);

        socket.leave(`match:${activeMatch.id}`);
        socket.data.matchId = undefined;

        await emitRejoinAvailable(socket, activeMatch, userId, MATCH_DISCONNECT_GRACE_MS);
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Match transition is in progress. Please retry.',
        operation: 'match:leave',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async handleMatchForfeit(
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
            message: 'No active match to forfeit',
          });
          return;
        }

        const { participants: roster, cache } = await getParticipantSnapshot(activeMatch.id);
        const isParticipant = roster.some((player) => player.user_id === userId);
        if (!isParticipant) {
          socket.emit('error', {
            code: 'MATCH_NOT_ALLOWED',
            message: 'You are not a participant in this match',
          });
          return;
        }

        if (cache && cache.status === 'active') {
          await matchesRepo.setMatchStatePayload(activeMatch.id, cache.statePayload, cache.currentQIndex);
          await Promise.all(
            cache.players.map((player) =>
              matchesRepo.setPlayerFinalTotals(activeMatch.id, player.userId, {
                totalPoints: player.totalPoints,
                correctAnswers: player.correctAnswers,
                goals: player.goals,
                penaltyGoals: player.penaltyGoals,
              })
            )
          );
        }

        const winnerId = roster.find((player) => player.user_id !== userId)?.user_id ?? null;
        if (winnerId) {
          const fullPoints = Math.floor((QUESTION_TIME_MS / 1000) * 10 * activeMatch.total_questions);
          const fullCorrectAnswers = activeMatch.total_questions;
          const winnerPlayer = roster.find((player) => player.user_id === winnerId);
          const currentPoints = winnerPlayer?.total_points ?? 0;
          const currentCorrect = winnerPlayer?.correct_answers ?? 0;

          const finalPoints = Math.max(currentPoints, fullPoints);
          const finalCorrect = Math.max(currentCorrect, fullCorrectAnswers);
          await matchesRepo.setPlayerForfeitWinTotals(
            activeMatch.id,
            winnerId,
            finalPoints,
            finalCorrect
          );
        }

        // Mark decision method as forfeit before completing
        const currentPayload = (cache?.statePayload ?? activeMatch.state_payload ?? {}) as Record<string, unknown>;
        await matchesRepo.setMatchStatePayload(activeMatch.id, {
          ...currentPayload,
          winnerDecisionMethod: 'forfeit',
        });

        cancelMatchQuestionTimer(activeMatch.id, activeMatch.current_q_index);
        cancelPossessionHalftimeTimer(activeMatch.id);
        await matchesRepo.completeMatch(activeMatch.id, winnerId);
        await deleteMatchCache(activeMatch.id);

        const avgTimes = await matchesService.computeAvgTimes(activeMatch.id);
        for (const player of roster) {
          await matchesRepo.updatePlayerAvgTime(
            activeMatch.id,
            player.user_id,
            avgTimes.get(player.user_id) ?? null
          );
        }

        const resultVersion = Date.now();
        const finalPayload = await buildFinalResultsPayload(activeMatch.id, resultVersion);
        if (finalPayload) {
          io.to(`match:${activeMatch.id}`).emit('match:final_results', finalPayload);
        }

        const redis = getRedisClient();
        if (redis) {
          const cleanupKeys = [
            matchPauseKey(activeMatch.id),
            matchGraceKey(activeMatch.id),
            ...roster.flatMap((player) => [
              matchDisconnectKey(activeMatch.id, player.user_id),
              matchPresenceKey(activeMatch.id, player.user_id),
            ]),
          ];

          await redis.del(cleanupKeys);
          await redis.del(rankedAiMatchKey(activeMatch.id));
          await redis.set(matchForfeitKey(activeMatch.id), winnerId ?? 'draw', {
            EX: FORFEIT_TTL_SEC,
          });
          await Promise.all(
            roster.map((player) =>
              redis.set(
                lastMatchKey(player.user_id),
                JSON.stringify({ matchId: activeMatch.id, resultVersion }),
                { EX: FORFEIT_TTL_SEC }
              )
            )
          );
        }

        socket.leave(`match:${activeMatch.id}`);
        socket.data.matchId = undefined;
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Match transition is in progress. Please retry.',
        operation: 'match:forfeit',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async handleMatchRejoin(io: QuizballServer, socket: QuizballSocket, requestedMatchId: string | null): Promise<void> {
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

        const opponent = await getOpponentInfoFromParticipants(participants, userId);
        const mySeat = participants.find((player) => player.user_id === userId)?.seat;
        socket.emit('match:start', {
          matchId: match.id,
          mySeat: mySeat === 1 || mySeat === 2 ? mySeat : undefined,
          opponent,
        });
        await emitPossessionStateToSocket(socket, match.id);

        if (!redis) return;

        const isPaused = (await redis.exists(matchPauseKey(match.id))) === 1;
        const wasDisconnected = (await redis.exists(matchDisconnectKey(match.id, userId))) === 1;
        if (isPaused && wasDisconnected) {
          await this.resumePausedMatch(io, match.id, userId);
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
  },

  async emitLastMatchResultIfAny(_io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const userId = socket.data.user.id;
    const rawReplay = await redis.get(lastMatchKey(userId));
    if (!rawReplay) return;
    const replay = parseLastMatchReplay(rawReplay);

    const lastMatch = await matchesRepo.getMatch(replay.matchId);
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

    const payload = await buildFinalResultsPayload(replay.matchId, replay.resultVersion);
    if (payload) {
      socket.emit('match:final_results', payload);
    }
  },

  async handleFinalResultsAck(
    socket: QuizballSocket,
    payload: MatchFinalResultsAckPayload
  ): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;

    const userId = socket.data.user.id;
    const rawReplay = await redis.get(lastMatchKey(userId));
    if (!rawReplay) return;

    const replay = parseLastMatchReplay(rawReplay);
    if (replay.matchId !== payload.matchId || replay.resultVersion !== payload.resultVersion) {
      return;
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

    const activeQuestion = await matchesRepo.getMatchQuestion(matchId, match.current_q_index);
    if (activeQuestion) {
      await resolveRound(io, matchId, match.current_q_index, true);
      return;
    }
    await sendMatchQuestion(io, matchId, match.current_q_index);
  },

  async handleMatchDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const matchId = socket.data.matchId;
    if (!matchId) return;

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    const userId = socket.data.user.id;
    const completed = await userSessionGuardService.runWithUserTransitionLock(io, socket, async () => {
      await this.pauseMatchForDisconnectedPlayer(io, matchId, userId);
    }, {
      operation: 'match:disconnect',
    });
    if (!completed) return;
    await userSessionGuardService.emitState(io, userId);
  },

  async pauseMatchForDisconnectedPlayer(io: QuizballServer, matchId: string, userId: string): Promise<void> {
    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') return;

    const redis = getRedisClient();
    if (!redis) return;

    await redis.set(matchDisconnectKey(matchId, userId), String(Date.now()), { EX: DISCONNECT_TTL_SEC });
    await redis.set(matchPauseKey(matchId), '1', { EX: PRESENCE_TTL_SEC });

    cancelMatchQuestionTimer(matchId, match.current_q_index);
    cancelPossessionHalftimeTimer(matchId);

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
          await matchesService.abandonMatch(matchId);
          await deleteMatchCache(matchId);
          cancelPossessionHalftimeTimer(matchId);
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
          const fullPoints = Math.floor((QUESTION_TIME_MS / 1000) * 10 * activeMatch.total_questions);
          const fullCorrectAnswers = activeMatch.total_questions;

          // Fetch current player stats to compute max values (business logic in service)
          const players = await matchesRepo.listMatchPlayers(matchId);
          const winnerPlayer = players.find((p) => p.user_id === winnerId);
          const currentPoints = winnerPlayer?.total_points ?? 0;
          const currentCorrect = winnerPlayer?.correct_answers ?? 0;

          // Apply max logic here instead of in SQL
          const finalPoints = Math.max(currentPoints, fullPoints);
          const finalCorrect = Math.max(currentCorrect, fullCorrectAnswers);

          await matchesRepo.setPlayerForfeitWinTotals(
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

        await matchesRepo.completeMatch(matchId, winnerId);
        await deleteMatchCache(matchId);
        cancelPossessionHalftimeTimer(matchId);

        const avgTimes = await matchesService.computeAvgTimes(matchId);
        for (const player of roster) {
          await matchesRepo.updatePlayerAvgTime(matchId, player.user_id, avgTimes.get(player.user_id) ?? null);
        }

        const resultVersion = Date.now();
        const finalPayload = await buildFinalResultsPayload(matchId, resultVersion);
        if (finalPayload) {
          io.to(`match:${matchId}`).emit('match:final_results', finalPayload);
        }

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
      } finally {
        await redis.del(matchGraceKey(matchId));
        await redis.del(matchPauseKey(matchId));
      }
    }, MATCH_DISCONNECT_GRACE_MS);
  },

  async handleTacticSelect(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { matchId: string; tactic: 'press-high' | 'play-safe' | 'all-in' }
  ): Promise<void> {
    const match = await matchesRepo.getMatch(payload.matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found for tactic selection.',
      });
      return;
    }

    await handlePossessionTacticSelect(io, socket, payload);
  },

  async handleAnswer(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: MatchAnswerPayload
  ): Promise<void> {
    const { matchId } = payload;

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

    await handlePossessionAnswer(io, socket, payload);
  },
};
