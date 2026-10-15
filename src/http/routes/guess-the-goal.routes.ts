import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { requireRole } from '../middleware/require-role.js';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { guestHttpBudget, requireGuestHttpEnabled } from '../middleware/guest-http-budget.js';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { bucketIp } from '../../core/ip-bucket.js';
import { AppError, AuthenticationError, ErrorCode } from '../../core/errors.js';
import { guestAuthMiddleware } from '../../modules/guest/guest.middleware.js';
import { GUEST_TOKEN_HEADER, GUEST_TOKEN_SHAPE } from '../../modules/guest/guest.service.js';
import {
  guessTheGoalController,
  startSessionSchema,
  guessSchema,
  bonusSchema,
  sessionIdParamsSchema,
} from '../../modules/guess-the-goal/index.js';

/**
 * Guess the Goal — solo knowledge mini-game, for members and guests (guests earn nothing). Server-authoritative:
 * the correct option never leaves the backend before the guess. Dev routes are member admins only.
 */
const router = Router();

const inSequence = (handlers: readonly RequestHandler[]): RequestHandler => (req, res, next) => {
  const step = (i: number) => (error?: unknown) => (error || i === handlers.length ? next(error) : void handlers[i](req, res, step(i + 1)));
  step(0)();
};

const requireGuestTokenShape: RequestHandler = (req, _res, next) => {
  const raw = req.headers[GUEST_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  next(token && GUEST_TOKEN_SHAPE.test(token) ? undefined : new AuthenticationError('Missing guest token'));
};

// Shared (Redis) hourly guest budgets. A day of five goals is ~40 calls. The address budget runs before the session
// lookup, so rotating fake tokens costs a counter, not a query.
const guestPlay = inSequence([
  requireGuestHttpEnabled,
  guestHttpBudget('ggt-address', 2_000, (req) => bucketIp(resolveTrustedClientIp(req))),
  requireGuestTokenShape,
  guestAuthMiddleware,
  guestHttpBudget('ggt', 200, (req) => req.guest?.id ?? bucketIp(resolveTrustedClientIp(req))),
]);

const guestSessionRequired = (): AppError =>
  new AppError('guest_session_required', 401, ErrorCode.GGT_GUEST_SESSION_REQUIRED, { reason: 'guest_session_required' });

/**
 * Who is playing: a member (bearer or session cookie), else the guest session in `x-guest-token`.
 * A bad bearer is a 401, never a silent guest session; a stale cookie still falls back to the guest session.
 */
const identify: RequestHandler = (req, res, next) => {
  if (req.headers.authorization) return void authMiddleware(req, res, next);
  void optionalAuthMiddleware(req, res, (error?: unknown) => {
    if (error) return next(error);
    if (req.user) return next();
    if (req.headers[GUEST_TOKEN_HEADER] === undefined) return next(guestSessionRequired());
    guestPlay(req, res, next);
  });
};

// Each guest token has its own five goals a day, and a new token is free to mint; this caps how many goals one
// address can start an hour across tokens. It slows rotation, it cannot tell people behind one address apart.
const guestStartBudget: RequestHandler = (req, res, next) => {
  if (!req.guest) return next();
  guestHttpBudget('ggt-start-address', 30, () => bucketIp(resolveTrustedClientIp(req)))(req, res, next);
};

const varyOnPlayer: RequestHandler = (_req, res, next) => {
  res.vary('Authorization');
  res.vary('Cookie');
  res.vary(GUEST_TOKEN_HEADER);
  next();
};

// Per-process burst limits, keyed by the verified player.
const limiter = (max: number): RequestHandler => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.guest ? `g:${req.guest.id}` : `ip:${req.ip}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});
const playLimiter = limiter(60);

router.use(varyOnPlayer);

router.post('/sessions', identify, playLimiter, guestStartBudget, validate({ body: startSessionSchema }), guessTheGoalController.startSession);
router.get('/sessions/current', identify, playLimiter, guessTheGoalController.getCurrent);
router.post(
  '/sessions/:sessionId/guess',
  identify,
  playLimiter,
  validate({ params: sessionIdParamsSchema, body: guessSchema }),
  guessTheGoalController.guess
);
router.post(
  '/sessions/:sessionId/bonus',
  identify,
  playLimiter,
  validate({ params: sessionIdParamsSchema, body: bonusSchema }),
  guessTheGoalController.answerBonus
);
router.get('/stats', identify, playLimiter, guessTheGoalController.stats);
router.delete('/dev/reset-today', authMiddleware, requireRole('admin'), guessTheGoalController.resetTodayDev);
router.get('/dev/all-goals', authMiddleware, requireRole('admin'), guessTheGoalController.allGoalsDev);
router.get('/gallery', identify, playLimiter, guessTheGoalController.gallery);

export { router as guessTheGoalRoutes };
