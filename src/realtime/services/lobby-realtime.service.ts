import crypto from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import {
  lobbiesService,
  MIN_QUESTIONS_PER_CATEGORY,
} from '../../modules/lobbies/lobbies.service.js';
import { categoriesRepo } from '../../modules/categories/categories.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { beginMatchForLobby } from './match-realtime.service.js';
import {
  generateRankedAiProfile,
  rankedAiLobbyKey,
} from '../ai-ranked.constants.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { userSessionGuardService } from './user-session-guard.service.js';

const DRAFT_START_GUARD_PREFIX = 'draft:starting:';
const DRAFT_START_GUARD_TTL_SEC = 15;
const LOBBY_DISCONNECT_GRACE_MS = 15000;
const RANKED_SIM_SEARCH_MIN_MS = 3000;
const RANKED_SIM_SEARCH_MAX_MS = 10000;
const RANKED_SIM_FOUND_MODAL_MS = 1200;
const RANKED_AI_KEY_TTL_SEC = 7200;

// Fallback guard when Redis is unavailable (single instance only).
const draftStartingSet = new Set<string>();

const LOBBY_NAME_ADJECTIVES = [
  'Golden',
  'Rapid',
  'Electric',
  'Stadium',
  'Victory',
  'Thunder',
  'Derby',
  'Final',
  'Elite',
  'Club',
];

const LOBBY_NAME_NOUNS = [
  'Kickoff',
  'Strikers',
  'Midfield',
  'Penalty',
  'Hat-Trick',
  'Goal Line',
  'The Kop',
  'Champions',
  'Pitch',
  'Arena',
];

function generateInviteCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

function generateLobbyName(): string {
  const adjective = LOBBY_NAME_ADJECTIVES[crypto.randomInt(LOBBY_NAME_ADJECTIVES.length)];
  const noun = LOBBY_NAME_NOUNS[crypto.randomInt(LOBBY_NAME_NOUNS.length)];
  return `${adjective} ${noun}`;
}

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

async function emitLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;
  const state = await lobbiesService.buildLobbyState(lobby);
  io.to(`lobby:${lobbyId}`).emit('lobby:state', state);
  logger.debug(
    {
      lobbyId,
      status: lobby.status,
      memberCount: state.members.length,
      memberIds: state.members.map((member) => member.userId),
      mode: lobby.mode,
      gameMode: lobby.game_mode,
    },
    'Lobby state broadcast'
  );
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

async function attachUserSocketsToLobby(
  io: QuizballServer,
  userId: string,
  lobbyId: string
): Promise<void> {
  await io.in(`user:${userId}`).socketsJoin(`lobby:${lobbyId}`);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.data.lobbyId = lobbyId;
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
      gameMode: 'friendly',
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    },
    members: [],
  });
  return true;
}

export async function startDraft(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;

  const lockKey = `lock:lobby:${lobbyId}`;
  const lock = await acquireLock(lockKey, 3000);
  if (!lock.acquired || !lock.token) {
    logger.warn({ lobbyId }, 'Draft start skipped: lobby lock not acquired');
    return;
  }

  try {
    const categories = await lobbiesService.selectRandomCategories(4);
    if (categories.length < 4) {
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

    io.to(`lobby:${lobbyId}`).emit('draft:start', {
      lobbyId,
      categories,
      turnUserId: lobby.host_user_id,
    });
    logger.info(
      { lobbyId, hostUserId: lobby.host_user_id, categoryCount: categories.length },
      'Draft started'
    );
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}

export async function startRankedAiForUser(
  io: QuizballServer,
  userId: string,
  options?: {
    skipSearchEmit?: boolean;
    searchDurationMs?: number;
  }
): Promise<void> {
  const aiProfile = generateRankedAiProfile();
  const aiUser = await usersRepo.create({
    nickname: aiProfile.username,
    avatarUrl: aiProfile.avatarUrl,
  });

  const lobby = await lobbiesRepo.createLobby({
    mode: 'ranked',
    hostUserId: userId,
    inviteCode: null,
  });

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
        lobbiesRepo,
        logger,
        foundModalMs: RANKED_SIM_FOUND_MODAL_MS,
        startDraft,
      }),
    searchDurationMs
  );
}

