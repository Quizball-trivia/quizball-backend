import { z } from 'zod';
import { i18nFieldSchema } from '../../http/schemas/shared.js';

/**
 * Notification type discriminator. `data` shape varies by type but is kept as a
 * permissive record so new types don't require schema churn on the read path.
 */
export const notificationTypeSchema = z.enum([
  'points_adjustment',
  'season_award',
  'announcement',
]);

export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationSchema = z.object({
  id: z.string().uuid(),
  type: notificationTypeSchema,
  title: i18nFieldSchema,
  body: i18nFieldSchema.nullable(),
  data: z.record(z.unknown()),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type Notification = z.infer<typeof notificationSchema>;

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  before: z.string().datetime().optional(),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const listNotificationsResponseSchema = z.object({
  items: z.array(notificationSchema),
  unreadCount: z.number().int().nonnegative(),
});

export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>;

export const unreadCountResponseSchema = z.object({
  unreadCount: z.number().int().nonnegative(),
});

export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

export const notificationIdParamSchema = z.object({
  notificationId: z.string().uuid(),
});

export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;
