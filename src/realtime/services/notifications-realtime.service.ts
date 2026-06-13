import type { QuizballServer } from '../socket-server.js';
import type { NotificationPayload } from '../socket.types.js';
import { logger } from '../../core/logger.js';
import { InternalError } from '../../core/errors.js';

/**
 * Module-local Socket.IO reference, set once at boot from
 * `socket-server.ts:initSocketServer`, so the notifications service can emit to
 * a user's room without importing `socket-server.ts` directly (avoids a
 * circular dependency). Mirrors `auth-realtime.service.ts`.
 */
let ioRef: QuizballServer | null = null;

export function setNotificationsRealtimeServer(io: QuizballServer): void {
  if (!io) {
    throw new InternalError('setNotificationsRealtimeServer: QuizballServer instance must not be null/undefined');
  }
  if (ioRef && ioRef !== io) {
    logger.warn('notifications-realtime server already initialized — overwriting reference');
  }
  ioRef = io;
}

/** Best-effort: push a new notification to all of a user's connected sockets. */
export function emitNotificationNew(userId: string, payload: NotificationPayload): void {
  if (!ioRef) return;
  try {
    ioRef.to(`user:${userId}`).emit('notification:new', payload);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to emit notification:new');
  }
}

/** Best-effort: push an updated unread count to all of a user's connected sockets. */
export function emitNotificationUnreadCount(userId: string, unreadCount: number): void {
  if (!ioRef) return;
  try {
    ioRef.to(`user:${userId}`).emit('notification:unread_count', { unreadCount });
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to emit notification:unread_count');
  }
}
