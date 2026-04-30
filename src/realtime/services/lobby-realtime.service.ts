import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import {
  lobbiesService,
  MIN_QUESTIONS_PER_CATEGORY,
} from '../../modules/lobbies/lobbies.service.js';
import { categoriesRepo } from '../../modules/categories/categories.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { storeService } from '../../modules/store/store.service.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import {
  generateRankedAiProfile,
  generateRankedAiGeo,
  rankedAiLobbyKey,
} from '../ai-ranked.constants.js';
import {
  FRIENDLY_LOBBY_MAX_MEMBERS,
  attachUserSocketsToLobby,
  emitLobbyState,
  generateInviteCode,
  generateLobbyName,
  normalizeFriendlyGameMode,
  syncFriendlyLobbyModeForMemberCount,
  syncFriendlyLobbyModeForMemberCountLocked,
} from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';
import { withSpan } from '../../core/tracing.js';

const DRAFT_START_GUARD_PREFIX = 'draft:starting:';
const DRAFT_START_GUARD_TTL_SEC = 15;
const LOBBY_DISCONNECT_GRACE_MS = 15000;
const RANKED_SIM_SEARCH_MIN_MS = 3000;
const RANKED_SIM_SEARCH_MAX_MS = 10000;
const RANKED_SIM_FOUND_MODAL_MS = 1200;
const RANKED_AI_KEY_TTL_SEC = 7200;
const LOBBY_LOCK_WAIT_MS = 1200;
const LOBBY_LOCK_RETRY_INTERVAL_MS = 75;

// Fallback guard when Redis is unavailable (single instance only).
const draftStartingSet = new Set<string>();

function resolveLobbyId(socket: QuizballSocket, lobbyId?: string): string | undefined {
  return lobbyId ?? socket.data.lobbyId;
}

function randomIntBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isRankedAiLobby(lobby: { mode: string }): boolean {
  return lobby.mode === 'ranked';
}

async function getRankedAiUserIdForLobby(lobbyId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  return redis.get(rankedAiLobbyKey(lobbyId));
}

async function resolveRankedAiUserIdForDraft(
  lobbyId: string,
  members: Array<{ user_id: string }>
): Promise<string | null> {
  const aiUserIdFromRedis = await getRankedAiUserIdForLobby(lobbyId);
  if (aiUserIdFromRedis && members.some((member) => member.user_id === aiUserIdFromRedis)) {
    return aiUserIdFromRedis;
  }

  const users = await Promise.all(
    members.map(async (member) => ({
      userId: member.user_id,
      user: await usersRepo.getById(member.user_id),
    }))
  );
  const aiMember = users.find((entry) => entry.user?.is_ai);
  if (!aiMember) return null;

  const redis = getRedisClient();
  if (redis) {
    await redis.set(rankedAiLobbyKey(lobbyId), aiMember.userId, { EX: RANKED_AI_KEY_TTL_SEC });
  }
  return aiMember.userId;
}

async function tryAcquireDraftStartGuard(lobbyId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    const key = `${DRAFT_START_GUARD_PREFIX}${lobbyId}`;
    const result = await redis.set(key, '1', { NX: true, EX: DRAFT_START_GUARD_TTL_SEC });
    return result === 'OK';
  }

  if (draftStartingSet.has(lobbyId)) return false;
  draftStartingSet.add(lobbyId);
  return true;
}

async function releaseDraftStartGuard(lobbyId: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(`${DRAFT_START_GUARD_PREFIX}${lobbyId}`);
  }
  draftStartingSet.delete(lobbyId);
}

async function transferHostIfNeeded(lobbyId: string, previousHostId: string): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length === 0) return;
  const nextHostId = members[0]?.user_id;
  if (nextHostId && nextHostId !== previousHostId) {
    await lobbiesRepo.setHostUser(lobbyId, nextHostId);
  }
}

async function removeUserFromLobbySockets(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    if (socket.data.user.id !== userId) return;
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
}

async function autoLeaveLobby(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  await lobbiesRepo.removeMember(lobbyId, userId);

  if (lobby && isRankedAiLobby(lobby)) {
    const aiUserId = await getRankedAiUserIdForLobby(lobbyId);
    if (aiUserId) {
      await lobbiesRepo.removeMember(lobbyId, aiUserId);
    }
    const redis = getRedisClient();
    if (redis) {
      await redis.del(rankedAiLobbyKey(lobbyId));
    }
  }
  await removeUserFromLobbySockets(io, lobbyId, userId);
  logger.info({ lobbyId, userId }, 'Auto-removed from previous lobby');

  const closed = await closeLobbyIfEmpty(io, lobbyId);
  if (closed) {
    return;
  }

  if (lobby && lobby.status === 'waiting' && lobby.host_user_id === userId) {
    await transferHostIfNeeded(lobbyId, userId);
  }

  await syncFriendlyLobbyModeForMemberCount(lobbyId);

  await emitLobbyState(io, lobbyId);
}

