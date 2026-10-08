import { gameplayDbTaskLimiter, SocketDbTaskOverloadedError } from '../socket-db-task-limiter.js';
import { logger } from '../../core/logger.js';
import { anyRoomGameEnabled } from '../../modules/room/room.config.js';
import { roomService, type RoomEffects } from '../../modules/room/room.service.js';
import type { PresenceFence } from '../../modules/room/room.repo.js';
import { asRoomLocale, RoomError, type RoomGameId, type RoomLocale } from '../../modules/room/room.types.js';
import { wordgameReportsService } from '../../modules/wordgame-reports/wordgame-reports.service.js';
import { emitLobbyState } from '../lobby-utils.js';
import { scheduleRealtimeTimer, type RealtimeTimerPayload } from '../realtime-timer-scheduler.js';
import { getRedisClient } from '../redis.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type { RoomStatePayload } from '../socket.types.js';
import { KeyedTaskCoalescer } from '../keyed-task-coalescer.js';

// Broadcast reads use two workflows, leaving the DB budget for committed
// commands. Coalesce by match instead of reading identical data six times.
const stateDeliveries = new KeyedTaskCoalescer(2, 512, 5_000);

const RECOVERY_MS = 1_000;
/** A socket gone for less than this (a reload, a blip) never marks a seat away. */
const DISCONNECT_DEBOUNCE_MS = 2_000;
const pendingAbsence = new Map<string, NodeJS.Timeout>();
const LAST_DISCONNECT_TTL_SEC = 60;
const MAX_STALE_RECHECKS = 3;
/** A failed presence probe (Redis adapter, database) is tried again this often, this many times. */
const PROBE_RETRY_MS = 1_000;
const MAX_PROBE_RETRIES = 5;
/** Seats the database still calls connected are compared with the live sockets this often (lost timers, restarts). */
const PRESENCE_SWEEP_MS = 10_000;
const TIMER_ARM_TIMEOUT_MS = 1_500;
const MAINTENANCE_MS = 60_000;
const PURGE_EVERY_MS = 60 * 60 * 1000;

/**
 * Per user, bumped before anything about their room matches is delivered (a start, any committed change, the end). A
 * connect/pointer lookup that saw it move reads again, so it never sends a pointer older than what was delivered.
 * This process only: another replica's change is caught by the client's own pointer request on the room screen.
 */
const userRev = new Map<string, { rev: number; at: number }>();
// One counter for everyone: a user's next revision is always a number never handed out before, so an entry can be
// forgotten (see pruneMemory) without a later bump ever repeating the value a read in flight started from.
let revSeq = 0;
const bumpUsers = (userIds: readonly string[]) => { const at = Date.now(); for (const id of userIds) userRev.set(id, { rev: ++revSeq, at }); };
const revisionOf = (userId: string): number => userRev.get(userId)?.rev ?? 0;
const REV_TTL_MS = 10 * 60_000;
/** Bumped by every prune: a pointer read that spans one reads again (a pruned entry reads as 0, like "never changed"). */
let pruneEpoch = 0;

const localLastDisconnect = new Map<string, number>();
async function markDisconnect(userId: string): Promise<void> {
  const now = Date.now();
  localLastDisconnect.set(userId, now);
  const redis = getRedisClient();
  if (redis?.isOpen) await redis.set(`room:lastdc:${userId}`, String(now), { EX: LAST_DISCONNECT_TTL_SEC }).catch(() => {});
}
/** Drops revisions and local disconnect stamps nothing can still need (run on the maintenance tick). */
function pruneMemory(nowMs = Date.now()): void {
  pruneEpoch += 1;
  for (const [id, entry] of userRev) if (nowMs - entry.at > REV_TTL_MS) userRev.delete(id);
  for (const [id, at] of localLastDisconnect) if (nowMs - at > LAST_DISCONNECT_TTL_SEC * 1_000) localLastDisconnect.delete(id);
}

async function lastDisconnect(userId: string): Promise<number> {
  const redis = getRedisClient();
  const shared = redis?.isOpen ? Number(await redis.get(`room:lastdc:${userId}`).catch(() => null)) : 0;
  return Math.max(shared || 0, localLastDisconnect.get(userId) ?? 0);
}

