import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { getRedisClient } from '../redis.js';
import { acquireLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import {
  emitLobbyState,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import {
  persistReconstructedDraftTurnState,
  readDraftTurnState,
  type DraftTurnState,
} from '../draft-turn-state.js';

export const LOBBY_LOCK_WAIT_MS = 1200;
export const LOBBY_LOCK_RETRY_INTERVAL_MS = 75;
export const RANKED_AI_KEY_TTL_SEC = 7200;

export function resolveLobbyId(socket: QuizballSocket, lobbyId?: string): string | undefined {
  return lobbyId ?? socket.data.lobbyId;
}

export function randomIntBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function isRankedAiLobby(lobby: { mode: string }): boolean {
  return lobby.mode === 'ranked';
}

export async function getRankedAiUserIdForLobby(lobbyId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  return redis.get(rankedAiLobbyKey(lobbyId));
}

export async function resolveRankedAiUserIdForDraft(
  lobbyId: string,
  members: Array<{ user_id: string }>
): Promise<string | null> {
  const aiUserIdFromRedis = await getRankedAiUserIdForLobby(lobbyId);
  if (aiUserIdFromRedis && members.some((member) => member.user_id === aiUserIdFromRedis)) {
    return aiUserIdFromRedis;
  }

  const usersById = await usersRepo.getByIds(members.map((member) => member.user_id));
  const users = members.map((member) => ({
    userId: member.user_id,
    user: usersById.get(member.user_id) ?? null,
  }));
  const aiMember = users.find((entry) => entry.user?.is_ai);
  if (!aiMember) return null;

  const redis = getRedisClient();
  if (redis) {
    await redis.set(rankedAiLobbyKey(lobbyId), aiMember.userId, { EX: RANKED_AI_KEY_TTL_SEC });
  }
  return aiMember.userId;
}

export async function ensureDraftTurnState(lobbyId: string): Promise<DraftTurnState | null> {
  const existing = await readDraftTurnState(lobbyId);
  if (existing) return existing;

  const lobby = await lobbiesRepo.getById(lobbyId);
  if (!lobby || lobby.status !== 'active') return null;

  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length !== 2) return null;

  const bans = await lobbiesRepo.listLobbyCategoryBans(lobbyId);
  const aiUserId = lobby.mode === 'ranked'
    ? await resolveRankedAiUserIdForDraft(lobbyId, members)
    : null;
  const banCount = bans.length;
  const nextActorUserId = banCount === 0
    ? lobby.host_user_id
    : banCount >= 2
      ? null
      : members.find((member) => member.user_id !== bans[bans.length - 1].user_id)?.user_id ?? null;
  const reconstructed: DraftTurnState = {
    firstActorUserId: lobby.host_user_id,
    nextActorUserId,
    aiUserId,
    participantUserIds: [members[0].user_id, members[1].user_id],
    banCount,
  };
  const persisted = await persistReconstructedDraftTurnState(lobbyId, reconstructed);
  logger.warn({ lobbyId, banCount }, 'Draft turn state reconstructed');
  return persisted;
}

export async function transferHostIfNeeded(lobbyId: string, previousHostId: string): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length === 0) return;
  const nextHostId = members[0]?.user_id;
  if (nextHostId && nextHostId !== previousHostId) {
    await lobbiesRepo.setHostUser(lobbyId, nextHostId);
  }
}

export async function removeUserFromLobbySockets(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    if (socket.data.user.id !== userId) return;
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
}

export async function autoLeaveLobby(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
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

export async function autoLeaveAllWaitingLobbies(
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

export async function acquireLobbyLockWithRetry(
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

export async function closeLobbyIfEmpty(io: QuizballServer, lobbyId: string): Promise<boolean> {
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

export async function detachAllSocketsFromLobby(io: QuizballServer, lobbyId: string): Promise<void> {
  const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
}

export async function emitClosedLobbyStateForMode(
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