async function autoLeaveAllWaitingLobbies(
  io: QuizballServer,
  userId: string,
  keepLobbyId?: string
): Promise<void> {
  const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
  const waitingLobbies = openLobbies.filter(
    (lobby) => lobby.status === 'waiting' && lobby.id !== keepLobbyId
  );

  for (const lobby of waitingLobbies) {
    await autoLeaveLobby(io, lobby.id, userId);
  }
}

async function acquireLobbyLockWithRetry(
  lobbyId: string,
  ttlMs = 3000,
  waitMs = LOBBY_LOCK_WAIT_MS
): Promise<Awaited<ReturnType<typeof acquireLock>>> {
  const key = `lock:lobby:${lobbyId}`;
  const deadline = Date.now() + Math.max(0, waitMs);

  while (true) {
    const lock = await acquireLock(key, ttlMs);
    if (lock.acquired && lock.token) {
      return lock;
    }
    if (Date.now() >= deadline) {
      return { acquired: false };
    }
    const remainingMs = deadline - Date.now();
    const sleepMs = Math.min(LOBBY_LOCK_RETRY_INTERVAL_MS, remainingMs);
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}

async function closeLobbyIfEmpty(io: QuizballServer, lobbyId: string): Promise<boolean> {
  const memberCount = await lobbiesRepo.countMembers(lobbyId);
  if (memberCount > 0) return false;
  await lobbiesRepo.deleteLobby(lobbyId);
  await warmupRealtimeService.cleanupLobby(lobbyId);
  logger.info({ lobbyId }, 'Lobby deleted (no members)');
  io.to(`lobby:${lobbyId}`).emit('lobby:state', {
    lobbyId,
    mode: 'friendly',
    status: 'closed',
    inviteCode: null,
    displayName: 'Lobby closed',
    isPublic: false,
    hostUserId: '',
    settings: {
      gameMode: 'friendly_possession',
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    },
    members: [],
  });
  return true;
}

async function detachAllSocketsFromLobby(io: QuizballServer, lobbyId: string): Promise<void> {
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
}

async function emitClosedLobbyStateForMode(
  io: QuizballServer,
  lobbyId: string,
  mode: 'friendly' | 'ranked'
): Promise<void> {
  io.to(`lobby:${lobbyId}`).emit('lobby:state', {
    lobbyId,
    mode,
    status: 'closed',
    inviteCode: null,
    displayName: 'Lobby closed',
    isPublic: false,
    hostUserId: '',
    settings: {
      gameMode: mode === 'ranked' ? 'ranked_sim' : 'friendly_possession',
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    },
    members: [],
  });
}

async function abortRankedDraftStartForTickets(
  io: QuizballServer,
  lobby: { id: string; mode: 'friendly' | 'ranked' },
  humanUserIds: string[]
): Promise<void> {
  await lobbiesRepo.deleteLobby(lobby.id);
  await warmupRealtimeService.cleanupLobby(lobby.id);
  const redis = getRedisClient();
  if (redis) {
    await redis.del(rankedAiLobbyKey(lobby.id));
  }
  await emitClosedLobbyStateForMode(io, lobby.id, lobby.mode);
  await detachAllSocketsFromLobby(io, lobby.id);

  for (const userId of humanUserIds) {
    io.to(`user:${userId}`).emit('ranked:queue_left');
    io.to(`user:${userId}`).emit('error', {
      code: 'INSUFFICIENT_TICKETS',
      message: 'A player does not have enough tickets to start ranked.',
      meta: {
        lobbyId: lobby.id,
        source: 'ranked_ticket_check',
      },
    });
    await userSessionGuardService.emitState(io, userId);
  }

  logger.info({ lobbyId: lobby.id, humanUserIds }, 'Ranked draft start aborted: insufficient tickets');
}

export async function startDraft(io: QuizballServer, lobbyId: string): Promise<void> {
  await withSpan('lobby.start_draft', {
    'quizball.lobby_id': lobbyId,
  }, async (span) => {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      span.setAttribute('quizball.lobby_found', false);
      return;
    }
    span.setAttribute('quizball.lobby_found', true);
    span.setAttribute('quizball.lobby_mode', lobby.mode);

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      span.setAttribute('quizball.lock_acquired', false);
      logger.warn({ lobbyId }, 'Draft start skipped: lobby lock not acquired');
      return;
    }

    span.setAttribute('quizball.lock_acquired', true);
    try {
      let rankedMembers: Awaited<ReturnType<typeof lobbiesRepo.listMembersWithUser>> | null = null;
      let rankedAiUserId: string | null = null;

      const categories = lobby.mode === 'ranked'
        ? await lobbiesService.selectRandomRankedCategories(3)
        : await lobbiesService.selectRandomCategories(3);
      span.setAttribute('quizball.category_count', categories.length);
      if (categories.length < 3) {
        logger.warn(
          { lobbyId, categoryCount: categories.length },
          'Draft start failed: insufficient categories with questions'
        );
        await lobbiesRepo.setAllReady(lobbyId, false);
        await emitLobbyState(io, lobbyId);
        io.to(`lobby:${lobbyId}`).emit('error', {
          code: 'INSUFFICIENT_CATEGORIES',
          message: 'Not enough categories with questions to start the game',
        });
        return;
      }

      if (lobby.mode === 'ranked') {
        rankedMembers = await lobbiesRepo.listMembersWithUser(lobbyId);
        rankedAiUserId = await resolveRankedAiUserIdForDraft(lobbyId, rankedMembers);
        const ticketUserIds = rankedMembers
          .filter((member) => member.user_id !== rankedAiUserId)
          .map((member) => member.user_id);

        const consumedTickets = await storeService.consumeRankedTickets(ticketUserIds);
        span.setAttribute('quizball.ticket_users_count', ticketUserIds.length);
        span.setAttribute('quizball.tickets_consumed', Boolean(consumedTickets));
        if (!consumedTickets) {
          await abortRankedDraftStartForTickets(io, lobby, ticketUserIds);
          return;
        }
      }

      await lobbiesRepo.clearLobbyCategoryBans(lobbyId);
      await lobbiesRepo.clearLobbyCategories(lobbyId);
      await lobbiesRepo.insertLobbyCategories(
        lobbyId,
        categories.map((category, index) => ({
          slot: index + 1,
          categoryId: category.id,
        }))
      );
      await lobbiesRepo.setLobbyStatus(lobbyId, 'active');
      await warmupRealtimeService.cleanupLobby(lobbyId);

      let turnUserId = lobby.host_user_id;
      if (lobby.mode === 'ranked') {
        const members = rankedMembers ?? await lobbiesRepo.listMembersWithUser(lobbyId);
        const aiUserId = rankedAiUserId ?? await resolveRankedAiUserIdForDraft(lobbyId, members);
        if (aiUserId) {
          turnUserId =
            members.find((member) => member.user_id !== aiUserId)?.user_id ?? lobby.host_user_id;
        }
      }

      span.setAttribute('quizball.turn_user_id', turnUserId);
      io.to(`lobby:${lobbyId}`).emit('draft:start', {
        lobbyId,
        categories,
        turnUserId,
      });
      logger.info(
        { lobbyId, hostUserId: lobby.host_user_id, turnUserId, categoryCount: categories.length },
        'Draft started'
      );
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  });
}

