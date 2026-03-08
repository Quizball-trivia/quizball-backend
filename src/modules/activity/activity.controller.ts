import type { Request, Response } from 'express';
import { AuthorizationError } from '../../core/errors.js';
import { activityService } from './activity.service.js';
import type {
  ActivityQuery,
  ActivityByCategoryQuery,
  RecentActivityQuery,
} from './activity.schemas.js';

const ALLOWED_EMAILS = ['bighead@quizball.com'];

function assertBighead(req: Request): void {
  const email = req.user?.email;
  if (!email || !ALLOWED_EMAILS.includes(email)) {
    throw new AuthorizationError('Access denied');
  }
}

export const activityController = {
  async getActivity(req: Request, res: Response): Promise<void> {
    assertBighead(req);
    const { from, to, user_id } = req.validated.query as ActivityQuery;
    const result = await activityService.getActivity(user_id, from, to);
    res.json(result);
  },

  async getUsers(req: Request, res: Response): Promise<void> {
    assertBighead(req);
    const users = await activityService.getAdminUsers();
    res.json({ users });
  },

  async getByCategory(req: Request, res: Response): Promise<void> {
    assertBighead(req);
    const { user_id } = req.validated.query as ActivityByCategoryQuery;
    const breakdown = await activityService.getCategoryBreakdown(user_id);
    res.json({ categories: breakdown });
  },

  async getRecent(req: Request, res: Response): Promise<void> {
    assertBighead(req);
    const { user_id, limit } = req.validated.query as RecentActivityQuery;
    const items = await activityService.getRecentActivity(user_id, limit);
    res.json({ items });
  },
};
