import type { User } from '../../db/types.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { countryPayload } from '../../core/country.js';
import { logger } from '../../core/logger.js';
import { appMetrics } from '../../core/metrics.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { statsService } from '../../modules/stats/stats.service.js';
import { rankedService, parseRankedContext } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { parseStoredAvatarCustomization } from '../../modules/users/avatar-customization.js';
import { rankedAiLobbyKey, rankedAiMatchKey } from '../ai-ranked.constants.js';
import { trackPartyQuizStarted } from '../../core/analytics/game-events.js';
import { buildInitialCache, setMatchCache } from '../match-cache.js';
import { sendMatchQuestion } from '../match-flow.js';
import { getCurrentCountriesForUsers } from '../session-country.js';
import {
  matchDisconnectKey,
  matchGraceKey,
  matchPauseKey,
  matchPresenceKey,
} from '../match-keys.js';
import {
  isPartyQuizDropped,
  sanitizePartyQuizState,
} from '../party-quiz-state.js';
import {
  emitPossessionStateToSocket,
  ensurePossessionActiveTimers,
  emitMatchState,
} from '../possession-match-flow.js';
import {
  emitPartyQuizState,
  emitPartyQuizStateToSocket,
  ensurePartyQuizActiveTimer,
} from '../party-quiz-match-flow.js';
import { getRedisClient } from '../redis.js';
import {
  getDisconnectCount,
  toRemainingReconnects,
} from './match-disconnect.service.js';
import {
  buildPartyDropoutPayload,
  setPartyDropoutPendingForUser,
} from './party-quiz-dropout.service.js';
import {
  buildParticipantPayloads,
  getOpponentInfo,
  getOpponentInfoFromParticipants,
  getParticipantSnapshot,
  resolveMatchCategoryName,
} from './match-participants.helpers.js';

const MATCH_DISCONNECT_GRACE_MS = 60000;
const MATCH_START_COUNTDOWN_SEC = 5;
const PARTY_QUIZ_MATCH_START_COUNTDOWN_SEC = 5;
const PRESENCE_TTL_SEC = 75;
const FORFEIT_TTL_SEC = 600;

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
  const currentCountriesByUserId = await getCurrentCountriesForUsers(players.map((player) => player.user_id));
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
        ...countryPayload(currentCountriesByUserId.get(player.user_id) ?? user?.country),
      };
    }),
    graceMs,
    remainingReconnects,
  });
}

