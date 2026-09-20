import { Router, type Request } from 'express';
import { guestHttpBudget, requireGuestHttpEnabled } from '../middleware/guest-http-budget.js';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { bucketIp, ipv6Prefix64 } from '../../core/ip-bucket.js';
import { AuthenticationError } from '../../core/errors.js';
import { GUEST_TOKEN_HEADER, GUEST_TOKEN_SHAPE, createGuestSessionSchema, guestAuthMiddleware, guestController } from '../../modules/guest/index.js';
import { completeDailyChallengeBodySchema, dailyChallengeLocaleQuerySchema, dailyChallengeParamSchema, passChainLinkBodySchema } from '../../modules/daily-challenges/index.js';
import { publicStandingsService } from '../../modules/public/public-standings.service.js';

/**
 * Public play without an account. Budgets, in order: an aggregate per-address
 * budget on every guest call (before any lookup), then authentication, then a
 * per-guest budget keyed by the VERIFIED guest id. IPv6 is bucketed by /64 so
 * one host cannot rotate through a subnet. Redis shares the counters across
 * replicas and restarts; the global API limiter still applies.
 */
export function ipBucket(req: Request): string {
  return bucketIp(resolveTrustedClientIp(req));
}
export { ipv6Prefix64 };
const mintLimiter = guestHttpBudget('mint', 30, ipBucket);
const standingsLimiter = guestHttpBudget('standings', 300, ipBucket);
const guestIpLimiter = guestHttpBudget('ip', 600, ipBucket);
const guestTokenLimiter = guestHttpBudget('principal', 240, (req) => req.guest?.id ?? ipBucket(req));

/** Cheap shape check before any database work; malformed headers never reach a lookup. */
function requireTokenShape(req: Request, _res: unknown, next: (error?: unknown) => void): void {
  const raw = req.headers[GUEST_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  next(token && GUEST_TOKEN_SHAPE.test(token) ? undefined : new AuthenticationError('Missing guest token'));
}

const router = Router();
router.use(requireGuestHttpEnabled);
router.post('/session', mintLimiter, validate({ body: createGuestSessionSchema }), guestController.createSession);
router.get('/standings', standingsLimiter, async (_req, res) => { res.json(await publicStandingsService.get()); });

// Friend lobbies: the principal behind a token (rate-limited like every guest call).
router.post('/principal', guestIpLimiter, requireTokenShape, guestAuthMiddleware, guestTokenLimiter, guestController.principal);
const daily = Router();
daily.use(guestIpLimiter, requireTokenShape, guestAuthMiddleware, guestTokenLimiter);
daily.get('/stat-sniper/leaderboard', guestController.statSniperLeaderboard);
daily.post('/pass-chain/link', validate({ body: passChainLinkBodySchema }), guestController.passChainLink);
daily.post('/:challengeType/session', validate({ params: dailyChallengeParamSchema, query: dailyChallengeLocaleQuerySchema }), guestController.createDailySession);
daily.post('/:challengeType/complete', validate({ params: dailyChallengeParamSchema, body: completeDailyChallengeBodySchema }), guestController.completeDaily);
router.use('/daily-challenges', daily);

export { router as guestRoutes };
