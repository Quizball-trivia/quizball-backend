import { randomUUID } from 'node:crypto';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { logger } from '../../core/logger.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { scheduleRealtimeTimer, type RealtimeTimerPayload } from '../realtime-timer-scheduler.js';
import { releaseLock } from '../locks.js';
import { acquireLobbyLockWithRetry, isRankedAiLobby, releaseRankedAiLobbyMemberSafely } from './lobby-lifecycle.helpers.js';
import { emitClosedLobbyStateForMode, transferHostIfNeeded } from './lobby-membership.helpers.js';
import { emitLobbyState, syncFriendlyLobbyModeForMemberCountLocked } from '../lobby-utils.js';
import { warmupRealtimeService } from './warmup-realtime.service.js';
import { socketDbTaskLimiter } from '../socket-db-task-limiter.js';

export const PRIVATE_FRIEND_DISCONNECT_GRACE_MS = 5 * 60_000;
const OTHER_WAITING_DISCONNECT_GRACE_MS = 15_000;
const RECOVERY_INTERVAL_MS = 30_000;
let recoveryTimer: NodeJS.Timeout | null = null;
let recoveryRunning = false;

type DisconnectTimer = Extract<RealtimeTimerPayload, { kind: 'lobby_waiting_disconnect' }>;

export async function reserveWaitingLobbyDisconnect(io: QuizballServer, socket: QuizballSocket, lobbyId: string): Promise<void> {
  const userId = socket.data.user.id;
  const lock = await acquireLobbyLockWithRetry(lobbyId, 10_000, 500);
  if (!lock.acquired || !lock.token) return; // A newer connect/join owns the transition; do not mutate it.
  try {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'waiting') return;
    const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
    if (sockets.some(s => s.id !== socket.id && s.data.user.id === userId)) return;
    const graceMs = lobby.mode === 'friendly' && !lobby.is_public
      ? PRIVATE_FRIEND_DISCONNECT_GRACE_MS : OTHER_WAITING_DISCONNECT_GRACE_MS;
    const lease = await lobbiesRepo.reserveWaitingDisconnect(lobbyId, userId, randomUUID(), graceMs);
    if (!lease) return;
    await scheduleRealtimeTimer('lobby_waiting_disconnect', `${lobbyId}:${userId}`, new Date(lease.expires_at), {
      kind: 'lobby_waiting_disconnect', lobbyId, userId, disconnectToken: lease.token,
    });
    await emitLobbyState(io, lobbyId);
    logger.info({ lobbyId, userId, graceMs, expiresAt: lease.expires_at }, 'Waiting lobby disconnect reserved');
  } finally {
    await releaseLock(`lock:lobby:${lobbyId}`, lock.token);
  }
}

export async function expireWaitingLobbyDisconnect(io: QuizballServer, payload: DisconnectTimer): Promise<void> {
  const { lobbyId, userId, disconnectToken } = payload;
  const lock = await acquireLobbyLockWithRetry(lobbyId, 10_000, 500);
  if (!lock.acquired || !lock.token) return; // Indexed DB recovery retries due leases.
  try {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby || lobby.status !== 'waiting') return;
    const lease = await lobbiesRepo.getWaitingDisconnect(lobbyId, userId);
    if (!lease || lease.token !== disconnectToken || new Date(lease.expires_at).getTime() > Date.now()) return;
    const sockets = await io.in(`lobby:${lobbyId}`).fetchSockets();
    if (sockets.some(s => s.data.user.id === userId)) {
      await lobbiesRepo.clearWaitingDisconnect(lobbyId, userId);
      return;
    }
    if (isRankedAiLobby(lobby)) {
      // Preserve the authoritative ranked-AI abort/activation lock and settlement rules.
      await releaseRankedAiLobbyMemberSafely(lobbyId, userId);
      return;
    }
    if (!await lobbiesRepo.removeWaitingDisconnectedMember(lobbyId, userId, disconnectToken)) return;
    logger.info({ lobbyId, userId, reason: 'disconnect_reservation_expired' }, 'Waiting lobby disconnect expired');
    if (await lobbiesRepo.deleteEmptyWaitingLobby(lobbyId)) {
      await warmupRealtimeService.cleanupLobby(lobbyId);
      await emitClosedLobbyStateForMode(io, lobbyId, lobby.mode);
      logger.info({ lobbyId, reason: 'disconnect_reservation_expired' }, 'Waiting lobby deleted after reservation');
      return;
    }
    if (lobby.host_user_id === userId) await transferHostIfNeeded(lobbyId, userId);
    await syncFriendlyLobbyModeForMemberCountLocked(lobbyId);
    await emitLobbyState(io, lobbyId);
  } finally {
    await releaseLock(`lock:lobby:${lobbyId}`, lock.token);
  }
}

/** DB expiry is authoritative: recover after Redis loss, a restart, or a busy/failed timer. */
export async function recoverWaitingLobbyDisconnects(io: QuizballServer): Promise<void> {
  if (recoveryRunning) return;
  recoveryRunning = true;
  try {
    const due = await lobbiesRepo.listDueWaitingDisconnects();
    for (const row of due) {
      try {
        await expireWaitingLobbyDisconnect(io, {
          kind: 'lobby_waiting_disconnect', lobbyId: row.lobby_id, userId: row.user_id, disconnectToken: row.token,
        });
      } catch (error) {
        logger.warn({ error, lobbyId: row.lobby_id }, 'Waiting lobby disconnect recovery deferred');
      }
    }
  } finally { recoveryRunning = false; }
}

export function startWaitingLobbyDisconnectRecovery(io: QuizballServer): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    void socketDbTaskLimiter.run(() => recoverWaitingLobbyDisconnects(io))
      .catch(error => logger.warn({ error }, 'Waiting lobby disconnect recovery failed'));
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
}