/**
 * Same debounce as duels: away only when no socket is left on any replica, fenced by the presence generation. A probe
 * or database failure is retried (a lost check would leave a gone player "connected" for the rest of the match); the
 * presence sweep also catches checks lost to a restart.
 */
function scheduleAbsenceCheck(io: QuizballServer, userId: string, fence: PresenceFence, delayMs: number, recheck: number, retry = 0): void {
  clearTimeout(pendingAbsence.get(userId));
  const again = () => { if (retry < MAX_PROBE_RETRIES) scheduleAbsenceCheck(io, userId, fence, PROBE_RETRY_MS, recheck, retry + 1); };
  const timer = setTimeout(() => {
    pendingAbsence.delete(userId);
    void (async () => {
      const waitMs = (await lastDisconnect(userId)) + DISCONNECT_DEBOUNCE_MS - Date.now();
      if (waitMs > 50) return scheduleAbsenceCheck(io, userId, fence, waitMs, recheck, retry);
      const sockets = await io.in(`user:${userId}`).fetchSockets().catch(() => null);
      if (sockets === null) return again();
      if (sockets.length > 0) return;
      const effects = await roomService.absent(userId, fence);
      if (effects) return deliver(io, effects);
      const current = await roomService.presenceGeneration(userId);
      if (current && current.matchId === fence.matchId && current.gen !== fence.gen && recheck < MAX_STALE_RECHECKS) {
        scheduleAbsenceCheck(io, userId, current, 500, recheck + 1);
      }
    })().catch((error) => {
      logger.warn({ error, userId }, 'Room absence handling failed; retrying');
      again();
    });
  }, delayMs);
  timer.unref?.();
  pendingAbsence.set(userId, timer);
}

const PRESENCE_PAGE = 500;
let presenceCursor: { userId: string; matchId: string } | null = null;

/**
 * Seats marked connected whose player has no socket anywhere and no check pending get one (after a restart, a lost
 * timer). One page per sweep, continuing where the last one stopped, so above a page of seats every seat is still
 * checked within a few sweeps.
 */
async function sweepPresence(io: QuizballServer): Promise<void> {
  const page = await roomService.connectedLiveSeats(PRESENCE_PAGE, presenceCursor);
  const last = page.at(-1);
  presenceCursor = page.length === PRESENCE_PAGE && last ? { userId: last.user_id, matchId: last.match_id } : null;
  for (const seat of page) {
    if (pendingAbsence.has(seat.user_id)) continue;
    const sockets = await io.in(`user:${seat.user_id}`).fetchSockets().catch(() => null);
    if (sockets === null || sockets.length > 0) continue;
    await markDisconnect(seat.user_id);
    scheduleAbsenceCheck(io, seat.user_id, { matchId: seat.match_id, gen: seat.presence_gen }, DISCONNECT_DEBOUNCE_MS, 0);
  }
}

let recoveryTimer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let presenceTimer: NodeJS.Timeout | null = null;
let presenceRunning = false;
let recoveryRunning = false;
let liveRoomsMayExist = true;
const roomsMayBeLive = (): boolean => anyRoomGameEnabled() || liveRoomsMayExist;

