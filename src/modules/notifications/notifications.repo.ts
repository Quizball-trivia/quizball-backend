import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type { I18nField } from '../../http/schemas/shared.js';
import type { NotificationType } from './notifications.schemas.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: I18nField;
  body: I18nField | null;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface InsertNotificationParams {
  userId: string;
  type: NotificationType;
  title: I18nField;
  body?: I18nField | null;
  data?: Record<string, unknown>;
}

export const notificationsRepo = {
  async insert(params: InsertNotificationParams): Promise<NotificationRow> {
    const [row] = await sql<NotificationRow[]>`
      INSERT INTO notifications (user_id, type, title, body, data)
      VALUES (
        ${params.userId},
        ${params.type},
        ${sql.json(params.title as unknown as Json)},
        ${params.body ? sql.json(params.body as unknown as Json) : null},
        ${sql.json((params.data ?? {}) as unknown as Json)}
      )
      RETURNING *
    `;
    return row;
  },

  async listForUser(
    userId: string,
    options: { limit: number; before?: string; beforeId?: string }
  ): Promise<NotificationRow[]> {
    // Stable composite cursor (created_at, id): without the id tiebreaker, two
    // rows sharing a created_at could straddle a page boundary and be skipped.
    // `before` keeps the existing timestamp contract; `beforeId` (optional)
    // disambiguates ties when paginating from a known row.
    return sql<NotificationRow[]>`
      SELECT *
      FROM notifications
      WHERE user_id = ${userId}
        ${
          options.before
            ? options.beforeId
              ? sql`AND (created_at, id) < (${options.before}::timestamptz, ${options.beforeId}::uuid)`
              : sql`AND created_at < ${options.before}`
            : sql``
        }
      ORDER BY created_at DESC, id DESC
      LIMIT ${options.limit}
    `;
  },

  async unreadCount(userId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE user_id = ${userId} AND read_at IS NULL
    `;
    return row?.count ?? 0;
  },

  /** Mark a single notification read. Returns true if it belonged to the user and was updated. */
  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const result = await sql`
      UPDATE notifications
      SET read_at = NOW()
      WHERE id = ${notificationId} AND user_id = ${userId} AND read_at IS NULL
    `;
    return result.count > 0;
  },

  /** Mark all of a user's unread notifications read. Returns how many were updated. */
  async markAllRead(userId: string): Promise<number> {
    const result = await sql`
      UPDATE notifications
      SET read_at = NOW()
      WHERE user_id = ${userId} AND read_at IS NULL
    `;
    return result.count;
  },
};
