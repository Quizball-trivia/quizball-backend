import { logger } from '../../core/logger.js';
import { anyDuelGameEnabled } from '../../modules/duel/duel.config.js';
import { asDuelLocale, DuelError, duelService, type DuelEffects } from '../../modules/duel/duel.service.js';
import type { DuelLocale } from '../../modules/duel/duel.types.js';
import { emitLobbyState } from '../lobby-utils.js';
import { scheduleRealtimeTimer, type RealtimeTimerPayload } from '../realtime-timer-scheduler.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { DuelStatePayload } from '../socket.types.js';

const RECOVERY_MS = 1_000;
/** A socket gone for less than this (a reload, a blip) never pauses a duel. */
const DISCONNECT_DEBOUNCE_MS = 2_000;
const pendingAbsence = new Map<string, NodeJS.Timeout>();
const LAST_DISCONNECT_TTL_SEC = 60;
const MAX_STALE_RECHECKS = 3;

/** The newest disconnect of the user, shared by every replica (Redis; this process alone when Redis is down). */
const localLastDisconnect = new Map<string, number>();
async function markDisconnect(userId: string): Promise<void> {
  const now = Date.now();
  localLastDisconnect.set(userId, now);
  const redis = getRedisClient();
  if (redis?.isOpen) await redis.set(`duel:lastdc:${userId}`, String(now), { EX: LAST_DISCONNECT_TTL_SEC }).catch(() => {});
}
async function lastDisconnect(userId: string): Promise<number> {
  const redis = getRedisClient();
  const shared = redis?.isOpen ? Number(await redis.get(`duel:lastdc:${userId}`).catch(() => null)) : 0;
  return Math.max(shared || 0, localLastDisconnect.get(userId) ?? 0);
}

/**
 * The debounced absence check. It waits until DISCONNECT_DEBOUNCE_MS after the user's LATEST disconnect on any
 * replica, confirms no socket is left anywhere, then marks the seat away (fenced by the presence generation).
 * A check that finds no socket but a newer generation (a connect that was processed after its socket had already
 * closed) re-reads the generation and checks again rather than leaving an absent player marked present.
 */
function scheduleAbsenceCheck(io: QuizballServer, userId: string, generation: number, delayMs: number, recheck: number): void {
  clearTimeout(pendingAbsence.get(userId));
  const timer = setTimeout(() => {
    pendingAbsence.delete(userId);
    void (async () => {
      const waitMs = (await lastDisconnect(userId)) + DISCONNECT_DEBOUNCE_MS - Date.now();
      if (waitMs > 50) return scheduleAbsenceCheck(io, userId, generation, waitMs, recheck);
      const sockets = await io.in(`user:${userId}`).fetchSockets().catch(() => null);
      if (sockets === null || sockets.length > 0) return;
      const effects = await duelService.absent(userId, generation);
      if (effects) return deliver(io, effects);
      const current = await duelService.presenceGeneration(userId);
      if (current !== null && current !== generation && recheck < MAX_STALE_RECHECKS) {
        scheduleAbsenceCheck(io, userId, current, 500, recheck + 1);
      }
    })().catch((error) => logger.warn({ error, userId }, 'Duel absence handling failed'));
  }, delayMs);
  timer.unref?.();
  pendingAbsence.set(userId, timer);
}
let recoveryTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
const MAINTENANCE_MS = 60_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
let recoveryRunning = false;

async function emitSnapshot(io: QuizballServer, matchId: string, userId: string, locale?: DuelLocale): Promise<void> {
  const snapshot = await duelService.snapshot(matchId, userId, locale);
  if (snapshot) io.to(`user:${userId}`).emit('duel:state', snapshot as DuelStatePayload);
}

const TIMER_ARM_TIMEOUT_MS = 1_500;