async function emitSnapshot(io: QuizballServer, matchId: string, userId: string, locale?: RoomLocale): Promise<void> {
  const snapshot = await roomService.snapshot(matchId, userId, locale);
  if (snapshot) io.to(`user:${userId}`).emit('room:state', snapshot as unknown as RoomStatePayload);
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Arms the next deadline, then broadcasts the new state. `detach`: return once the timer is armed and broadcast in the
 * background, for callers on the shared timer workers (a slow snapshot read must not hold up other games' timers).
 */
async function deliver(io: QuizballServer, effects: RoomEffects | null, { detach = false }: { detach?: boolean } = {}): Promise<void> {
  if (!effects) return;
  bumpUsers(effects.userIds);
  if (effects.timer) {
    await withTimeout(scheduleRealtimeTimer('room_phase', effects.matchId, effects.timer.dueAt, {
      kind: 'room_phase', matchId: effects.matchId, phaseToken: effects.timer.token,
    }), TIMER_ARM_TIMEOUT_MS).catch((error) => logger.warn({ error, matchId: effects.matchId }, 'Room timer arm failed; the recovery poll covers it'));
  }
  const broadcast = broadcastState(io, effects);
  if (!detach) await broadcast;
}

async function broadcastState(io: QuizballServer, effects: RoomEffects): Promise<void> {
  await stateDeliveries.run(effects.matchId, async () => {
    const snapshots = await roomService.snapshots(effects.matchId, effects.userIds);
    for (const [userId, snapshot] of snapshots) {
      io.to(`user:${userId}`).emit('room:state', snapshot as unknown as RoomStatePayload);
    }
  }).catch((error) => {
    logger.warn({ error, matchId: effects.matchId }, 'Room state delivery failed; the client resyncs');
  });
  if (effects.finished && effects.lobbyId) {
    await emitLobbyState(io, effects.lobbyId).catch((error) => logger.warn({ error, lobbyId: effects.lobbyId }, 'Room lobby state delivery failed'));
  }
}

/**
 * Reads the user's live seat (or the match they sit out) and sends room:active + room:sitting_out. A delivery to the
 * user during the read (userRev moved) makes it read again; still moving after three reads, it tries again shortly
 * instead of sending an answer it knows is stale (undefined = not sent).
 */
type LiveRoomMatch = Awaited<ReturnType<typeof roomService.liveMatchFor>>;
/** `then` runs after the answer was sent, also when a deferred retry is the one that sends it. */
async function emitPointer(socket: QuizballSocket, attempt = 0, then?: (live: LiveRoomMatch) => Promise<void>): Promise<LiveRoomMatch | undefined> {
  const userId = socket.data.user.id;
  for (let i = 0; i < 3; i += 1) {
    const rev = revisionOf(userId);
    const epoch = pruneEpoch;
    const { asOf, live } = await roomService.livePointerFor(userId);
    const out = live ? null : await roomService.sittingOutFor(userId);
    if (revisionOf(userId) !== rev || pruneEpoch !== epoch) continue;
    socket.data.roomChecked = true;
    socket.data.roomMatchId = live?.id;
    socket.emit('room:active', live ? { matchId: live.id, game: live.game, lobbyId: live.lobby_id } : null, { asOf });
    socket.emit('room:sitting_out', out?.lobby_id ? { matchId: out.id, lobbyId: out.lobby_id, reason: out.left ? 'left' : 'out' } : null, { asOf });
    if (then) await then(live);
    return live;
  }
  if (attempt < 3) setTimeout(() => { if (socket.connected) void emitPointer(socket, attempt + 1, then).catch(() => {}); }, 300).unref?.();
  return undefined;
}

/** Binds the socket to a match it holds a live seat in (disconnect bookkeeping, the connect-time fence). */
function bindIfLive(socket: QuizballSocket, snapshot: { matchId: string; status: string; me: { active: boolean } }): void {
  if (snapshot.me.active && (snapshot.status === 'ready' || snapshot.status === 'active')) socket.data.roomMatchId = snapshot.matchId;
}

function emitError(socket: QuizballSocket, error: unknown, matchId?: string): void {
  if (error instanceof RoomError) {
    socket.emit('room:error', { code: error.code, message: error.code, ...(matchId ? { matchId } : {}) });
    return;
  }
  // A busy gameplay limiter is load, not a fault: warn without a stack per rejected command.
  if (error instanceof SocketDbTaskOverloadedError) {
    logger.warn({ reason: error.reason, matchId, userId: socket.data.user.id }, 'Room command rejected: gameplay DB busy');
  } else {
    // Error objects serialize to {} in the JSON logger: keep the message and stack.
    const detail = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
    logger.error({ error: detail, matchId, userId: socket.data.user.id }, 'Room handler failed');
  }
  socket.emit('room:error', { code: 'room_unavailable', message: 'room_unavailable', ...(matchId ? { matchId } : {}) });
}

export const roomRealtimeService = {
  deliver,
  emitError,
  /** A committed change about these users' room matches, before anything about it is broadcast (a lobby start). */
  markChanged: bumpUsers,
  revisionOf,
  pruneMemory,
  memoryStats: () => ({ revisions: userRev.size, disconnects: localLastDisconnect.size }),

  async announce(io: QuizballServer, effects: RoomEffects, game: RoomGameId): Promise<void> {
    bumpUsers(effects.userIds);
    for (const userId of effects.userIds) {
      io.to(`user:${userId}`).emit('room:found', { matchId: effects.matchId, game, lobbyId: effects.lobbyId, startedAt: effects.startedAtMs });
    }
    await deliver(io, effects);
  },

  async handleReady(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; locale?: string; games?: string[] }): Promise<void> {
    const effects = await gameplayDbTaskLimiter.run(() => roomService.ready(data.matchId, socket.data.user.id, asRoomLocale(data.locale) ?? 'es', data.games));
    await deliver(io, effects);
  },

  async handleCommand(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; commandId: string; command: unknown }): Promise<void> {
    // The slot covers the commit only: the broadcast below waits for its own budget without holding a gameplay slot.
    const { result, effects } = await gameplayDbTaskLimiter.run(() => roomService.command(data.matchId, socket.data.user.id, data.commandId, data.command));
    socket.emit('room:command_result', { matchId: data.matchId, commandId: data.commandId, ...result });
    if (effects) await deliver(io, effects);
    else if (!result.ok) await emitSnapshot(io, data.matchId, socket.data.user.id);
  },

  async handleResync(io: QuizballServer, socket: QuizballSocket, data: { matchId: string; locale?: string; games?: string[] }): Promise<void> {
    const locale = asRoomLocale(data.locale);
    if (locale) await roomService.setLocale(data.matchId, socket.data.user.id, locale);
    // A screen asking for the state is a player who is here: a missed connect must not leave the seat away.
    await deliver(io, await roomService.present(socket.data.user.id, data.games));
    const snapshot = await roomService.snapshot(data.matchId, socket.data.user.id, locale);
    if (!snapshot) throw new RoomError('room_not_found', 404);
    bindIfLive(socket, snapshot);
    socket.emit('room:state', snapshot as unknown as RoomStatePayload);
  },

  async handleLeave(io: QuizballServer, socket: QuizballSocket, data: { matchId: string }): Promise<void> {
    const effects = await gameplayDbTaskLimiter.run(() => roomService.leave(data.matchId, socket.data.user.id));
    await deliver(io, effects);
    // The leaver's own screen always learns the outcome, even when the seat was already gone.
    if (!effects) await emitSnapshot(io, data.matchId, socket.data.user.id);
  },

  /** "That was right": stored for the weekly review when the text really was refused in a match the player sat in. No answer either way. */
  async handleReport(socket: QuizballSocket, data: { matchId: string; round: number; text: string }): Promise<void> {
    const userId = socket.data.user.id;
    const refusal = await roomService.refusal(data.matchId, userId, data.round, data.text);
    if (!refusal || (refusal.game !== 'shared_player' && refusal.game !== 'name_chain')) return;
    await wordgameReportsService.file({ game: refusal.game, source: 'room', contextId: data.matchId, round: data.round, reporter: { userId } }, refusal, data.text);
  },

  async handlePhaseTimer(io: QuizballServer, payload: RealtimeTimerPayload): Promise<void> {
    if (payload.kind !== 'room_phase') return;
    await deliver(io, await roomService.expire(payload.matchId, payload.phaseToken), { detach: true });
  },

  /** Postgres holds every room deadline: overdue rows are handled whether or not Redis still holds a timer. */
  startRecovery(io: QuizballServer): void {
    if (recoveryTimer) return;
    recoveryTimer = setInterval(() => {
      if (recoveryRunning || !roomsMayBeLive()) return;
      recoveryRunning = true;
      void (async () => {
        try {
          for (const due of await roomService.dueMatches()) {
            try {
              const effects = await roomService.expire(due.id, due.phase_token);
              void deliver(io, effects).catch((error) => logger.warn({ error, matchId: due.id }, 'Room recovery delivery failed'));
            } catch (error) {
              logger.warn({ error, matchId: due.id }, 'Room recovery expiry failed');
            }
          }
        } catch (error) {
          logger.warn({ error }, 'Room recovery poll failed');
        } finally {
          recoveryRunning = false;
        }
      })();
    }, RECOVERY_MS);
    recoveryTimer.unref?.();
    presenceTimer = setInterval(() => {
      if (presenceRunning || !roomsMayBeLive()) return;
      presenceRunning = true;
      void sweepPresence(io).catch((error) => logger.warn({ error }, 'Room presence sweep failed')).finally(() => { presenceRunning = false; });
    }, PRESENCE_SWEEP_MS);
    presenceTimer.unref?.();
  },

  stopRecovery(): void {
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    recoveryTimer = null;
    maintenanceTimer = null;
    presenceTimer = null;
  },

  startMaintenance(io: QuizballServer): void {
    if (maintenanceTimer) return;
    let lastPurge = 0;
    void roomService.anyLive().then((live) => { liveRoomsMayExist = live; }).catch(() => {});
    maintenanceTimer = setInterval(() => {
      pruneMemory();
      void (async () => {
        liveRoomsMayExist = await roomService.anyLive();
        for (const id of await roomService.staleLiveMatches()) {
          const effects = await roomService.cancelStale(id).catch((error) => { logger.warn({ error, matchId: id }, 'Room age-cap cancel failed'); return null; });
          void deliver(io, effects).catch(() => {});
        }
        if (Date.now() - lastPurge > PURGE_EVERY_MS) {
          lastPurge = Date.now();
          const purged = await roomService.purgeEnded();
          if (purged.commands + purged.contents > 0) logger.info(purged, 'Room retention purge');
          const reports = await wordgameReportsService.purge();
          if (reports > 0) logger.info({ reports }, 'Word game reports retention purge');
        }
      })().catch((error) => logger.warn({ error }, 'Room maintenance failed'));
    }, MAINTENANCE_MS);
    maintenanceTimer.unref?.();
  },

  /**
   * On connect: the player's live seat (pointer + presence), or — with none — the live match of their room they are
   * sitting out (left it, withdrawn, or left out at the gate), so the room screen shows the room and its Leave.
   * Both are always answered (a client may remember a match that has since ended).
   */
  async onConnect(io: QuizballServer, socket: QuizballSocket): Promise<boolean> {
    if (!roomsMayBeLive()) {
      socket.data.roomChecked = true;
      socket.data.roomMatchId = undefined;
      socket.emit('room:active', null);
      socket.emit('room:sitting_out', null);
      return false;
    }
    const live = await emitPointer(socket).catch((error) => {
      logger.warn({ error, userId: socket.data.user.id }, 'Room pointer lookup failed on connect; the room screen asks again');
      return undefined;
    });
    // No room:found here: the room:active just sent (stamped with its read time) already points at the live seat,
    // and an unstamped duplicate could override a newer start the client heard meanwhile.
    // Presence does not depend on the pointer read (it finds the live seat itself, and does nothing without one): a
    // read deferred by concurrent deliveries must not leave a connected player marked away.
    if (socket.connected) await deliver(io, await roomService.present(socket.data.user.id));
    return Boolean(live);
  },

  /** The room screen asks where its player stands (on mount, after its state changed): the same answer as on connect. */
  async handlePointer(socket: QuizballSocket): Promise<void> {
    await emitPointer(socket);
  },

  mayHoldRoomSeat(socket: QuizballSocket): boolean {
    if (socket.data.roomMatchId) return true;
    if (!roomsMayBeLive()) return false;
    return Boolean(socket.data.lobbyId) || !socket.data.roomChecked;
  },

  async handleSocketDisconnect(io: QuizballServer, userId: string): Promise<void> {
    const fence = await roomService.presenceGeneration(userId);
    if (!fence) return;
    await markDisconnect(userId);
    scheduleAbsenceCheck(io, userId, fence, DISCONNECT_DEBOUNCE_MS, 0);
  },
};
