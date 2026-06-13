import { logger } from '../../core/logger.js';
import type { I18nField } from '../../http/schemas/shared.js';
import {
  emitNotificationNew,
  emitNotificationUnreadCount,
} from '../../realtime/services/notifications-realtime.service.js';
import { notificationsRepo, type NotificationRow } from './notifications.repo.js';
import type {
  ListNotificationsResponse,
  Notification,
  NotificationType,
} from './notifications.schemas.js';

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export interface NotifyInput {
  type: NotificationType;
  title: I18nField;
  body?: I18nField | null;
  data?: Record<string, unknown>;
}

export const notificationsService = {
  /**
   * Create a notification for a user, persist it, and push it live over the
   * socket (best-effort — persistence is the source of truth, the emit is a
   * latency optimization for online users).
   */
  async notify(userId: string, input: NotifyInput): Promise<Notification> {
    const row = await notificationsRepo.insert({
      userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      data: input.data ?? {},
    });
    const notification = toNotification(row);

    emitNotificationNew(userId, notification);
    const unreadCount = await notificationsRepo.unreadCount(userId);
    emitNotificationUnreadCount(userId, unreadCount);

    logger.info({ userId, type: input.type, notificationId: row.id }, 'Notification created');
    return notification;
  },

  async listForUser(
    userId: string,
    options: { limit: number; before?: string; beforeId?: string }
  ): Promise<ListNotificationsResponse> {
    const [rows, unreadCount] = await Promise.all([
      notificationsRepo.listForUser(userId, options),
      notificationsRepo.unreadCount(userId),
    ]);
    return { items: rows.map(toNotification), unreadCount };
  },

  async unreadCount(userId: string): Promise<number> {
    return notificationsRepo.unreadCount(userId);
  },

  async markRead(userId: string, notificationId: string): Promise<number> {
    await notificationsRepo.markRead(userId, notificationId);
    const unreadCount = await notificationsRepo.unreadCount(userId);
    emitNotificationUnreadCount(userId, unreadCount);
    return unreadCount;
  },

  async markAllRead(userId: string): Promise<number> {
    await notificationsRepo.markAllRead(userId);
    // Re-read rather than assuming 0: a concurrent notify() for the same user
    // could insert an unread row between the update and this read.
    const unreadCount = await notificationsRepo.unreadCount(userId);
    emitNotificationUnreadCount(userId, unreadCount);
    return unreadCount;
  },
};
