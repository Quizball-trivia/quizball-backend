import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /health
 * Health check endpoint.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

export const healthRoutes = router;