async function handleRankedAiMatchFound(params: {
  io: QuizballServer;
  lobbyId: string;
  userId: string;
  aiUser: { id: string; nickname: string | null; avatar_url: string | null };
  aiProfile: { username: string; avatarUrl: string };
  lobbiesRepo: typeof import('../../modules/lobbies/lobbies.repo.js').lobbiesRepo;
  logger: typeof import('../../core/logger.js').logger;
  foundModalMs: number;
  startDraft: typeof startDraft;
}): Promise<void> {
  const { io, lobbyId, userId, aiUser, aiProfile, lobbiesRepo, logger, foundModalMs, startDraft } =
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

    io.to(`user:${userId}`).emit('ranked:match_found', {
      lobbyId,
      opponent: {
        id: aiUser.id,
        username: aiUser.nickname ?? aiProfile.username,
        avatarUrl: aiUser.avatar_url ?? aiProfile.avatarUrl,
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

    socket.join(`lobby:${newestLobby.id}`);
    socket.data.lobbyId = newestLobby.id;
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
        socket.join(`lobby:${lobby.id}`);
        socket.data.lobbyId = lobby.id;

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
          if (!alreadyMember && members.length >= 2) {
            logger.warn({ lobbyId: lobby.id }, 'Lobby already full');
            socket.emit('error', { code: 'LOBBY_FULL', message: 'Lobby is already full' });
            return;
          }

          await lobbiesRepo.addMember(lobby.id, userId, false);
          socket.join(`lobby:${lobby.id}`);
          socket.data.lobbyId = lobby.id;

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

      if (memberCount === 2 && readyCount === 2) {
        if (lobby.mode === 'friendly' && lobby.game_mode === 'friendly') {
          logger.info({ lobbyId }, 'Lobby ready -> waiting for host start (friendly)');
          return;
        }

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
      gameMode: 'friendly' | 'ranked_sim';
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
    const lock = await acquireLock(lockKey, 3000);
    if (!lock.acquired || !lock.token) {
      logger.warn({ lobbyId }, 'Lobby settings update skipped: lock not acquired');
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
        gameMode: lobby.game_mode ?? (lobby.mode === 'ranked' ? 'ranked_sim' : 'friendly'),
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

      if (nextSettings.gameMode === 'ranked_sim') {
        nextSettings.friendlyRandom = true;
        nextSettings.friendlyCategoryAId = null;
        nextSettings.friendlyCategoryBId = null;
      } else if (nextSettings.friendlyRandom) {
        nextSettings.friendlyCategoryAId = null;
        nextSettings.friendlyCategoryBId = null;
      } else {
        if (!nextSettings.friendlyCategoryAId || !nextSettings.friendlyCategoryBId) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Two categories are required when random is disabled',
          });
          return;
        }
        if (nextSettings.friendlyCategoryAId === nextSettings.friendlyCategoryBId) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Selected categories must be different',
          });
          return;
        }
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

    if (lobby.game_mode !== 'friendly') {
      socket.emit('error', { code: 'INVALID_SETTINGS', message: 'Match start is only available for friendly mode' });
      return;
    }

    const memberCount = await lobbiesRepo.countMembers(lobbyId);
    const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
    if (memberCount !== 2 || readyCount !== 2) {
      socket.emit('error', { code: 'LOBBY_NOT_READY', message: 'Both players must be ready' });
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
      let categoryIds: [string, string];

      if (lobby.friendly_random) {
        const categories = await lobbiesService.selectRandomCategories(2);
        if (categories.length < 2) {
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
        categoryIds = [categories[0].id, categories[1].id];
      } else {
        const categoryA = lobby.friendly_category_a_id;
        const categoryB = lobby.friendly_category_b_id;
        if (!categoryA || !categoryB || categoryA === categoryB) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Please select two different categories',
          });
          return;
        }

        const categories = await categoriesRepo.listByIds([categoryA, categoryB]);
        if (categories.length !== 2) {
          socket.emit('error', {
            code: 'INVALID_SETTINGS',
            message: 'Selected categories are invalid',
          });
          return;
        }

        const validCategoryIds = await lobbiesRepo.listValidCategoryIds(
          [categoryA, categoryB],
          MIN_QUESTIONS_PER_CATEGORY
        );
        if (validCategoryIds.length !== 2) {
          socket.emit('error', {
            code: 'INSUFFICIENT_CATEGORIES',
            message: 'Selected categories do not have enough questions',
          });
          return;
        }

        categoryIds = [categoryA, categoryB];
      }

      let result;
      try {
        result = await matchesService.createMatchFromLobby({
          lobbyId,
          mode: lobby.mode,
          hostUserId: lobby.host_user_id,
          categoryIds,
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
        { lobbyId, matchId: result.match.id, mode: lobby.mode, categoryIds },
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

        await emitLobbyState(io, lobbyId);
      } finally {
        await releaseLock(lobbyLockKey, lobbyLock.token);
      }
      },
      {
        code: 'TRANSITION_IN_PROGRESS',
        message: 'Lobby state transition is in progress. Please retry.',
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

        await emitLobbyState(io, lobbyId);
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Lobby disconnect cleanup failed');
      }
    }, LOBBY_DISCONNECT_GRACE_MS);
  },
};
