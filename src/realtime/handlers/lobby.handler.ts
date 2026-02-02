import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../modules/lobbies/lobbies.service.js';
import { lobbyCreateSchema, lobbyJoinByCodeSchema, lobbyReadySchema } from '../schemas/lobby.schemas.js';
import { getRedisClient } from '../redis.js';
import { acquireLock, releaseLock } from '../locks.js';
import { logger } from '../../core/logger.js';

const RANKED_QUEUE_KEY = 'ranked:queue';
const RANKED_INQUEUE_PREFIX = 'ranked:inqueue:';
const RANKED_INQUEUE_TTL_SEC = 60;

function generateInviteCode(length = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

async function emitLobbyState(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;
  const state = await lobbiesService.buildLobbyState(lobby);
  io.to(`lobby:${lobbyId}`).emit('lobby:state', state);
  logger.debug(
    { lobbyId, status: lobby.status, memberCount: state.members.length, mode: lobby.mode },
    'Lobby state broadcast'
  );
}

async function startDraft(io: QuizballServer, lobbyId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby) return;

  const lockKey = `lock:lobby:${lobbyId}`;
  const locked = await acquireLock(lockKey, 3000);
  if (!locked) {
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
    await releaseLock(lockKey);
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

  const userA = await redis.lPop(RANKED_QUEUE_KEY);
  const userB = await redis.lPop(RANKED_QUEUE_KEY);
  if (!userA || !userB) return;

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

export function registerLobbyHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('lobby:create', async (payload) => {
    const parsed = lobbyCreateSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:create payload');
      return;
    }

    const { mode } = parsed.data;
    const userId = socket.data.user.id;

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
  });

  socket.on('lobby:join_by_code', async (payload) => {
    const parsed = lobbyJoinByCodeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:join_by_code payload');
      return;
    }

    const lobby = await lobbiesRepo.getByInviteCode(parsed.data.inviteCode);
    if (!lobby) {
      logger.warn(
        { inviteCode: `${parsed.data.inviteCode.slice(0, 2)}***` },
        'Lobby not found for invite'
      );
      return;
    }

    const memberCount = await lobbiesRepo.countMembers(lobby.id);
    if (memberCount >= 2) {
      logger.warn({ lobbyId: lobby.id }, 'Lobby already full');
      return;
    }

    await lobbiesRepo.addMember(lobby.id, socket.data.user.id, false);
    socket.join(`lobby:${lobby.id}`);
    socket.data.lobbyId = lobby.id;

    logger.info(
      { lobbyId: lobby.id, userId: socket.data.user.id },
      'Lobby joined by code'
    );
    await emitLobbyState(io, lobby.id);
  });

  socket.on('lobby:ready', async (payload) => {
    const parsed = lobbyReadySchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:ready payload');
      return;
    }

    const lobbyId = socket.data.lobbyId;
    if (!lobbyId) return;

    await lobbiesRepo.updateMemberReady(lobbyId, socket.data.user.id, parsed.data.ready);
    logger.info(
      { lobbyId, userId: socket.data.user.id, ready: parsed.data.ready },
      'Lobby member ready state updated'
    );
    await emitLobbyState(io, lobbyId);

    const readyCount = await lobbiesRepo.countReadyMembers(lobbyId);
    const memberCount = await lobbiesRepo.countMembers(lobbyId);

    if (memberCount === 2 && readyCount === 2) {
      logger.info({ lobbyId }, 'Lobby ready -> starting draft');
      await startDraft(io, lobbyId);
    }
  });

  socket.on('lobby:leave', async () => {
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
  });
}
