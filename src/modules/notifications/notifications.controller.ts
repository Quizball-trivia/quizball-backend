import type { Request, Response } from 'express';
import { notificationsService } from './notifications.service.js';
import type { ListNotificationsQuery, NotificationIdParam } from './notifications.schemas.js';

/**
 * Notifications controller. Translates HTTP ↔ service. No business logic.
 * Reads only req.validated.* and the authenticated req.user.
 */
export const notificationsController = {
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListNotificationsQuery;
    const result = await notificationsService.listForUser(req.user!.id, {
      limit: query.limit,
      before: query.before,
      beforeId: query.beforeId,
    });
    res.json(result);
  },

  async unreadCount(req: Request, res: Response): Promise<void> {
    const unreadCount = await notificationsService.unreadCount(req.user!.id);
    res.json({ unreadCount });
  },

  async markRead(req: Request, res: Response): Promise<void> {
    const { notificationId } = req.validated.params as NotificationIdParam;
    const unreadCount = await notificationsService.markRead(req.user!.id, notificationId);
    res.json({ unreadCount });
  },

  async markAllRead(req: Request, res: Response): Promise<void> {
    const unreadCount = await notificationsService.markAllRead(req.user!.id);
    res.json({ unreadCount });
  },
};
