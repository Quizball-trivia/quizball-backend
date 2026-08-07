import type { QuizballServer } from '../socket-server.js';
import type { SystemStatusPayload } from '../socket.types.js';
import { logger } from '../../core/logger.js';
import { InternalError } from '../../core/errors.js';
import { readOnlyDbBreaker } from '../../db/readonly-breaker.js';

/**
 * Module-local reference to the Socket.IO server, set once at boot from
 * `socket-server.ts` (mirrors `setAuthRealtimeServer`). Lets the DB-layer
 * breaker signal a state edge without the breaker ever importing the realtime
 * layer: the breaker fires an io-free callback, this service does the emit.
 */
let ioRef: QuizballServer | null = null;

export function setSystemStatusRealtimeServer(io: QuizballServer): void {
  if (!io) {
    throw new InternalError('setSystemStatusRealtimeServer: QuizballServer instance must not be null/undefined');
  }
  if (ioRef && ioRef !== io) {
    logger.warn('system-status server already initialized — overwriting reference');
  }
  ioRef = io;
  // Register the breaker edge listener now that we can actually emit. The
  // breaker fires this on the trip edge and the recovery edge only.
  readOnlyDbBreaker.setStateChangeListener(() => {
    emitSystemStatus();
  });
}

/**
 * Build the current system-status snapshot purely from the in-memory breaker.
 * NO database access — safe to call from a socket connect handler, a broadcast,
 * or an unauthenticated HTTP route.
 *
 * `matchmaking: 'paused'` while degraded is the player-facing truth: during a
 * write outage ranked queue joins are refused so no ticket is spent on a match
 * that cannot be settled.
 */
export function buildSystemStatus(): SystemStatusPayload {
  const snapshot = readOnlyDbBreaker.snapshot();
  const degraded = snapshot.degraded;
  const sinceMs = degraded ? snapshot.trippedAtMs : null;
  return {
    degraded,
    reason: degraded ? 'db_write_outage' : null,
    matchmaking: degraded ? 'paused' : 'available',
    sinceMs,
    serverTimeMs: Date.now(),
  };
}

/**
 * Broadcast the current system status to every connected socket. Best-effort:
 * a missing io reference (breaker tripped before boot wired the server) or an
 * emit failure is logged, never thrown — a status broadcast must not break the
 * error path that triggered it.
 */
export function emitSystemStatus(): void {
  if (!ioRef) {
    logger.warn('emitSystemStatus called before system-status server was initialized');
    return;
  }
  try {
    ioRef.emit('system:status', buildSystemStatus());
  } catch (error) {
    logger.warn({ error }, 'Failed to broadcast system:status');
  }
}

/**
 * Send the current system status to a single freshly-connected socket, so a
 * client that connects DURING an active outage learns it immediately instead
 * of waiting for the next state edge.
 */
export function emitSystemStatusToSocket(emit: (payload: SystemStatusPayload) => void): void {
  try {
    emit(buildSystemStatus());
  } catch (error) {
    logger.warn({ error }, 'Failed to emit system:status to socket');
  }
}

/** Test-only: detach the breaker listener and clear the server reference. */
export function __resetSystemStatusForTests(): void {
  readOnlyDbBreaker.setStateChangeListener(null);
  ioRef = null;
}