export async function beginMatchForLobby(
  io: QuizballServer,
  lobbyId: string,
  matchId: string,
  options?: { countdownSec?: number }
): Promise<void> {
  const lobbyMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
  type MatchStartMember = Pick<(typeof lobbyMembers)[number], 'user_id' | 'nickname' | 'avatar_url' | 'avatar_customization' | 'favorite_club'> & { country?: string | null };
  const match = await matchesRepo.getMatch(matchId);
  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  if (!match || players.length === 0) {
    logger.warn(
      { lobbyId, matchId, hasMatch: Boolean(match), playerCount: players.length },
      'Match start aborted: invalid match context'
    );
    return;
  }

  const variantForCountdown = resolveMatchVariant(match.state_payload, match.mode);
  const defaultCountdownSec = variantForCountdown === 'friendly_party_quiz'
    ? PARTY_QUIZ_MATCH_START_COUNTDOWN_SEC
    : MATCH_START_COUNTDOWN_SEC;
  const countdownSec = Math.max(
    0,
    Number.isFinite(options?.countdownSec)
      ? Math.floor(options?.countdownSec ?? defaultCountdownSec)
      : defaultCountdownSec
  );
  const countdownMs = countdownSec * 1000;
  const variant = variantForCountdown;

  let members: MatchStartMember[];
  // Country (only used for the matchmaking-map pin) must not block match start.
  const lobbyMemberIds = lobbyMembers.map((member) => member.user_id);
  const currentCountriesByUserId = await getCurrentCountriesForUsers(lobbyMemberIds);
  let memberUsersSettled: PromiseSettledResult<User | null>[];
  try {
    const lobbyUsersById = await usersRepo.getByIds(lobbyMemberIds);
    memberUsersSettled = lobbyMemberIds.map((userId) => ({
      status: 'fulfilled',
      value: lobbyUsersById.get(userId) ?? null,
    }));
  } catch (reason) {
    memberUsersSettled = lobbyMemberIds.map(() => ({
      status: 'rejected',
      reason,
    }));
  }
  const memberCountry = (index: number): string | null => {
    const currentCountry = currentCountriesByUserId.get(lobbyMemberIds[index] ?? '');
    if (currentCountry) return currentCountry;
    const result = memberUsersSettled[index];
    if (result?.status !== 'fulfilled') return null;
    return result.value?.country ?? null;
  };
  members = lobbyMembers.map((member, index) => ({
    user_id: member.user_id,
    nickname: member.nickname,
    avatar_url: member.avatar_url,
    avatar_customization: member.avatar_customization,
    favorite_club: member.favorite_club,
    country: memberCountry(index),
  }));
  if (members.length !== players.length) {
    logger.warn(
      { lobbyId, matchId, memberCount: members.length, playerCount: players.length },
      'Match start member count invalid, falling back to match players'
    );
    const playerUserIds = players.map((player) => player.user_id);
    const currentPlayerCountriesByUserId = await getCurrentCountriesForUsers(playerUserIds);
    let usersSettled: PromiseSettledResult<User | null>[];
    try {
      const playerUsersById = await usersRepo.getByIds(playerUserIds);
      usersSettled = playerUserIds.map((userId) => ({
        status: 'fulfilled',
        value: playerUsersById.get(userId) ?? null,
      }));
    } catch (reason) {
      usersSettled = playerUserIds.map(() => ({
        status: 'rejected',
        reason,
      }));
    }
    const playerUser = (index: number) => {
      const result = usersSettled[index];
      return result?.status === 'fulfilled' ? result.value : null;
    };
    members = players.map((player, index) => {
      const user = playerUser(index);
      return {
        user_id: player.user_id,
        nickname: user?.nickname ?? 'Player',
        avatar_url: user?.avatar_url ?? null,
        avatar_customization: user?.avatar_customization ?? null,
        favorite_club: user?.favorite_club ?? null,
        country: currentPlayerCountriesByUserId.get(player.user_id) ?? user?.country ?? null,
      };
    });
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

  const initialPossessionCache = variant !== 'friendly_party_quiz'
    ? buildInitialCache({ match, players })
    : null;
  if (initialPossessionCache) {
    await setMatchCache(initialPossessionCache);
  }

  const seatByUserId = new Map(players.map((player) => [player.user_id, player.seat]));

  let rpByUserId = new Map<string, number>();
  if (match.mode === 'ranked') {
    const memberUsersById = await usersRepo.getByIds(members.map((member) => member.user_id));
    const memberUsers = members.map((member) => memberUsersById.get(member.user_id) ?? null);
    const rankedContext = parseRankedContext(match.ranked_context);
    const profiles = await Promise.all(
      members.map(async (member, index) => {
        const memberUser = memberUsers[index];
        if (memberUser?.is_ai && typeof rankedContext?.aiAnchorRp === 'number') {
          return { userId: member.user_id, rp: rankedContext.aiAnchorRp };
        }
        const profile = await rankedService.ensureProfile(member.user_id);
        return { userId: member.user_id, rp: profile.rp };
      })
    );
    rpByUserId = new Map(profiles.map((entry) => [entry.userId, entry.rp]));
  }

  const participants = members.map((member) => ({
    userId: member.user_id,
    username: member.nickname ?? 'Player',
    avatarUrl: member.avatar_url,
    avatarCustomization: parseStoredAvatarCustomization(member.avatar_customization),
    seat: seatByUserId.get(member.user_id) ?? 0,
    ...(rpByUserId.has(member.user_id) ? { rankPoints: rpByUserId.get(member.user_id) } : {}),
    ...countryPayload(member.country),
  }));

  // Fetch recent form (W/L/D × 3) for each member up-front so each emit can
  // include both the recipient's own form and their opponent's.
  const recentFormByUserId = new Map<string, Array<'W' | 'L' | 'D'>>();
  await Promise.all(
    members.map(async (m) => {
      try {
        recentFormByUserId.set(m.user_id, await statsService.getRecentFormForUser(m.user_id, 3));
      } catch (err) {
        logger.warn({ err, userId: m.user_id }, 'Failed to load recent form for showdown (non-fatal)');
        recentFormByUserId.set(m.user_id, []);
      }
    }),
  );

  // Resolve the first-half category name so the client's round-1 intro
  // doesn't flash a placeholder while waiting for match:question.
  const categoryName = await resolveMatchCategoryName(match.category_a_id);

  await Promise.all(
    members.map(async (member) => {
      const opponent = members.find((candidate) => candidate.user_id !== member.user_id) ?? member;
      io.to(`user:${member.user_id}`).emit('match:start', {
        matchId,
        mode: match.mode,
        variant,
        mySeat: seatByUserId.get(member.user_id) ?? undefined,
        myRecentForm: recentFormByUserId.get(member.user_id) ?? [],
        opponent: {
          id: opponent.user_id,
          username: opponent.nickname ?? 'Player',
          avatarUrl: opponent.avatar_url,
          avatarCustomization: parseStoredAvatarCustomization(opponent.avatar_customization),
          favoriteClub: opponent.favorite_club,
          recentForm: recentFormByUserId.get(opponent.user_id) ?? [],
          ...(rpByUserId.has(opponent.user_id) ? { rp: rpByUserId.get(opponent.user_id) } : {}),
          ...countryPayload(opponent.country),
        },
        participants,
        ...(categoryName ? { categoryName } : {}),
      });
    })
  );

  if (variant === 'friendly_party_quiz') {
    await emitPartyQuizState(io, matchId);
    logger.info(
      {
        eventName: 'party_match_started',
        matchId,
        lobbyId,
        playerCount: members.length,
        countdownSec,
        totalQuestions: match.total_questions,
      },
      'Party quiz match started'
    );
    // Analytics: per-member party_quiz_started event.
    try {
      for (const member of members) {
        trackPartyQuizStarted({ userId: member.user_id, matchId, playerCount: members.length });
      }
    } catch (err) {
      logger.warn({ err, matchId }, 'party_quiz_started analytics failed');
    }
  } else if (initialPossessionCache) {
    await emitMatchState(io, matchId, initialPossessionCache.statePayload);
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

  const countdownScheduledAtMs = Date.now();
  const startsAt = new Date(countdownScheduledAtMs + countdownMs).toISOString();
  io.to(`match:${matchId}`).emit('match:countdown', {
    matchId,
    seconds: countdownSec,
    startsAt,
    serverNow: new Date(countdownScheduledAtMs).toISOString(),
    reason: 'kickoff',
  });
  logger.info(
    { eventName: 'match:countdown', matchId, variant, seconds: countdownSec, startsAt, reason: 'kickoff' },
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
        logger.info(
          { eventName: 'match:first_question_dispatch', matchId, variant: resolveMatchVariant(match.state_payload, match.mode) },
          'Dispatching first match question after countdown'
        );
        await sendMatchQuestion(io, matchId, 0);
      } catch (error) {
        logger.error({ error, matchId }, 'Failed to send first match question after countdown');
      }
    })();
  }, countdownMs);
}

