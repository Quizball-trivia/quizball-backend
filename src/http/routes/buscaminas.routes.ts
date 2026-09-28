import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { guestHttpBudget, requireGuestHttpEnabled } from '../middleware/guest-http-budget.js';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { bucketIp } from '../../core/ip-bucket.js';
import { AuthenticationError } from '../../core/errors.js';
import { guestAuthMiddleware } from '../../modules/guest/guest.middleware.js';
import { GUEST_TOKEN_HEADER, GUEST_TOKEN_SHAPE } from '../../modules/guest/guest.service.js';
import { boardParamsSchema, buscaminasController, buscaminasGuestSessionRequired, dayQuerySchema, moveSchema, startSchema, tapSchema } from '../../modules/buscaminas/index.js';

/** Buscaminas futbolero — every run is a server row owned by a member or by a guest session. */
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

// Shared (Redis) hourly guest budgets, like the other guest routes. A full run is up to ~280 calls.
// The address budget runs before the session lookup, so rotating fake tokens costs a counter, not a
// query; it leaves room for one full run by each of the 30 guest sessions an address may mint an hour.
const guestPlay = inSequence([
  requireGuestHttpEnabled,
  guestHttpBudget('buscaminas-address', 9_000, (req) => bucketIp(resolveTrustedClientIp(req))),
  requireGuestTokenShape,
  guestAuthMiddleware,
  guestHttpBudget('buscaminas', 1_500, (req) => req.guest?.id ?? bucketIp(resolveTrustedClientIp(req))),
]);

/**
 * Who is playing: a member (bearer or session cookie), else the guest session in `x-guest-token`.
 * A bad bearer is a 401, never a silent guest run; a stale cookie still falls back to the guest session.
 */
const identify: RequestHandler = (req, res, next) => {
  if (req.headers.authorization) return void authMiddleware(req, res, next);
  void optionalAuthMiddleware(req, res, (error?: unknown) => {
    if (error) return next(error);
    if (req.user) return next();
    if (req.headers[GUEST_TOKEN_HEADER] === undefined) return next(buscaminasGuestSessionRequired());
    guestPlay(req, res, next);
  });
};

// Per-process burst limits (the codebase has no shared express-rate-limit store), keyed by the verified player.
const limiter = (max: number): RequestHandler => rateLimit({
  windowMs: 60_000,
  max,
  keyGenerator: (req) => (req.user ? `u:${req.user.id}` : req.guest ? `g:${req.guest.id}` : `ip:${req.ip}`),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});
// A full run is ~20 rounds × up to 13 taps plus bank/next; a fast player taps about twice a second.
const playLimiter = limiter(240);
const startLimiter = limiter(30);
const readLimiter = limiter(60);
// Boards are fetched without identity, so this one is per address.
const boardLimiter = limiter(120);

const varyOnAuth: RequestHandler = (_req, res, next) => {
  res.vary('Authorization');
  res.vary('Cookie');
  next();
};

const varyOnPlayer: RequestHandler = (req, res, next) => {
  res.vary(GUEST_TOKEN_HEADER);
  varyOnAuth(req, res, next);
};

// The same bytes for every caller (no identity read). Until the controller marks a success cacheable,
// a response (a 404 for a day that opens at midnight) must not be stored.
const publicBoard: RequestHandler = (_req, res, next) => {
  res.vary('Origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

router.post('/start', identify, startLimiter, validate({ body: startSchema }), buscaminasController.start);
router.post('/tap', identify, playLimiter, validate({ body: tapSchema }), buscaminasController.tap);
router.post('/bank', identify, playLimiter, validate({ body: moveSchema }), buscaminasController.bank);
router.post('/next', identify, playLimiter, validate({ body: moveSchema }), buscaminasController.next);
router.get('/current', varyOnPlayer, identify, readLimiter, validate({ query: dayQuerySchema }), buscaminasController.current);
router.get('/boards', publicBoard, boardLimiter, buscaminasController.boards);
router.get('/boards/:day', publicBoard, boardLimiter, validate({ params: boardParamsSchema }), buscaminasController.board);
router.get('/leaderboard', varyOnAuth, optionalAuthMiddleware, readLimiter, validate({ query: dayQuerySchema }), buscaminasController.leaderboard);

export { router as buscaminasRoutes };
