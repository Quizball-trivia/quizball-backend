import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import type { RankedLobbyContext } from '../../modules/lobbies/lobbies.types.js';
import { achievementsService } from '../../modules/achievements/index.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { matchesService, resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { QUESTION_TIME_MS, cancelMatchQuestionTimer, resolveRound, sendMatchQuestion } from '../match-flow.js';
import type {
  MatchAnswerPayload,
  MatchChanceCardUsePayload,
  MatchFinalResultsAckPayload,
  MatchPlayAgainPayload,
} from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { getRedisClient } from '../redis.js';
import { rankedAiLobbyKey, rankedAiMatchKey } from '../ai-ranked.constants.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
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
  handlePossessionChanceCardUse,
  handlePossessionHalftimeBan,
} from '../possession-match-flow.js';
import {
  emitPartyQuizState,
  emitPartyQuizStateToSocket,
  handlePartyQuizAnswer,
} from '../party-quiz-match-flow.js';
import type { AchievementUnlockPayload } from '../socket.types.js';
import {
  matchPresenceKey,
  matchDisconnectKey,
  matchPauseKey,
  matchGraceKey,
  lastMatchKey,
} from '../match-keys.js';
import { buildStandings } from '../match-utils.js';

const MATCH_DISCONNECT_GRACE_MS = 30000;
const MATCH_START_COUNTDOWN_SEC = 5;
const PRESENCE_TTL_SEC = 45;
const DISCONNECT_TTL_SEC = 60;
const GRACE_TTL_SEC = 35;
const FORFEIT_TTL_SEC = 600;
const FRIENDLY_REMATCH_LOBBY_TTL_MS = 30 * 60 * 1000;

type LastMatchReplay = {
  matchId: string;
  resultVersion: number;
};

type MatchParticipantSnapshot = {
  user_id: string;
  seat: number;
  total_points: number;
  correct_answers: number;
  goals: number;
  penalty_goals: number;
  avg_time_ms: number | null;
};

const rematchLobbyByMatchId = new Map<string, { lobbyId: string; createdAt: number }>();

function matchForfeitKey(matchId: string): string {
  return `match:forfeit:${matchId}`;
}

function pruneExpiredRematchLobby(matchId: string): void {
  const entry = rematchLobbyByMatchId.get(matchId);
  if (!entry) return;
  if (Date.now() - entry.createdAt <= FRIENDLY_REMATCH_LOBBY_TTL_MS) return;
  rematchLobbyByMatchId.delete(matchId);
}

async function getWaitingRematchLobbyId(matchId: string): Promise<string | null> {
  pruneExpiredRematchLobby(matchId);
  const entry = rematchLobbyByMatchId.get(matchId);
  if (!entry) return null;

  const lobby = await lobbiesRepo.getById(entry.lobbyId);
  if (!lobby || lobby.mode !== 'friendly' || lobby.status !== 'waiting') {
    rematchLobbyByMatchId.delete(matchId);
    return null;
  }

  return entry.lobbyId;
}

function setWaitingRematchLobbyId(matchId: string, lobbyId: string): void {
  rematchLobbyByMatchId.set(matchId, {
    lobbyId,
    createdAt: Date.now(),
  });
}

async function detachUserSocketsFromMatch(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<void> {
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`match:${matchId}`);
    if (socket.data.matchId === matchId) {
      socket.data.matchId = undefined;
    }
  });
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
    seat: row.seat,
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
  userId: string,
  matchMode?: 'friendly' | 'ranked',
  rankedContext?: RankedLobbyContext | null
): Promise<{
  id: string;
  username: string;
  avatarUrl: string | null;
  rp?: number;
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
  let rp: number | undefined;
  if (matchMode === 'ranked') {
    if (opponentUser?.is_ai && typeof rankedContext?.aiAnchorRp === 'number') {
      rp = rankedContext.aiAnchorRp;
    } else {
      const profile = await rankedService.ensureProfile(opponent.user_id);
      rp = profile.rp;
    }
  }
  return {
    id: opponent.user_id,
    username: opponentUser?.nickname ?? 'Player',
    avatarUrl: opponentUser?.avatar_url ?? null,
    ...(rp != null ? { rp } : {}),
  };
}