export async function rejoinActiveMatchOnConnect(
  io: QuizballServer,
  socket: QuizballSocket
): Promise<void> {
  const userId = socket.data.user.id;
  const match = await matchesRepo.getActiveMatchForUser(userId);
  if (!match) return;

  const redis = getRedisClient();
  const isPaused = redis ? (await redis.exists(matchPauseKey(match.id))) === 1 : false;
  const wasDisconnected = redis ? (await redis.exists(matchDisconnectKey(match.id, userId))) === 1 : false;
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
          source: 'connect_dropped_party_user',
        },
        'Dropped party quiz player connected'
      );
      return;
    }
  }

  if (redis && isPaused && wasDisconnected) {
    const graceTtlSec = await redis.ttl(matchGraceKey(match.id));
    const graceMs = graceTtlSec > 0 ? graceTtlSec * 1000 : MATCH_DISCONNECT_GRACE_MS;
    const remainingReconnects = toRemainingReconnects(await getDisconnectCount(match.id, userId));
    appMetrics.socketReconnects.add(1, { match_mode: match.mode, variant });
    await emitRejoinAvailable(socket, match, userId, graceMs, remainingReconnects);
    if (variant === 'friendly_party_quiz') {
      logger.info(
        {
          eventName: 'match:rejoin_available',
          matchId: match.id,
          userId,
          variant,
          graceMs,
          remainingReconnects,
          source: 'connect_paused_disconnected',
        },
        'Party quiz rejoin available emitted on connect'
      );
    }
    return;
  }

  socket.join(`match:${match.id}`);
  socket.data.matchId = match.id;

  const { participants } = await getParticipantSnapshot(match.id);
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

  if (redis) {
    await redis.set(matchPresenceKey(match.id, userId), '1', { EX: PRESENCE_TTL_SEC });
  }

  if (redis && isPaused) {
    const otherParticipants = participants.filter((participant) => participant.user_id !== userId);
    const disconnectedExists = await Promise.all(
      otherParticipants.map((participant) =>
        redis.exists(matchDisconnectKey(match.id, participant.user_id))
      )
    );
    const disconnectedPlayers = otherParticipants
      .filter((_, index) => disconnectedExists[index])
      .map((participant) => participant.user_id);
    const disconnectedUserId = disconnectedPlayers[0];
    if (disconnectedUserId) {
      const graceTtlSec = await redis.ttl(matchGraceKey(match.id));
      const graceMs = graceTtlSec > 0 ? graceTtlSec * 1000 : MATCH_DISCONNECT_GRACE_MS;
      const remainingReconnects = toRemainingReconnects(
        await getDisconnectCount(match.id, disconnectedUserId)
      );
      socket.emit('match:opponent_disconnected', {
        matchId: match.id,
        opponentId: disconnectedUserId,
        graceMs,
        remainingReconnects,
      });
    }
    return;
  }

  if (variant === 'friendly_party_quiz') {
    logger.info(
      {
        eventName: 'party_rejoin_active_on_connect',
        matchId: match.id,
        userId,
        isPaused,
        wasDisconnected,
      },
      'Party quiz active match rejoined on connect'
    );
    await emitPartyQuizStateToSocket(socket, match.id);
    await ensurePartyQuizActiveTimer(io, match.id);
  } else {
    await emitPossessionStateToSocket(socket, match.id);
    await ensurePossessionActiveTimers(io, match.id);
  }
}