export async function startRankedAiForUser(
  io: QuizballServer,
  userId: string,
  options?: {
    skipSearchEmit?: boolean;
    searchDurationMs?: number;
  }
): Promise<void> {
  await withSpan('ranked.match_found.ai.prepare', {
    'quizball.user_id': userId,
  }, async (span) => {
    const aiProfile = generateRankedAiProfile();
    const aiUser = await usersRepo.create({
      nickname: aiProfile.username,
      avatarUrl: aiProfile.avatarUrl,
      isAi: true,
    });
    const playerProfile = await rankedService.ensureProfile(userId);
    const rankedContext = rankedService.buildAiMatchContext(playerProfile);

    const lobby = await lobbiesRepo.createLobby({
      mode: 'ranked',
      hostUserId: userId,
      inviteCode: null,
      rankedContext,
    });

    span.setAttribute('quizball.lobby_id', lobby.id);
    span.setAttribute('quizball.ai_user_id', aiUser.id);

    await lobbiesRepo.addMember(lobby.id, userId, true);
    await lobbiesRepo.addMember(lobby.id, aiUser.id, true);

    const redis = getRedisClient();
    if (redis) {
      await redis.set(rankedAiLobbyKey(lobby.id), aiUser.id, { EX: RANKED_AI_KEY_TTL_SEC });
    }

    await attachUserSocketsToLobby(io, userId, lobby.id);
    await emitLobbyState(io, lobby.id);

    const searchDurationMs =
      options?.searchDurationMs ??
      randomIntBetween(RANKED_SIM_SEARCH_MIN_MS, RANKED_SIM_SEARCH_MAX_MS);
    span.setAttribute('quizball.search_duration_ms', searchDurationMs);
    if (!options?.skipSearchEmit) {
      io.to(`user:${userId}`).emit('ranked:search_started', { durationMs: searchDurationMs });
    }
    logger.info(
      { lobbyId: lobby.id, userId, searchDurationMs, skipSearchEmit: options?.skipSearchEmit ?? false },
      'Ranked AI search started'
    );

    setTimeout(
      () =>
        void handleRankedAiMatchFound({
          io,
          lobbyId: lobby.id,
          userId,
          aiUser,
          aiProfile,
          rankedContext,
          lobbiesRepo,
          logger,
          foundModalMs: RANKED_SIM_FOUND_MODAL_MS,
          startDraft,
        }),
      searchDurationMs
    );
  });
}

