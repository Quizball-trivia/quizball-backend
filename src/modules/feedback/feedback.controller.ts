import type { Request, Response } from 'express';
import { feedbackService } from './feedback.service.js';
import type { SubmitFeedbackBody } from './feedback.schemas.js';

/**
 * Feedback controller. Public endpoint (works logged-out) — `req.user` is only
 * present if an upstream middleware attached it, so it's read defensively.
 */
export const feedbackController = {
  async submit(req: Request, res: Response): Promise<void> {
    const body = req.validated.body as SubmitFeedbackBody;
    await feedbackService.submit(body, {
      userId: req.user?.id ?? null,
      username: req.user?.nickname ?? null,
      email: req.user?.email ?? null,
    });
    res.json({ ok: true });
  },
};
