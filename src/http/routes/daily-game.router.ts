import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import type { ZodTypeAny } from 'zod';
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
import { guestHttpBudget, requireGuestHttpEnabled } from '../middleware/guest-http-budget.js';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { bucketIp } from '../../core/ip-bucket.js';
import { AuthenticationError, type AppError } from '../../core/errors.js';
import { guestAuthMiddleware } from '../../modules/guest/guest.middleware.js';
import { GUEST_TOKEN_HEADER, GUEST_TOKEN_SHAPE } from '../../modules/guest/guest.service.js';

type Handler = RequestHandler;

export interface DailyGameRoutes {
  /** Budget names prefix the shared Redis counters (`<name>-address`, `<name>`). */
  name: 'pistas' | 'ultimo' | 'minuto' | 'shared-player' | 'name-chain';
  /** Hourly guest budgets: per address (before the session lookup) and per guest session. */
  guestBudget: { address: number; session: number };
  guestSessionRequired: () => AppError;
  schemas: { start: ZodTypeAny; dayQuery: ZodTypeAny; reviewQuery: ZodTypeAny };
  start: Handler;
  /** The game's moves: POST /<path> with the body schema. */
  moves: Array<{ path: string; schema: ZodTypeAny; handler: Handler }>;
  /** POST /report: a refused answer the player says was right (rare, so a small budget of its own). */
  report?: { schema: ZodTypeAny; handler: Handler };
  current: Handler;
  boards: Handler;
  review: Handler;
  leaderboard: Handler;
}

const inSequence = (handlers: readonly RequestHandler[]): RequestHandler => (req, res, next) => {
  const step = (i: number) => (error?: unknown) => (error || i === handlers.length ? next(error) : void handlers[i](req, res, step(i + 1)));
  step(0)();
};

const requireGuestTokenShape: RequestHandler = (req, _res, next) => {
  const raw = req.headers[GUEST_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  next(token && GUEST_TOKEN_SHAPE.test(token) ? undefined : new AuthenticationError('Missing guest token'));
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
// a response (a 404 for a day that is not closed yet) must not be stored.
const publicRead: RequestHandler = (_req, res, next) => {
  res.vary('Origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/**
 * The routes every daily game has: every run is a server row owned by a member (bearer or session cookie) or by
 * the guest session in `x-guest-token`. A bad bearer is a 401, never a silent guest run; a stale cookie still falls
 * back to the guest session. Guests pay shared (Redis) hourly budgets; the address budget runs before the session
 * lookup, so rotating fake tokens costs a counter, not a query.
 */
export function createDailyGameRouter(game: DailyGameRoutes): Router {
  const router = Router();

  const guestPlay = inSequence([
    requireGuestHttpEnabled,
    guestHttpBudget(`${game.name}-address`, game.guestBudget.address, (req) => bucketIp(resolveTrustedClientIp(req))),
    requireGuestTokenShape,
    guestAuthMiddleware,
    guestHttpBudget(game.name, game.guestBudget.session, (req) => req.guest?.id ?? bucketIp(resolveTrustedClientIp(req))),
  ]);

  const identify: RequestHandler = (req, res, next) => {
    if (req.headers.authorization) return void authMiddleware(req, res, next);
    void optionalAuthMiddleware(req, res, (error?: unknown) => {
      if (error) return next(error);
      if (req.user) return next();
      if (req.headers[GUEST_TOKEN_HEADER] === undefined) return next(game.guestSessionRequired());
      guestPlay(req, res, next);
    });
  };

  const playLimiter = limiter(240);
  const startLimiter = limiter(30);
  const readLimiter = limiter(60);
  // The boards index and closed-day reviews are fetched without identity, so this one is per address.
  const boardLimiter = limiter(120);

  router.post('/start', identify, startLimiter, validate({ body: game.schemas.start }), game.start);
  for (const move of game.moves) router.post(`/${move.path}`, identify, playLimiter, validate({ body: move.schema }), move.handler);
  if (game.report) router.post('/report', identify, limiter(6), validate({ body: game.report.schema }), game.report.handler);
  router.get('/current', varyOnPlayer, identify, readLimiter, validate({ query: game.schemas.dayQuery }), game.current);
  router.get('/boards', publicRead, boardLimiter, game.boards);
  router.get('/review', publicRead, boardLimiter, validate({ query: game.schemas.reviewQuery }), game.review);
  router.get('/leaderboard', varyOnAuth, optionalAuthMiddleware, readLimiter, validate({ query: game.schemas.dayQuery }), game.leaderboard);
  return router;
}