async function buildParticipantPayloads(
  players: MatchParticipantSnapshot[],
  matchMode: 'friendly' | 'ranked',
  rankedContext?: RankedLobbyContext | null
): Promise<Array<{
  userId: string;
  username: string;
  avatarUrl: string | null;
  seat: number;
  rankPoints?: number;
}>> {
  const users = await Promise.all(players.map((player) => usersRepo.getById(player.user_id)));
  let rpByUserId = new Map<string, number>();

  if (matchMode === 'ranked') {
    const nonAiPlayers = players.filter((_player, index) => {
      const user = users[index];
      return !(user?.is_ai && typeof rankedContext?.aiAnchorRp === 'number');
    });
    const profiles = await Promise.all(
      nonAiPlayers.map(async (player) => ({
        userId: player.user_id,
        profile: await rankedService.ensureProfile(player.user_id),
      }))
    );
    rpByUserId = new Map(profiles.map((entry) => [entry.userId, entry.profile.rp]));
  }

  return players.map((player, index) => {
    const user = users[index];
    const rankPoints = matchMode === 'ranked' && user?.is_ai && typeof rankedContext?.aiAnchorRp === 'number'
      ? rankedContext.aiAnchorRp
      : rpByUserId.get(player.user_id);

    return {
      userId: player.user_id,
      username: user?.nickname ?? 'Player',
      avatarUrl: user?.avatar_url ?? null,
      seat: player.seat,
      ...(rankPoints != null ? { rankPoints } : {}),
    };
  });
}