async function handleRankedAiMatchFound(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  aiProfile: { username: string; avatarUrl: string };
  rankedContext: {
    aiAnchorRp: number;
  };
  lobbiesRepo: typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  foundModalMs: number;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUser, aiProfile, rankedContext, lobbiesRepo, logger, foundModalMs, startDraft } =
    params;

  try {
    const latestLobby = await lobbiesRepo.getById(lobbyId);
    if (!latestLobby || latestLobby.status !== 'waiting' || latestLobby.mode !== 'ranked') {
      return;
    }

    const members = await lobbiesRepo.listMembersWithUser(lobbyId);
    const hasHost = members.some((member) => member.user_id === userId);
    const hasAi = members.some((member) => member.user_id === aiUser.id);
    if (!hasHost || !hasAi) return;

    const playerUser = await usersRepo.getById(userId);
    const aiGeo = generateRankedAiGeo(playerUser?.country);
    io.to(`user:${userId}`).emit('ranked:match_found', {
      lobbyId,
      opponent: {
        id: aiUser.id,
        username: aiUser.nickname ?? aiProfile.username,
        avatarUrl: aiUser.avatar_url ?? aiProfile.avatarUrl,
        rp: rankedContext.aiAnchorRp,
        country: aiGeo.country,
        countryCode: aiGeo.countryCode,
        city: aiGeo.city,
        flag: aiGeo.flag,
        lat: aiGeo.lat,
        lon: aiGeo.lon,
      },
    });
    logger.info({ lobbyId, userId, aiUserId: aiUser.id }, 'Ranked AI match found');

    setTimeout(
      () =>
        void startRankedAiDraft({
          io,
          lobbyId,
          lobbiesRepo,
          logger,
          startDraft,
        }),
      foundModalMs
    );
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed during ranked AI search completion');
  }
}

async function startRankedAiDraft(params: {
  io: QuizballServer;
  lobbyId: string;
  lobbiesRepo: typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, lobbiesRepo, logger, startDraft } = params;
  try {
    const readyLobby = await lobbiesRepo.getById(lobbyId);
    if (!readyLobby || readyLobby.status !== 'waiting' || readyLobby.mode !== 'ranked') {
      return;
    }
    await startDraft(io, lobbyId);
  } catch (error) {
    logger.warn({ error, lobbyId }, 'Failed to start ranked AI draft');
    io.to(`lobby:${lobbyId}`).emit('error', {
      code: 'MATCH_PREPARATION_FAILED',
      message: 'Match preparation got stuck. Please restart ranked matchmaking.',
      meta: {
        lobbyId,
        source: 'ranked_ai_draft_start',
      },
    });
  }
}

