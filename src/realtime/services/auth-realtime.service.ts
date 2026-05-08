import type { QuizballServer } from '../socket-server.js';
import type { ForceLogoutPayload } from '../socket.types.js';
import { logger } from '../../core/logger.js';

/**
 * Module-local reference to the Socket.IO server. Set once at boot from
 * `socket-server.ts:initSocketServer` so that `users.service.ts` can call
 * `disconnectUserSockets` without importing from `socket-server.ts` directly
 * (which would create a circular dependency:
 *   socket-server.ts → socket-auth.ts → users.service.ts → socket-server.ts).
 */
let ioRef: QuizballServer | null = null;

const EMIT_FLUSH_DELAY_MS = 100;

export function setAuthRealtimeServer(io: QuizballServer): void {
  if (!io) {
    throw new Error('setAuthRealtimeServer: io must not be null/undefined');
  }
  if (ioRef && ioRef !== io) {
    // Test harnesses re-init repeatedly; warn but allow rebind.
    logger.warn('auth-realtime server already initialized — overwriting reference');
  }
  ioRef = io;
}

/**
 * Force-disconnect every socket owned by `userId` and notify clients.
 *
 * Best-effort: any failure (Redis hiccup, no listener attached, etc.) is logged
 * but never thrown. Account deletion / admin revoke flows must not fail just
 * because the realtime layer is misbehaving.
 *
 * Uses Socket.IO room APIs so the operation works correctly through the Redis
 * adapter across multiple pods — `socket-auth.ts` joins every authenticated
 * socket to `user:${userId}` on connect.
 *
 * Async + small flush delay between emit and disconnect: Socket.IO `emit()` is
 * fire-and-forget and queued asynchronously, while `disconnectSockets(true)`
 * force-closes immediately. Without the gap, clients can drop before they
 * receive `auth:force_logout` and never see the toast / redirect.
 */
export async function disconnectUserSockets(
  userId: string,
  reason: ForceLogoutPayload['reason']
): Promise<void> {
  if (!ioRef) {
    logger.warn({ userId, reason }, 'auth-realtime server not initialized — skipping disconnect');
    return;
  }
  const room = `user:${userId}`;
  try {
    ioRef.to(room).emit('auth:force_logout', { reason });
    await new Promise<void>((resolve) => setTimeout(resolve, EMIT_FLUSH_DELAY_MS));
    ioRef.in(room).disconnectSockets(true);
  } catch (err) {
    logger.warn({ err, userId, reason }, 'Failed to force-disconnect user sockets');
  }
}