async function emitRejoinAvailable(
  socket: QuizballSocket,
  match: { id: string; mode: 'friendly' | 'ranked'; state_payload: unknown },
  userId: string,
  graceMs: number
): Promise<void> {
  const opponent = await getOpponentInfo(match.id, userId);
  const players = await matchesRepo.listMatchPlayers(match.id);
  const users = await Promise.all(players.map((player) => usersRepo.getById(player.user_id)));
  socket.emit('match:rejoin_available', {
    matchId: match.id,
    mode: match.mode,
    variant: resolveMatchVariant(match.state_payload, match.mode),
    opponent,
    participants: players.map((player, index) => ({
      userId: player.user_id,
      username: users[index]?.nickname ?? 'Player',
      avatarUrl: users[index]?.avatar_url ?? null,
      seat: player.seat,
    })),
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
  standings?: Array<{
    userId: string;
    rank: number;
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
  }>;
  unlockedAchievements?: Record<string, AchievementUnlockPayload[]>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit' | null;
  totalPointsFallbackUsed?: boolean;
  rankedOutcome?: Awaited<ReturnType<typeof rankedService.getMatchOutcome>> | null;
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

  const standings = buildStandings(players);
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  const unlockedAchievements = await achievementsService.listUnlockedForMatch(matchId);
  const seat1UserId = players.find((player) => player.seat === 1)?.user_id ?? null;
  const seat2UserId = players.find((player) => player.seat === 2)?.user_id ?? null;
  const fallbackWinnerId = standings[0]?.userId ?? seat1UserId ?? seat2UserId ?? players[0]?.user_id ?? null;
  const statePayload = (match.state_payload ?? {}) as Partial<{
    goals: { seat1?: number; seat2?: number };
    penaltyGoals: { seat1?: number; seat2?: number };
  }>;
  const goalsSeat1 = Number(statePayload.goals?.seat1 ?? 0);
  const goalsSeat2 = Number(statePayload.goals?.seat2 ?? 0);
  const penaltiesSeat1 = Number(statePayload.penaltyGoals?.seat1 ?? 0);
  const penaltiesSeat2 = Number(statePayload.penaltyGoals?.seat2 ?? 0);
  const seat1Points = players.find((player) => player.seat === 1)?.total_points ?? 0;
  const seat2Points = players.find((player) => player.seat === 2)?.total_points ?? 0;
  const derivedWinnerId =
    variant === 'friendly_party_quiz'
      ? (standings[0]?.userId ?? fallbackWinnerId)
      : goalsSeat1 > goalsSeat2
        ? (seat1UserId ?? fallbackWinnerId)
        : goalsSeat2 > goalsSeat1
          ? (seat2UserId ?? fallbackWinnerId)
          : penaltiesSeat1 > penaltiesSeat2
            ? (seat1UserId ?? fallbackWinnerId)
            : penaltiesSeat2 > penaltiesSeat1
              ? (seat2UserId ?? fallbackWinnerId)
              : seat1Points > seat2Points
                ? (seat1UserId ?? fallbackWinnerId)
                : seat2Points > seat1Points
                  ? (seat2UserId ?? fallbackWinnerId)
                  : fallbackWinnerId;

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
    (
      match.state_payload as {
        winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit';
      } | null
    )?.winnerDecisionMethod ?? null;

  let rankedOutcome = null;
  if (match.mode === 'ranked') {
    try { rankedOutcome = await rankedService.getMatchOutcome(matchId); }
    catch (err) { logger.warn({ err, matchId }, 'Failed to fetch ranked outcome for replay'); }
  }

  return {
    matchId,
    winnerId: match.winner_user_id ?? derivedWinnerId,
    players: payloadPlayers,
    ...(variant === 'friendly_party_quiz' ? { standings } : {}),
    unlockedAchievements,
    durationMs,
    resultVersion,
    winnerDecisionMethod,
    totalPointsFallbackUsed: winnerDecisionMethod === 'total_points_fallback',
    ...(rankedOutcome ? { rankedOutcome } : {}),
  };
}

async function createOrJoinFriendlyRematchLobby(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<string | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match || match.mode !== 'friendly' || match.status !== 'completed') {
    return null;
  }

  const players = await matchesRepo.listMatchPlayers(matchId);
  if (!players.some((player) => player.user_id === userId)) {
    return null;
  }

  let rematchLobbyId = await getWaitingRematchLobbyId(matchId);
  const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId, {
    ...(rematchLobbyId ? { keepWaitingLobbyId: rematchLobbyId } : {}),
  });
  if (!prepared.ok) {
    return null;
  }

  if (!rematchLobbyId) {
    const sourceLobby = match.lobby_id ? await lobbiesRepo.getById(match.lobby_id) : null;
    const rematchLobby = await lobbiesRepo.createLobby({
      mode: 'friendly',
      hostUserId: userId,
      inviteCode: generateInviteCode(6),
      isPublic: sourceLobby?.is_public ?? false,
      displayName: generateLobbyName(),
      gameMode: 'friendly_possession',
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    });
    rematchLobbyId = rematchLobby.id;
    setWaitingRematchLobbyId(matchId, rematchLobby.id);
  }

  const members = await lobbiesRepo.listMembersWithUser(rematchLobbyId);
  const alreadyMember = members.some((member) => member.user_id === userId);
  if (!alreadyMember) {
    await lobbiesRepo.addMember(rematchLobbyId, userId, false);
    await syncFriendlyLobbyModeForMemberCount(rematchLobbyId, {
      clearReadyOnPartyTransition: members.length <= 2,
    });
  }

  await detachUserSocketsFromMatch(io, userId, matchId);
  await attachUserSocketsToLobby(io, userId, rematchLobbyId);
  await emitLobbyState(io, rematchLobbyId);
  return rematchLobbyId;
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
  if (!match || players.length === 0) {
    logger.warn(
      { lobbyId, matchId, hasMatch: Boolean(match), playerCount: players.length },
      'Match start aborted: invalid match context'
    );
    return;
  }
  const variant = resolveMatchVariant(match.state_payload, match.mode);

  let members: MatchStartMember[] = lobbyMembers.map((member) => ({
    user_id: member.user_id,
    nickname: member.nickname,
    avatar_url: member.avatar_url,
  }));
  if (members.length !== players.length) {
    logger.warn(
      { lobbyId, matchId, memberCount: members.length, playerCount: players.length },
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

  if (variant !== 'friendly_party_quiz') {
    const cache = buildInitialCache({ match, players });
    await setMatchCache(cache);
  }

  const seatByUserId = new Map(players.map((player) => [player.user_id, player.seat]));

  let rpByUserId = new Map<string, number>();
  if (match.mode === 'ranked') {
    const profiles = await Promise.all(
      members.map(async (member) => ({
        userId: member.user_id,
        profile: await rankedService.ensureProfile(member.user_id),
      }))
    );
    rpByUserId = new Map(profiles.map((entry) => [entry.userId, entry.profile.rp]));
  }

  const participants = members.map((member) => ({
    userId: member.user_id,
    username: member.nickname ?? 'Player',
    avatarUrl: member.avatar_url,
    seat: seatByUserId.get(member.user_id) ?? 0,
    ...(rpByUserId.has(member.user_id) ? { rankPoints: rpByUserId.get(member.user_id) } : {}),
  }));

  await Promise.all(
    members.map(async (member) => {
      const opponent = members.find((candidate) => candidate.user_id !== member.user_id) ?? member;
      io.to(`user:${member.user_id}`).emit('match:start', {
        matchId,
        mode: match.mode,
        variant,
        mySeat: seatByUserId.get(member.user_id) ?? undefined,
        opponent: {
          id: opponent.user_id,
          username: opponent.nickname ?? 'Player',
          avatarUrl: opponent.avatar_url,
          ...(rpByUserId.has(opponent.user_id) ? { rp: rpByUserId.get(opponent.user_id) } : {}),
        },
        participants,
      });
    })
  );

  if (variant === 'friendly_party_quiz') {
    await emitPartyQuizState(io, matchId);
  }

  const redis = getRedisClient();
  if (redis?.isOpen) {
    if (match?.mode === 'ranked') {
      const aiUserId = await redis.get(rankedAiLobbyKey(lobbyId));
      if (aiUserId) {
        await redis.set(rankedAiMatchKey(matchId), aiUserId, { EX: FORFEIT_TTL_SEC });
      }
      await redis.del(rankedAiLobbyKey(lobbyId));
    }

    await Promise.all(
      members.map((member) =>
        redis.set(matchPresenceKey(matchId, member.user_id), '1', { EX: PRESENCE_TTL_SEC })
      )
    );
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
    void (async () => {
      try {
        const match = await matchesRepo.getMatch(matchId);
        if (!match || match.status !== 'active') {
          logger.info({ matchId, status: match?.status }, 'Skipping first question — match no longer active');
          return;
        }
        await sendMatchQuestion(io, matchId, 0);
      } catch (error) {
        logger.error({ error, matchId }, 'Failed to send first match question after countdown');
      }
    })();
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
    const opponent = await getOpponentInfoFromParticipants(participants, userId, match.mode, match.ranked_context);
    const participantPayloads = await buildParticipantPayloads(participants, match.mode, match.ranked_context);
    const mySeat = participants.find((player) => player.user_id === userId)?.seat;
    const variant = resolveMatchVariant(match.state_payload, match.mode);
    socket.emit('match:start', {
      matchId: match.id,
      mode: match.mode,
      variant,
      mySeat: mySeat ?? undefined,
      opponent,
      participants: participantPayloads,
    });
    if (variant === 'friendly_party_quiz') {
      await emitPartyQuizStateToSocket(socket, match.id);
    } else {
      await emitPossessionStateToSocket(socket, match.id);
    }

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
      appMetrics.socketReconnects.add(1, { match_mode: match.mode, variant });
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
        const variant = resolveMatchVariant(activeMatch.state_payload, activeMatch.mode);
        const isParticipant = roster.some((player) => player.user_id === userId);
        if (!isParticipant) {
          socket.emit('error', {
            code: 'MATCH_NOT_ALLOWED',
            message: 'You are not a participant in this match',
          });
          return;
        }

        if (cache && cache.status === 'active' && variant !== 'friendly_party_quiz') {
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

        const winnerId =
          variant === 'friendly_party_quiz'
            ? buildStandings(
                (await matchesRepo.listMatchPlayers(activeMatch.id)).filter((player) => player.user_id !== userId)
              )[0]?.userId ?? null
            : roster.find((player) => player.user_id !== userId)?.user_id ?? null;
        if (winnerId && variant !== 'friendly_party_quiz') {
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
        if (variant !== 'friendly_party_quiz') {
          cancelPossessionHalftimeTimer(activeMatch.id);
        }
        await matchesRepo.completeMatch(activeMatch.id, winnerId);
        await deleteMatchCache(activeMatch.id);

        if (activeMatch.mode === 'ranked') {
          try { await rankedService.settleCompletedRankedMatch(activeMatch.id); }
          catch (err) { logger.warn({ err, matchId: activeMatch.id }, 'Ranked settlement failed in forfeit'); }
        }

        try { await progressionService.awardCompletedMatchXp(activeMatch.id); }
        catch (err) { logger.warn({ err, matchId: activeMatch.id }, 'Match XP award failed in forfeit'); }

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

        const opponent = await getOpponentInfoFromParticipants(participants, userId, match.mode, match.ranked_context);
        const participantPayloads = await buildParticipantPayloads(participants, match.mode, match.ranked_context);
        const mySeat = participants.find((player) => player.user_id === userId)?.seat;
        const variant = resolveMatchVariant(match.state_payload, match.mode);
        socket.emit('match:start', {
          matchId: match.id,
          mode: match.mode,
          variant,
          mySeat: mySeat ?? undefined,
          opponent,
          participants: participantPayloads,
        });
        if (variant === 'friendly_party_quiz') {
          await emitPartyQuizStateToSocket(socket, match.id);
        } else {
          await emitPossessionStateToSocket(socket, match.id);
        }

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

  async handlePlayAgain(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: MatchPlayAgainPayload
  ): Promise<void> {
    const userId = socket.data.user.id;
    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        const match = await matchesRepo.getMatch(payload.matchId);
        if (!match || match.mode !== 'friendly' || match.status !== 'completed') {
          socket.emit('error', {
            code: 'MATCH_NOT_COMPLETED',
            message: 'Play Again is only available after a completed friendly match',
          });
          return;
        }

        const players = await matchesRepo.listMatchPlayers(payload.matchId);
        if (!players.some((player) => player.user_id === userId)) {
          socket.emit('error', {
            code: 'NOT_IN_MATCH',
            message: 'You were not part of this match',
          });
          return;
        }

        const rematchLobbyId = await createOrJoinFriendlyRematchLobby(io, userId, payload.matchId);
        if (!rematchLobbyId) {
          socket.emit('error', {
            code: 'MATCH_PLAY_AGAIN_UNAVAILABLE',
            message: 'Unable to create a rematch lobby right now',
          });
          return;
        }

        logger.info(
          { matchId: payload.matchId, rematchLobbyId, userId },
          'Friendly play again moved user into rematch lobby'
        );
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Match transition is in progress. Please retry.',
        operation: 'match:play_again',
      }
    );
    if (!completed) return;
    await userSessionGuardService.emitState(io, userId);
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
    const variant = resolveMatchVariant(match.state_payload, match.mode);
    appMetrics.matchPauses.add(1, { match_mode: match.mode, variant });

    const redis = getRedisClient();
    if (!redis) return;

    await redis.set(matchDisconnectKey(matchId, userId), String(Date.now()), { EX: DISCONNECT_TTL_SEC });
    await redis.set(matchPauseKey(matchId), '1', { EX: PRESENCE_TTL_SEC });

    cancelMatchQuestionTimer(matchId, match.current_q_index);
    if (variant !== 'friendly_party_quiz') {
      cancelPossessionHalftimeTimer(matchId);
    }

    const players = await matchesRepo.listMatchPlayers(matchId);
    const remainingPlayers = players.filter((player) => player.user_id !== userId);
    remainingPlayers.forEach((player) => {
      io.to(`user:${player.user_id}`).emit('match:opponent_disconnected', {
        matchId,
        opponentId: userId,
        graceMs: MATCH_DISCONNECT_GRACE_MS,
      });
    });

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
                (await matchesRepo.listMatchPlayers(matchId)).filter((player) => !disconnected.includes(player.user_id))
              )[0]?.userId ?? null
            : roster.find((player) => !disconnected.includes(player.user_id))?.user_id ?? null;
        if (winnerId && variant !== 'friendly_party_quiz') {
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
        if (variant !== 'friendly_party_quiz') {
          cancelPossessionHalftimeTimer(matchId);
        }

        if (activeMatch.mode === 'ranked') {
          try { await rankedService.settleCompletedRankedMatch(matchId); }
          catch (err) { logger.warn({ err, matchId }, 'Ranked settlement failed in grace expiry'); }
        }

        try { await progressionService.awardCompletedMatchXp(matchId); }
        catch (err) { logger.warn({ err, matchId }, 'Match XP award failed in grace expiry'); }

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

  async handleHalftimeBan(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { matchId: string; categoryId: string }
  ): Promise<void> {
    const match = await matchesRepo.getMatch(payload.matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found for halftime category ban.',
      });
      return;
    }

    if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
      socket.emit('error', {
        code: 'MATCH_NOT_ALLOWED',
        message: 'Party quiz does not support halftime bans.',
      });
      return;
    }

    await handlePossessionHalftimeBan(io, socket, payload);
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

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found',
      });
      return;
    }

    if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
      await handlePartyQuizAnswer(io, socket, payload);
      return;
    }

    await handlePossessionAnswer(io, socket, payload);
  },

  async handleChanceCardUse(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: MatchChanceCardUsePayload
  ): Promise<void> {
    const { matchId } = payload;

    const redis = getRedisClient();
    if (redis) {
      const paused = await redis.exists(matchPauseKey(matchId));
      if (paused) {
        socket.emit('error', {
          code: 'MATCH_PAUSED',
          message: 'Match is paused. Please wait for your opponent to return.',
          meta: {
            matchId: payload.matchId,
            qIndex: payload.qIndex,
            clientActionId: payload.clientActionId,
          },
        });
        return;
      }
    }

    const match = await matchesRepo.getMatch(matchId);
    if (!match || match.status !== 'active') {
      socket.emit('error', {
        code: 'MATCH_NOT_ACTIVE',
        message: 'No active match found',
      });
      return;
    }

    if (resolveMatchVariant(match.state_payload, match.mode) === 'friendly_party_quiz') {
      socket.emit('error', {
        code: 'CHANCE_CARD_NOT_ALLOWED',
        message: 'Power-ups are not available in party quiz mode.',
        meta: {
          matchId: payload.matchId,
          qIndex: payload.qIndex,
          clientActionId: payload.clientActionId,
        },
      });
      return;
    }

    await handlePossessionChanceCardUse(io, socket, payload);
  },
};