export const lobbyRealtimeService = {
  async rejoinWaitingLobbyOnConnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const openLobbies = await lobbiesRepo.listOpenLobbiesForUser(userId);
    const waitingLobbies = openLobbies.filter((lobby) => lobby.status === 'waiting');
    if (waitingLobbies.length === 0) return;

    const newestLobby = waitingLobbies[0];
    await autoLeaveAllWaitingLobbies(io, userId, newestLobby.id);

    await attachUserSocketsToLobby(io, userId, newestLobby.id);
    const state = await lobbiesService.buildLobbyState(newestLobby);
    socket.emit('lobby:state', state);
    logger.info({ userId, lobbyId: newestLobby.id }, 'Socket rejoined waiting lobby');
  },

  async createLobby(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: { mode: 'friendly' | 'ranked'; isPublic?: boolean }
  ): Promise<void> {
    const userId = socket.data.user.id;
    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId);
        if (!prepared.ok) {
          userSessionGuardService.emitBlocked(socket, {
            reason: prepared.reason ?? 'ACTIVE_MATCH',
            message: prepared.message ?? 'You are already in an active match',
            stateSnapshot: prepared.snapshot,
          });
          socket.emit('error', {
            code: 'ALREADY_IN_LOBBY',
            message: prepared.message ?? 'You are already in an active match',
            meta: { stateSnapshot: prepared.snapshot },
          });
          return;
        }

        if (payload.mode === 'ranked') {
          logger.info({ userId }, 'Lobby create (ranked AI simulation) requested');
          await startRankedAiForUser(io, userId);
          return;
        }

        const inviteCode = generateInviteCode(6);
        const displayName = generateLobbyName();
        const lobby = await lobbiesRepo.createLobby({
          mode: 'friendly',
          hostUserId: userId,
          inviteCode,
          isPublic: payload.isPublic ?? false,
          displayName,
        });

        await lobbiesRepo.addMember(lobby.id, userId, false);
        await attachUserSocketsToLobby(io, userId, lobby.id);

        const redactedInvite = inviteCode ? `${inviteCode.slice(0, 2)}***` : null;
        logger.info(
          { lobbyId: lobby.id, hostUserId: userId, inviteCode: redactedInvite },
          'Lobby created'
        );
        await emitLobbyState(io, lobby.id);
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Lobby state transition is in progress. Please retry.',
        operation: 'lobby:create',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async joinByCode(io: QuizballServer, socket: QuizballSocket, inviteCode: string): Promise<void> {
    const userId = socket.data.user.id;
    const normalizedCode = inviteCode.toUpperCase();

    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
        const snapshot = await userSessionGuardService.resolveState(userId);
        if (snapshot.activeMatchId) {
          userSessionGuardService.emitBlocked(socket, {
            reason: 'ACTIVE_MATCH',
            message: 'You are already in an active match',
            stateSnapshot: snapshot,
          });
          socket.emit('error', {
            code: 'ALREADY_IN_LOBBY',
            message: 'You are already in an active match',
            meta: { stateSnapshot: snapshot },
          });
          return;
        }

        const inviteLobby = await lobbiesRepo.getByInviteCode(normalizedCode);
        if (!inviteLobby) {
          logger.warn({ inviteCode: `${normalizedCode.slice(0, 2)}***` }, 'Lobby not found for invite');
          socket.emit('error', {
            code: 'LOBBY_NOT_FOUND',
            message: 'Invalid invite code',
            meta: { inviteCode: normalizedCode },
          });
          userSessionGuardService.emitBlocked(socket, {
            reason: 'INVALID_INVITE',
            message: 'Invalid invite code',
            stateSnapshot: snapshot,
          });
          return;
        }

        const prepared = await userSessionGuardService.prepareForLobbyEntry(io, userId, {
          keepWaitingLobbyId: inviteLobby.id,
        });
        if (!prepared.ok) {
          userSessionGuardService.emitBlocked(socket, {
            reason: prepared.reason ?? 'ACTIVE_MATCH',
            message: prepared.message ?? 'You are already in an active match',
            stateSnapshot: prepared.snapshot,
          });
          socket.emit('error', {
            code: 'ALREADY_IN_LOBBY',
            message: prepared.message ?? 'You are already in an active match',
            meta: { stateSnapshot: prepared.snapshot },
          });
          return;
        }

        const lobbyLockKey = `lock:lobby:${inviteLobby.id}`;
        const lobbyLock = await acquireLock(lobbyLockKey, 3000);
        if (!lobbyLock.acquired || !lobbyLock.token) {
          socket.emit('error', {
            code: 'TRANSITION_IN_PROGRESS',
            message: 'Lobby transition in progress. Please retry.',
          });
          return;
        }

        try {
          // Re-read target lobby after lock to avoid stale code -> deleted lobby race.
          const lobby = await lobbiesRepo.getById(inviteLobby.id);
          if (
            !lobby ||
            lobby.status !== 'waiting' ||
            lobby.mode !== 'friendly' ||
            !lobby.invite_code ||
            lobby.invite_code.toUpperCase() !== normalizedCode
          ) {
            logger.warn(
              { lobbyId: inviteLobby.id, inviteCode: `${normalizedCode.slice(0, 2)}***` },
              'Lobby join failed after lock: invite target no longer valid'
            );
            socket.emit('error', {
              code: 'LOBBY_NOT_FOUND',
              message: 'Invalid invite code',
              meta: { inviteCode: normalizedCode },
            });
            userSessionGuardService.emitBlocked(socket, {
              reason: 'LOBBY_NOT_FOUND',
              message: 'Lobby no longer exists',
              stateSnapshot: prepared.snapshot,
            });
            return;
          }

          const members = await lobbiesRepo.listMembersWithUser(lobby.id);
          const alreadyMember = members.some((member) => member.user_id === userId);
          if (!alreadyMember && members.length >= FRIENDLY_LOBBY_MAX_MEMBERS) {
            logger.warn({ lobbyId: lobby.id }, 'Lobby already full');
            socket.emit('error', { code: 'LOBBY_FULL', message: 'Lobby is already full' });
            return;
          }

          if (!alreadyMember) {
            await lobbiesRepo.addMember(lobby.id, userId, false);
            await syncFriendlyLobbyModeForMemberCountLocked(lobby.id, {
              clearReadyOnPartyTransition: members.length <= 2,
            });
          }
          await attachUserSocketsToLobby(io, userId, lobby.id);

          logger.info(
            { lobbyId: lobby.id, userId, alreadyMember },
            alreadyMember ? 'Lobby rejoined as existing member' : 'Lobby joined by code'
          );
          await emitLobbyState(io, lobby.id);
        } finally {
          await releaseLock(lobbyLockKey, lobbyLock.token);
        }
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Lobby state transition is in progress. Please retry.',
        operation: 'lobby:join_by_code',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async setReady(io: QuizballServer, socket: QuizballSocket, ready: boolean): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) return;

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      logger.warn({ lobbyId }, 'Lobby ready update ignored: lobby not found');
      return;
    }

    const updated = await lobbiesRepo.updateMemberReady(lobbyId, socket.data.user.id, ready);
    if (!updated) {
      logger.warn(
        { lobbyId, userId: socket.data.user.id },
        'Lobby ready update ignored: member not found'
      );
      return;
    }
    logger.info(
      { lobbyId, userId: socket.data.user.id, ready },
      'Lobby member ready state updated'
    );
    await emitLobbyState(io, lobbyId);

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ lobbyId }, 'Lobby ready check skipped: lock not acquired');
      return;
    }

    let shouldStartDraft = false;
    try {
      const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
      const memberCount = await lobbiesRepo.countMembers(lobbyId);

      if (lobby.mode === 'friendly') {
        const friendlyMode = normalizeFriendlyGameMode(lobby.game_mode);
        const allReady = memberCount > 0 && readyCount === memberCount;

        if (
          (friendlyMode === 'friendly_possession' && memberCount === 2 && allReady) ||
          (friendlyMode === 'friendly_party_quiz' && memberCount >= 2 && memberCount <= FRIENDLY_LOBBY_MAX_MEMBERS && allReady)
        ) {
          logger.info({ lobbyId, gameMode: friendlyMode }, 'Lobby ready -> waiting for host start (friendly)');
          return;
        }
        if (friendlyMode !== 'ranked_sim') {
          return;
        }
      }

      if (memberCount === 2 && readyCount === 2) {
        const acquiredGuard = await tryAcquireDraftStartGuard(lobbyId);
        if (!acquiredGuard) {
          logger.debug({ lobbyId }, 'Draft already starting, skipping duplicate');
          return;
        }

        shouldStartDraft = true;
      }
    } finally {
      await releaseLock(lockKey, lock.token);
    }

    if (shouldStartDraft) {
      try {
        logger.info({ lobbyId }, 'Lobby ready -> starting draft');
        await startDraft(io, lobbyId);
      } finally {
        await releaseDraftStartGuard(lobbyId);
      }
    }
  },

  async updateSettings(
    io: QuizballServer,
    socket: QuizballSocket,
    payload: {
      lobbyId?: string;
      gameMode: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
      friendlyRandom?: boolean;
      friendlyCategoryAId?: string | null;
      friendlyCategoryBId?: string | null;
      isPublic?: boolean;
    }
  ): Promise<void> {
    const lobbyId = resolveLobbyId(socket, payload.lobbyId);
    if (!lobbyId) {
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
      return;
    }

    if (socket.data.user.id !== lobby.host_user_id) {
      socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can update settings' });
      return;
    }

    if (lobby.status !== 'waiting') {
      socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby settings are locked' });
      return;
    }

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLobbyLockWithRetry(lobbyId, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn(
        { lobbyId, userId: socket.data.user.id, socketId: socket.id },
        'Lobby settings update skipped: lock not acquired'
      );
      socket.emit('error', {
        code: 'LOBBY_SETTINGS_LOCKED',
        message: 'Lobby settings update is busy. Please retry.',
      });
      return;
    }

    try {
      const memberCount = await lobbiesRepo.countMembers(lobbyId);
      const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
      if (memberCount > 0 && readyCount === memberCount) {
        socket.emit('error', { code: 'LOBBY_READY_LOCKED', message: 'Cannot edit settings after both players are ready' });
        return;
      }

      const currentSettings = {
        gameMode: lobby.game_mode ?? (lobby.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
        friendlyRandom: lobby.friendly_random ?? true,
        friendlyCategoryAId: lobby.friendly_category_a_id ?? null,
        friendlyCategoryBId: lobby.friendly_category_b_id ?? null,
      };

      const nextSettings = {
        ...currentSettings,
        gameMode: payload.gameMode ?? currentSettings.gameMode,
        friendlyRandom:
          payload.friendlyRandom !== undefined
            ? payload.friendlyRandom
            : currentSettings.friendlyRandom,
        friendlyCategoryAId:
          payload.friendlyCategoryAId !== undefined
            ? payload.friendlyCategoryAId
            : currentSettings.friendlyCategoryAId,
        friendlyCategoryBId:
          payload.friendlyCategoryBId !== undefined
            ? payload.friendlyCategoryBId
            : currentSettings.friendlyCategoryBId,
      };

      if (lobby.mode === 'friendly') {
        if (memberCount > 2) {
          nextSettings.gameMode = 'friendly_party_quiz';
        }
      }

      if (nextSettings.gameMode === 'ranked_sim') {
        nextSettings.friendlyRandom = true;
        nextSettings.friendlyCategoryAId = null;
        nextSettings.friendlyCategoryBId = null;
      } else if (nextSettings.friendlyRandom) {
        nextSettings.friendlyCategoryAId = null;
        nextSettings.friendlyCategoryBId = null;
      } else {
        if (!nextSettings.friendlyCategoryAId) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'A category is required when random is disabled',
          });
          return;
        }
        nextSettings.friendlyCategoryBId = null;
      }

      const normalizedVisibility = payload.isPublic ?? lobby.is_public;
      const settingsUnchanged =
        nextSettings.gameMode === currentSettings.gameMode &&
        nextSettings.friendlyRandom === currentSettings.friendlyRandom &&
        nextSettings.friendlyCategoryAId === currentSettings.friendlyCategoryAId &&
        nextSettings.friendlyCategoryBId === currentSettings.friendlyCategoryBId &&
        normalizedVisibility === lobby.is_public;
      if (settingsUnchanged) {
        logger.debug({ lobbyId, userId: socket.data.user.id }, 'Lobby settings update no-op');
        return;
      }

      await lobbiesRepo.updateLobbySettings(lobbyId, {
        gameMode: nextSettings.gameMode,
        friendlyRandom: nextSettings.friendlyRandom,
        friendlyCategoryAId: nextSettings.friendlyCategoryAId,
        friendlyCategoryBId: nextSettings.friendlyCategoryBId,
      });

      if (payload.isPublic !== undefined) {
        await lobbiesRepo.setVisibility(lobbyId, payload.isPublic);
      }

      logger.info(
        {
          lobbyId,
          socketId: socket.id,
          gameMode: nextSettings.gameMode,
          friendlyRandom: nextSettings.friendlyRandom,
          friendlyCategoryAId: nextSettings.friendlyCategoryAId,
          friendlyCategoryBId: nextSettings.friendlyCategoryBId,
          isPublic: payload.isPublic ?? lobby.is_public,
          userId: socket.data.user.id,
        },
        'Lobby settings updated'
      );
      await emitLobbyState(io, lobbyId);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  },

  async startFriendlyMatch(
    io: QuizballServer,
    socket: QuizballSocket,
    lobbyIdOverride?: string
  ): Promise<void> {
    const lobbyId = resolveLobbyId(socket, lobbyIdOverride);
    if (!lobbyId) {
      socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
      return;
    }

    if (socket.data.user.id !== lobby.host_user_id) {
      socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can start the match' });
      return;
    }

    if (lobby.status !== 'waiting') {
      socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby is not ready to start' });
      return;
    }

    const friendlyMode = normalizeFriendlyGameMode(lobby.game_mode);
    if (friendlyMode === 'ranked_sim') {
      socket.emit('error', { code: 'INVALID_SETTINGS', message: 'Host start is not available for ranked sim mode' });
      return;
    }

    const memberCount = await lobbiesRepo.countMembers(lobbyId);
    const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
    const allReady = memberCount > 0 && readyCount === memberCount;
    const isValidFriendlyStart =
      (friendlyMode === 'friendly_possession' && memberCount === 2) ||
      (friendlyMode === 'friendly_party_quiz' && memberCount >= 2 && memberCount <= FRIENDLY_LOBBY_MAX_MEMBERS);

    if (!isValidFriendlyStart || !allReady) {
      socket.emit('error', { code: 'LOBBY_NOT_READY', message: 'All lobby players must be ready' });
      return;
    }

    const lockKey = `lock:lobby:${lobbyId}`;
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ lobbyId }, 'Friendly match start skipped: lock not acquired');
      socket.emit('error', {
        code: 'MATCH_START_LOCKED',
        message: 'Match start is busy. Please retry.',
      });
      return;
    }

    try {
      let categoryAId: string;
      let categoryBId: string | null;

      if (lobby.friendly_random) {
        const categories = await lobbiesService.selectRandomCategories(1);
        if (categories.length < 1) {
          logger.warn(
            { lobbyId, categoryCount: categories.length },
            'Friendly match start failed: insufficient categories'
          );
          await lobbiesRepo.setAllReady(lobbyId, false);
          await emitLobbyState(io, lobbyId);
          socket.emit('error', {
            code: 'INSUFFICIENT_CATEGORIES',
            message: 'Not enough categories with questions to start the game',
          });
          return;
        }
        categoryAId = categories[0].id;
        categoryBId = null;
      } else {
        const categoryA = lobby.friendly_category_a_id;
        if (!categoryA) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Please select a category for the first half',
          });
          return;
        }

        const categories = await categoriesRepo.listByIds([categoryA]);
        if (categories.length !== 1) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Selected category is invalid',
          });
          return;
        }

        const validCategoryIds = await lobbiesRepo.listValidCategoryIds(
          [categoryA],
          MIN_QUESTIONS_PER_CATEGORY
        );
        if (validCategoryIds.length !== 1) {
          socket.emit('error', {
            code: 'INSUFFICIENT_CATEGORIES',
            message: 'Selected category does not have enough questions',
          });
          await lobbiesRepo.setAllReady(lobbyId, false);
          await emitLobbyState(io, lobbyId);
          return;
        }

        categoryAId = categoryA;
        categoryBId = null;
      }

      let result;
      try {
        result = await matchesService.createMatchFromLobby({
          lobbyId,
          mode: lobby.mode,
          variant: friendlyMode,
          hostUserId: lobby.host_user_id,
          categoryAId,
          categoryBId,
        });
      } catch (error) {
        logger.warn(
          { lobbyId, error: error instanceof Error ? error.message : error },
          'Failed to create friendly match'
        );
        await lobbiesRepo.setAllReady(lobbyId, false);
        await emitLobbyState(io, lobbyId);
        socket.emit('error', {
          code: 'MATCH_CREATE_FAILED',
          message: 'Unable to start match with the selected categories',
        });
        return;
      }

      await lobbiesRepo.setLobbyStatus(lobbyId, 'active');
      await warmupRealtimeService.cleanupLobby(lobbyId);

      logger.info(
        { lobbyId, matchId: result.match.id, mode: lobby.mode, categoryAId, categoryBId },
        'Friendly match created'
      );

      await beginMatchForLobby(io, lobbyId, result.match.id);
    } finally {
      await releaseLock(lockKey, lock.token);
    }
  },

  async leaveLobby(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const userId = socket.data.user.id;
    const completed = await userSessionGuardService.runWithUserTransitionLock(
      io,
      socket,
      async () => {
      let lobbyId = socket.data.lobbyId;
      if (!lobbyId) {
        const existingLobby = await lobbiesRepo.findWaitingLobbyForUser(userId);
        lobbyId = existingLobby?.id;
        if (lobbyId) {
          logger.info({ lobbyId, userId }, 'Lobby leave: resolved waiting lobby from DB');
        }
      }

      if (!lobbyId) {
        logger.info({ userId }, 'Lobby leave: no waiting lobby to leave');
        return;
      }

      const lobbyLockKey = `lock:lobby:${lobbyId}`;
      const lobbyLock = await acquireLock(lobbyLockKey, 3000);
        if (!lobbyLock.acquired || !lobbyLock.token) {
          logger.warn({ lobbyId, userId }, 'Lobby leave skipped: lock not acquired');
          socket.emit('error', {
            code: 'LOBBY_BUSY',
            message: 'Lobby is currently busy. Please try again.',
            meta: { lobbyId },
          });
          return;
        }

      try {
        const lobby = await lobbiesRepo.getById(lobbyId);
        if (!lobby) {
          logger.info({ lobbyId, userId }, 'Lobby leave: target lobby already gone');
          return;
        }

        if (lobby.status !== 'waiting') {
          socket.emit('error', {
            code: 'LOBBY_ACTIVE',
            message: 'Match already started. Please reconnect to the match.',
          });
          return;
        }

        const membersBefore = await lobbiesRepo.listMembersWithUser(lobbyId);
        const wasMember = membersBefore.some((member) => member.user_id === userId);
        if (!wasMember) {
          await removeUserFromLobbySockets(io, lobbyId, userId);
          logger.info({ lobbyId, userId }, 'Lobby leave: user already removed');
          return;
        }

        await lobbiesRepo.removeMember(lobbyId, userId);
        if (isRankedAiLobby(lobby)) {
          const aiUserId = await getRankedAiUserIdForLobby(lobbyId);
          if (aiUserId) {
            await lobbiesRepo.removeMember(lobbyId, aiUserId);
          }
          const redis = getRedisClient();
          if (redis) {
            await redis.del(rankedAiLobbyKey(lobbyId));
          }
        }

        await removeUserFromLobbySockets(io, lobbyId, userId);
        logger.info({ lobbyId, userId }, 'Lobby leave: removed member');

        const closed = await closeLobbyIfEmpty(io, lobbyId);
        if (closed) {
          return;
        }

        if (lobby.host_user_id === userId) {
          await transferHostIfNeeded(lobbyId, userId);
        }

        await syncFriendlyLobbyModeForMemberCountLocked(lobbyId);

        await emitLobbyState(io, lobbyId);
      } finally {
        await releaseLock(lobbyLockKey, lobbyLock.token);
      }
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Lobby state transition is in progress. Please retry.',
        operation: 'lobby:leave',
      }
    );
    if (!completed) return;

    await userSessionGuardService.emitState(io, userId);
  },

  async handleLobbyDisconnect(io: QuizballServer, socket: QuizballSocket): Promise<void> {
    const lobbyId = socket.data.lobbyId;
    const userId = socket.data.user.id;

    if (!lobbyId) {
      logger.info({ userId }, 'Lobby disconnect: no waiting lobby attached');
      return;
    }

    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'waiting') {
      return;
    }

    setTimeout(async () => {
      try {
        const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
        const stillPresent = sockets.some((s) => s.data.user.id === userId);
        if (stillPresent) return;

        await lobbiesRepo.removeMember(lobbyId, userId);
        if (isRankedAiLobby(lobby)) {
          const aiUserId = await getRankedAiUserIdForLobby(lobbyId);
          if (aiUserId) {
            await lobbiesRepo.removeMember(lobbyId, aiUserId);
          }
          const redis = getRedisClient();
          if (redis) {
            await redis.del(rankedAiLobbyKey(lobbyId));
          }
        }
        logger.info({ lobbyId, userId }, 'Lobby disconnect cleanup: removed member');

        const closed = await closeLobbyIfEmpty(io, lobbyId);
        if (closed) {
          return;
        }

        if (lobby.host_user_id === userId) {
          await transferHostIfNeeded(lobbyId, userId);
        }

        await syncFriendlyLobbyModeForMemberCount(lobbyId);

        await emitLobbyState(io, lobbyId);
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Lobby disconnect cleanup failed');
      }
    }, LOBBY_DISCONNECT_GRACE_MS);
  },
};
