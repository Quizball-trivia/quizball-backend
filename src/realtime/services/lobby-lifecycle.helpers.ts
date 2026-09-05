import { removeUserFromLobbySockets, transferHostIfNeeded } from './lobby-membership.helpers.js';
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

// NOTE (pre-existing race, tracked separately — concurrency-hardening backlog):
// this predicate is mode==='ranked' only, so the locked leave/disconnect path
// (releaseRankedAiLobbyMemberSafely) applies to ALL ranked lobbies, but the
// activation-race member-removal protection is only meaningful where a persistent
// -bot reservation exists. For EPHEMERAL-AI ranked lobbies and HUMAN-vs-HUMAN
// ranked lobbies, the pre-existing stale-disconnect-during-activation race (a
// disconnect handler removing a member concurrently with draft activation) still
// exists on staging today, independent of persistent bots — it is NOT introduced
// by this PR and is deliberately out of scope here (fixing it would be scope creep
// into ephemeral/HvH lobby concurrency). Tracked separately.
export function isRankedAiLobby(lobby: { mode: string }): boolean {
  return lobby.mode === 'ranked';
}

export async function getRankedAiUserIdForLobby(lobbyId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;
  return redis.get(rankedAiLobbyKey(lobbyId)).catch((err) => {
    logger.warn({ err, lobbyId }, 'Failed to read ranked AI lobby marker; falling back to members');
    return null;
  });
}

/**
 * Safely tear down the AI side of a ranked lobby on a pre-match leave/disconnect,
 * WITHOUT relying on Redis: resolve the bot from the DB, remove it from the
 * lobby, confirm the removal, and only THEN release its persistent reservation.
 * If the bot cannot be confirmed removed from the lobby, the reservation is left
 * for the reconciliation sweeper — never release while the bot is still a member
 * (it could be acquired elsewhere while still sitting in the old lobby).
 */
export async function releaseRankedAiLobbyMemberSafely(lobbyId: string, leavingUserId?: string): Promise<void> {
  // Atomic, advisory-lock-guarded abort: under the SAME lock draft activation
  // takes, re-read state and — only if the lobby is still 'waiting'/gone AND the
  // reservation is uncommitted AND there is no active match — remove ALL members
  // (incl. the leaving HUMAN and the bot, resolved DB-side inside the tx — no
  // Redis dependency) AND free the reservation AND delete the lobby, in ONE
  // transaction. The human member removal is thus INSIDE the total-order envelope
  // (Sol P1): if a draft activated first (committed_at / active match), this
  // no-ops entirely — the human is NOT removed and the in-match disconnect/forfeit
  // machinery handles the drop during the active match, exactly as for
  // human-vs-human.
  const result = await reservationService.abortLobby(lobbyId, 'auto_leave_lobby');
  if (!result.aborted) {
    // Draft committed / active → the lobby is LIVE. Do NOT delete the AI lobby
    // Redis key: it is being (or has been) handed off to the match key
    // (rankedAiLobbyKey → rankedAiMatchKey at beginMatchForLobby). Deleting it
    // here would race that handoff and drop a live match's AI marker (Sol P2).
    logger.info({ lobbyId, leavingUserId }, 'releaseRankedAiLobbyMemberSafely: draft committed/active — leaving both members + Redis key live');
    return;
  }
  // Only when the lobby was actually torn down is the pre-match AI lobby key stale.
  const redis = getRedisClient();
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
  if (redis?.isOpen) {
    await redis
      .set(rankedAiLobbyKey(lobbyId), aiMember.userId, { EX: RANKED_AI_KEY_TTL_SEC })
      .catch((err) => {
        logger.warn({ err, lobbyId, aiUserId: aiMember.userId }, 'Failed to cache recovered ranked AI lobby marker');
      });
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

export async function autoLeaveLobby(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  const lobby = await lobbiesRepo.getById(lobbyId);

  if (lobby && isRankedAiLobby(lobby)) {
    // Ranked-AI: the HUMAN member removal + bot release + teardown ALL happen
    // INSIDE the per-lobby advisory lock (status-gated) — never remove the human
    // outside the lock. If a draft activated first (committed_at / active match),
    // this NO-OPS and the human stays (Sol P1); the in-match machinery handles the
    // drop. Also no-ops if Redis is down / reservation already transferred.
    await releaseRankedAiLobbyMemberSafely(lobbyId, userId);
  } else {
    await lobbiesRepo.removeMember(lobbyId, userId);
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
