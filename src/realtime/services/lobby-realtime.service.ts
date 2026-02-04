import crypto from 'crypto';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { categoriesRepo } from '../../modules/categories/categories.repo.js';
import { matchesService } from '../../modules/matches/matches.service.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { beginMatchForLobby } from './match-realtime.service.js';

const RANKED_QUEUE_KEY = 'ranked:queue';
const RANKED_INQUEUE_PREFIX = 'ranked:inqueue:';
const RANKED_INQUEUE_TTL_SEC = 60;
const DRAFT_START_GUARD_PREFIX = 'draft:starting:';
const DRAFT_START_GUARD_TTL_SEC = 15;

// Fallback guard when Redis is unavailable (single instance only).
const draftStartingSet = new Set<string>();

function generateInviteCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += chars[crypto.randomInt(chars.length)];
  }
  return code;
}

function resolveLobbyId(socket: QuizballSocket, lobbyId?: string): string | undefined {
  return lobbyId ?? socket.data.lobbyId;
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

async function popRankedPair(redis: NonNullable<ReturnType<typeof getRedisClient>>): Promise<string[]> {
  const script = `
    local key = KEYS[1]
    local count = tonumber(ARGV[1])
    local items = redis.call('LPOP', key, count)
    if not items then return {} end
    if type(items) == 'string' then items = {items} end
    if #items < count then
      for i = #items, 1, -1 do
        redis.call('LPUSH', key, items[i])
      end
      return items
    end
    return items
  `;

  const result = await redis.eval(script, {
    keys: [RANKED_QUEUE_KEY],
    arguments: ['2'],
  });
  return Array.isArray(result) ? result.map(String) : [];
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

async function enqueueRanked(io: QuizballServer, userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('Redis is required for ranked queue');
  }

  const inQueueKey = `${RANKED_INQUEUE_PREFIX}${userId}`;
  const alreadyQueued = await redis.exists(inQueueKey);
  if (alreadyQueued) {
    logger.debug({ userId }, 'Ranked queue: already queued');
    return;
  }

  await redis.setEx(inQueueKey, RANKED_INQUEUE_TTL_SEC, '1');
  await redis.rPush(RANKED_QUEUE_KEY, userId);

  const queueLength = await redis.lLen(RANKED_QUEUE_KEY);
  logger.info({ userId, queueLength }, 'Ranked queue: enqueued');
  if (queueLength < 2) return;

  const popped = await popRankedPair(redis);
  if (popped.length < 2) {
    if (popped.length === 1) {
      logger.debug({ userId: popped[0] }, 'Ranked queue: restored single user after failed match');
    }
    return;
  }

  const [userA, userB] = popped;
  await redis.del([`${RANKED_INQUEUE_PREFIX}${userA}`, `${RANKED_INQUEUE_PREFIX}${userB}`]);

  const lobby = await lobbiesRepo.createLobby({
    mode: 'ranked',
    hostUserId: userA,
    inviteCode: null,
  });

  await lobbiesRepo.addMember(lobby.id, userA, true);
  await lobbiesRepo.addMember(lobby.id, userB, true);
  logger.info({ lobbyId: lobby.id, userA, userB }, 'Ranked lobby created');

  const socketsA = await io.in(`user:${userA}`).fetchSockets();
  const socketsB = await io.in(`user:${userB}`).fetchSockets();

  socketsA.forEach((socket) => {
    socket.join(`lobby:${lobby.id}`);
    socket.data.lobbyId = lobby.id;
  });
  socketsB.forEach((socket) => {
    socket.join(`lobby:${lobby.id}`);
    socket.data.lobbyId = lobby.id;
  });

  await emitLobbyState(io, lobby.id);
  await startDraft(io, lobby.id);
}

export const lobbyRealtimeService = {
  async createLobby(io: QuizballServer, socket: QuizballSocket, mode: 'friendly' | 'ranked'): Promise<void> {
    const userId = socket.data.user.id;

    // Prevent creating a new lobby if already in one
    if (socket.data.lobbyId) {
      logger.warn(
        { userId, existingLobbyId: socket.data.lobbyId },
        'Lobby create ignored: user already in a lobby'
      );
      socket.emit('error', { code: 'ALREADY_IN_LOBBY', message: 'You are already in a lobby' });
      return;
    }

    if (mode === 'ranked') {
      logger.info({ userId }, 'Lobby create (ranked) requested');
      await enqueueRanked(io, userId);
      return;
    }

    const inviteCode = generateInviteCode(6);
    const lobby = await lobbiesRepo.createLobby({
      mode: 'friendly',
      hostUserId: userId,
      inviteCode,
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

  async joinByCode(io: QuizballServer, socket: QuizballSocket, inviteCode: string): Promise<void> {
    const userId = socket.data.user.id;

    // Prevent joining if already in a lobby
    if (socket.data.lobbyId) {
      logger.warn(
        { userId, existingLobbyId: socket.data.lobbyId },
        'Lobby join ignored: user already in a lobby'
      );
      socket.emit('error', { code: 'ALREADY_IN_LOBBY', message: 'You are already in a lobby' });
      return;
    }

    const lobby = await lobbiesRepo.getByInviteCode(inviteCode);
    if (!lobby) {
      logger.warn({ inviteCode: `${inviteCode.slice(0, 2)}***` }, 'Lobby not found for invite');
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Invalid invite code' });
      return;
    }

    const members = await lobbiesRepo.listMembersWithUser(lobby.id);
    const alreadyMember = members.some((m) => m.user_id === userId);
    if (alreadyMember) {
      logger.warn({ lobbyId: lobby.id, userId }, 'User already a member of lobby');
      socket.emit('error', { code: 'ALREADY_MEMBER', message: 'You are already in this lobby' });
      return;
    }

    if (members.length >= 2) {
      logger.warn({ lobbyId: lobby.id }, 'Lobby already full');
      socket.emit('error', { code: 'LOBBY_FULL', message: 'Lobby is already full' });
      return;
    }

    await lobbiesRepo.addMember(lobby.id, userId, false);
    socket.join(`lobby:${lobby.id}`);
    socket.data.lobbyId = lobby.id;

    logger.info(
      { lobbyId: lobby.id, userId },
      'Lobby joined by code'
    );
    await emitLobbyState(io, lobby.id);
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

      logger.info({ lobbyId, gameMode: nextSettings.gameMode }, 'Lobby settings updated');
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
    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) {
      const redis = getRedisClient();
      if (redis) {
        await redis.del(`${RANKED_INQUEUE_PREFIX}${socket.data.user.id}`);
        await redis.lRem(RANKED_QUEUE_KEY, 0, socket.data.user.id);
      }
      logger.info({ userId: socket.data.user.id }, 'Lobby leave: removed from ranked queue');
      return;
    }

    await lobbiesRepo.removeMember(lobbyId, socket.data.user.id);
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
    logger.info({ lobbyId, userId: socket.data.user.id }, 'Lobby leave: removed member');

    const memberCount = await lobbiesRepo.countMembers(lobbyId);
    if (memberCount === 0) {
      await lobbiesRepo.setLobbyStatus(lobbyId, 'closed');
      logger.info({ lobbyId }, 'Lobby closed (no members)');
    }

    await emitLobbyState(io, lobbyId);
  },
};
