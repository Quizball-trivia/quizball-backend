import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { getRedisClient } from '../redis.js';
import { acquireLock } from '../locks.js';
import { logger } from '../../core/logger.js';
import { rankedAiLobbyKey } from '../ai-ranked.constants.js';
import { reservationService } from '../../modules/synthetic-bots/reservation.service.js';
import {
  emitLobbyState,
  syncFriendlyLobbyModeForMemberCount,
} from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';

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

/**
 * Resolve the AI member of a lobby from the DB (source of truth), NOT Redis.
 * Reads lobby_members joined to users and returns the is_ai member's id. Used by
 * teardown paths that must free a persistent-bot reservation even when Redis is
 * unavailable — the Redis key is only a cache and can be missing during an
 * outage, which would otherwise orphan the bot in the lobby.
 */
export async function resolveLobbyAiMemberFromDb(lobbyId: string): Promise<string | null> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  return members.find((m) => m.is_ai === true)?.user_id ?? null;
}

/**
 * Safely tear down the AI side of a ranked lobby on a pre-match leave/disconnect,
 * WITHOUT relying on Redis: resolve the bot from the DB, remove it from the
 * lobby, confirm the removal, and only THEN release its persistent reservation.
 * If the bot cannot be confirmed removed from the lobby, the reservation is left
 * for the reconciliation sweeper — never release while the bot is still a member
 * (it could be acquired elsewhere while still sitting in the old lobby).
 */
export async function releaseRankedAiLobbyMemberSafely(lobbyId: string): Promise<void> {
  const redis = getRedisClient();
  // Prefer the DB (source of truth); fall back to the Redis cache only as a
  // secondary hint (it may still hold the id when the member row already went).
  let aiUserId: string | null = null;
  try {
    aiUserId = await resolveLobbyAiMemberFromDb(lobbyId);
  } catch (err) {
    logger.warn({ err, lobbyId }, 'Failed to resolve lobby AI member from DB');
  }
  if (!aiUserId && redis?.isOpen) {
    aiUserId = await redis.get(rankedAiLobbyKey(lobbyId)).catch(() => null);
  }

  if (aiUserId) {
    try {
      await lobbiesRepo.removeMember(lobbyId, aiUserId);
    } catch (err) {
      // Could not remove the bot from the lobby → do NOT release; the sweeper
      // (which handles a bot still sitting in an abandoned lobby) will reconcile.
      logger.warn({ err, lobbyId, aiUserId }, 'Failed to remove AI member from lobby; leaving reservation for the sweeper');
      if (redis?.isOpen) await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
      return;
    }
    // Confirm the bot is no longer a lobby member before releasing.
    let stillMember = true;
    try {
      const remaining = await lobbiesRepo.listMembersWithUser(lobbyId);
      stillMember = remaining.some((m) => m.user_id === aiUserId);
    } catch (err) {
      logger.warn({ err, lobbyId, aiUserId }, 'Failed to confirm AI member removal; leaving reservation for the sweeper');
      stillMember = true;
    }
    if (stillMember) {
      if (redis?.isOpen) await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
      return; // never release while the bot is still a member
    }
  }

  // Bot confirmed removed (or none present) → free the reservation.
  await reservationService.releaseByLobby(lobbyId, 'auto_leave_lobby');
  if (redis?.isOpen) await redis.del(rankedAiLobbyKey(lobbyId)).catch(() => undefined);
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

export function getFirstDraftActorId(
  members: Array<{ user_id: string }>,
  hostUserId: string,
  aiUserId: string | null
): string {
  if (!aiUserId) return hostUserId;
  return members.find((member) => member.user_id !== aiUserId)?.user_id ?? hostUserId;
}

export function getNextDraftActorId(
  members: Array<{ user_id: string }>,
  bans: Array<{ user_id: string }>,
  firstActorUserId: string
): string {
  if (bans.length === 0) return firstActorUserId;
  const lastActor = bans[bans.length - 1]?.user_id;
  return members.find((member) => member.user_id !== lastActor)?.user_id ?? firstActorUserId;
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
    await reservationService.releaseByLobby(lobbyId, 'auto_leave_lobby');
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