/** Never waits on a stuck Redis longer than this: Postgres holds every deadline and the recovery poll covers a lost arm. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** After a commit: every seat gets its own snapshot, the clock is armed, a finished match refreshes its room. */
async function deliver(io: QuizballServer, effects: DuelEffects | null): Promise<void> {
  if (!effects) return;
  if (effects.timer) {
    await withTimeout(scheduleRealtimeTimer('duel_phase', effects.matchId, effects.timer.dueAt, {
      kind: 'duel_phase', matchId: effects.matchId, phaseToken: effects.timer.token,
    }), TIMER_ARM_TIMEOUT_MS).catch((error) => logger.warn({ error, matchId: effects.matchId }, 'Duel timer arm failed; the recovery poll covers it'));
  }
  await Promise.all(effects.userIds.map((userId) => emitSnapshot(io, effects.matchId, userId).catch((error) => {
    logger.warn({ error, matchId: effects.matchId, userId }, 'Duel state delivery failed; the client resyncs');
  })));
  if (effects.finished && effects.lobbyId) {
    await emitLobbyState(io, effects.lobbyId).catch((error) => logger.warn({ error, lobbyId: effects.lobbyId }, 'Duel room state delivery failed'));
  }
}

function emitError(socket: QuizballSocket, error: unknown, matchId?: string): void {
  if (error instanceof DuelError) {
    socket.emit('duel:error', { code: error.code, message: error.code, ...(matchId ? { matchId } : {}) });
    return;
  }
  logger.error({ error, matchId, userId: socket.data.user.id }, 'Duel handler failed');
  socket.emit('duel:error', { code: 'duel_unavailable', message: 'duel_unavailable', ...(matchId ? { matchId } : {}) });
}

