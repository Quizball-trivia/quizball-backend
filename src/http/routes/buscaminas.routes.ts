import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { config } from '../../core/config.js';
import { boardParamsSchema, buscaminasController, buscaminasDisabled, dayQuerySchema, startSchema, tapSchema, tokenBodySchema, usableTokenSecret } from '../../modules/buscaminas/index.js';

/** Buscaminas futbolero — stateless signed runs for guests and past days; today's run for a signed-in user is row-locked and version-gated. */
const router = Router();

const enabled: RequestHandler = (_req, _res, next) => {
  next(config.BUSCAMINAS_ENABLED && usableTokenSecret(config.BUSCAMINAS_TOKEN_SECRET) ? undefined : buscaminasDisabled());
};

// Per-process burst limits (the codebase has no shared express-rate-limit store). Guests cannot open the
// live day by default; when BUSCAMINAS_GUESTS_PLAY_LIVE allows it, their per-address cap is Redis-backed in the service.
const limiter = (max: number): RequestHandler => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});
// A full run is ~20 rounds × up to 13 taps plus bank/next; a fast player taps about twice a second.
const playLimiter = limiter(240);
const startLimiter = limiter(30);
const readLimiter = limiter(60);
// Boards are fetched without auth, so this one is per address.
const boardLimiter = limiter(120);

// A bad bearer on /start must not silently turn a ranked attempt into a guest run; a stale cookie still falls back to guest.
const startAuth: RequestHandler = (req, res, next) =>
  void (req.headers.authorization ? authMiddleware(req, res, next) : optionalAuthMiddleware(req, res, next));

const varyOnAuth: RequestHandler = (_req, res, next) => {
  res.vary('Authorization');
  res.vary('Cookie');
  next();
};

// The same bytes for every caller (no auth read). Until the controller marks a success cacheable,
// a response (a 404 for a day that opens at midnight) must not be stored.
const publicBoard: RequestHandler = (_req, res, next) => {
  res.vary('Origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

router.use(enabled);

router.post('/start', startAuth, startLimiter, validate({ body: startSchema }), buscaminasController.start);
router.post('/tap', optionalAuthMiddleware, playLimiter, validate({ body: tapSchema }), buscaminasController.tap);
router.post('/bank', optionalAuthMiddleware, playLimiter, validate({ body: tokenBodySchema }), buscaminasController.bank);
router.post('/next', optionalAuthMiddleware, playLimiter, validate({ body: tokenBodySchema }), buscaminasController.next);
router.get('/current', varyOnAuth, authMiddleware, readLimiter, validate({ query: dayQuerySchema }), buscaminasController.current);
router.get('/boards', publicBoard, boardLimiter, buscaminasController.boards);
router.get('/boards/:day', publicBoard, boardLimiter, validate({ params: boardParamsSchema }), buscaminasController.board);
router.get('/leaderboard', varyOnAuth, optionalAuthMiddleware, readLimiter, validate({ query: dayQuerySchema }), buscaminasController.leaderboard);

export { router as buscaminasRoutes };
