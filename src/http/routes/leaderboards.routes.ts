import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

import { optionalAuthMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { standingsController } from '../../modules/leaderboards/standings.controller.js';
import { standingsQuerySchema } from '../../modules/leaderboards/standings.schemas.js';

const router = Router();

// Per-process burst limit, like the other public boards.
const standingsLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});

// The viewer part depends on who asks, so shared caches must key on identity.
const varyOnAuth: RequestHandler = (_req, res, next) => {
  res.vary('Authorization');
  res.vary('Cookie');
  next();
};

/**
 * GET /api/v1/leaderboards/standings?mode=ranked|auction|ticTacToe&kind=country|club
 * Nations or clubs ranked against each other by the sum of their top 10 real
 * players. Public; a signed-in caller also gets their own group's position.
 */
router.get(
  '/standings',
  varyOnAuth,
  optionalAuthMiddleware,
  standingsLimiter,
  validate({ query: standingsQuerySchema }),
  standingsController.list,
);

export const leaderboardsRoutes = router;