export const duelRealtimeService = {
  deliver,
  emitError,

  /** Post-commit delivery of a new match: the room's two users are sent to the duel screen. */
  async announce(io: QuizballServer, effects: DuelEffects, game: string): Promise<void> {
    for (const userId of effects.userIds) {
      io.to(`user:${userId}`).emit('duel:found', { matchId: effects.matchId, game: game as DuelStatePayload['game'], lobbyId: effects.lobbyId });
    }
    await deliver(io, effects);
  },

  async handleReady(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; locale?: string }): Promise<void> {
    const effects = await duelService.ready(data.matchId, socket.data.user.id, asDuelLocale(data.locale) ?? 'es');
    await deliver(io, effects);
  },

  async handleCommand(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; commandId: string; command: unknown }): Promise<void> {
    const { result, effects } = await duelService.command(data.matchId, socket.data.user.id, data.commandId, data.command);
    socket.emit('duel:command_result', { matchId: data.matchId, commandId: data.commandId, ...result });
    if (effects) await deliver(io, effects);
    else if (!result.ok) await emitSnapshot(io, data.matchId, socket.data.user.id);
  },

  async handleResync(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; locale?: string }): Promise<void> {
    const locale = asDuelLocale(data.locale);
    if (locale) await duelService.setLocale(data.matchId, socket.data.user.id, locale);
    // A screen that asks for the state is a player who is here: a missed connect event must not leave them absent.
    await deliver(io, await duelService.present(socket.data.user.id));
    const snapshot = await duelService.snapshot(data.matchId, socket.data.user.id, locale);
    if (!snapshot) throw new DuelError('duel_not_found', 404);
    socket.emit('duel:state', snapshot as DuelStatePayload);
  },

  async handleForfeit(io: QuizballServer, socket: QuizballSocket, data: { matchId: string }): Promise<void> {
    await deliver(io, await duelService.forfeit(data.matchId, socket.data.user.id));
  },

  async handlePhaseTimer(io: QuizballServer, payload: RealtimeTimerPayload): Promise<void> {
    if (payload.kind !== 'duel_phase') return;
    await deliver(io, await duelService.expire(payload.matchId, payload.phaseToken));
  },

  /** Postgres is the source of every duel deadline: overdue rows are handled whether or not Redis still holds a timer. */
  startRecovery(io: QuizballServer): void {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(() => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      void (async () => {
        try {
          // Expiring is the database's work and runs to the end of the list; delivery (Redis, sockets) is detached,
          // so a stuck Redis can delay a screen update but never the next match's expiry.
          for (const due of await duelService.dueMatches()) {
            try {
              const effects = await duelService.expire(due.id, due.phase_token);
              void deliver(io, effects).catch((error) => logger.warn({ error, matchId: due.id }, 'Duel recovery delivery failed'));
            } catch (error) {
              logger.warn({ error, matchId: due.id }, 'Duel recovery expiry failed');
            }
          }
        } catch (error) {
          logger.warn({ error }, 'Duel recovery poll failed');
        } finally {
          recoveryRunning = false;
        }
      })();
    }, RECOVERY_MS);
    recoveryTimer.unref?.();
  },

  stopRecovery(): void {
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    recoveryTimer = null;
    maintenanceTimer = null;
  },

  /** Slow housekeeping: the age cap (a bug net) and retention. Safe on every replica (row locks, bounded batches). */
  startMaintenance(io: QuizballServer): void {
    if (maintenanceTimer) return;
    let lastPurge = 0;
    maintenanceTimer = setInterval(() => {
      void (async () => {
        for (const id of await duelService.staleLiveMatches()) {
          const effects = await duelService.cancelStale(id).catch((error) => { logger.warn({ error, matchId: id }, 'Duel age-cap cancel failed'); return null; });
          void deliver(io, effects).catch(() => {});
        }
        if (Date.now() - lastPurge > PURGE_EVERY_MS) {
          lastPurge = Date.now();
          const purged = await duelService.purgeEnded();
          if (purged.commands + purged.contents > 0) logger.info(purged, 'Duel retention purge');
        }
      })().catch((error) => logger.warn({ error }, 'Duel maintenance failed'));
    }, MAINTENANCE_MS);
    maintenanceTimer.unref?.();
  },

  /**
   * A connecting player in a live duel is present again (a paused match may resume) and is pointed back at the
   * duel, wherever on the site they are. Returns whether the socket is now bound to a live duel.
   * With every duel game switched off, connects pay no lookup (a draining duel still ends on its own clocks).
   */
  async onConnect(io: QuizballServer, socket: QuizballSocket): Promise<boolean> {
    if (!anyDuelGameEnabled()) return false;
    const userId = socket.data.user.id;
    const live = await duelService.liveMatchFor(userId);
    // Always answered, so a client that remembers a duel that has since ended can forget it.
    socket.emit('duel:active', live ? { matchId: live.id, game: live.game, lobbyId: live.lobby_id } : null);
    if (!live) return false;
    socket.data.duelMatchId = live.id;
    socket.emit('duel:found', { matchId: live.id, game: live.game, lobbyId: live.lobby_id });
    // The lookup may have outlived the socket: a closed socket is not a presence (its disconnect is being handled).
    if (socket.connected) await deliver(io, await duelService.present(userId));
    return true;
  },

  /** Only a socket seen in a duel, or bound to a room (duels start from rooms), can leave a duel seat behind. */
  mayHoldDuelSeat(socket: QuizballSocket): boolean {
    return Boolean(socket.data.duelMatchId || socket.data.lobbyId);
  },

  /**
   * A socket closed. Blips are free: only when the player still has no socket after DISCONNECT_DEBOUNCE_MS
   * (a reload, a network hiccup reconnect well within it) does the seat go absent and the match pause.
   * Presence is read across replicas through the user's room.
   */
  async handleSocketDisconnect(io: QuizballServer, userId: string): Promise<void> {
    // Read the seat's presence generation now: any (re)connect before the check commits bumps it, and the
    // check then does nothing, even when the reconnect landed on another replica.
    const generation = await duelService.presenceGeneration(userId);
    if (generation === null) return;
    await markDisconnect(userId);
    scheduleAbsenceCheck(io, userId, generation, DISCONNECT_DEBOUNCE_MS, 0);
  },
};
