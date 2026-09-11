import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { AuthenticationError } from '../../core/errors.js';
import { GUEST_TOKEN_HEADER, GUEST_TOKEN_SHAPE, createGuestSessionSchema, guestAuthMiddleware, guestController } from '../../modules/guest/index.js';
import { completeDailyChallengeBodySchema, dailyChallengeLocaleQuerySchema, dailyChallengeParamSchema, passChainLinkBodySchema } from '../../modules/daily-challenges/index.js';
import { publicStandingsService } from '../../modules/public/public-standings.service.js';

/**
 * Public play without an account. Budgets, in order: an aggregate per-address
 * budget on every guest call (before any lookup), then authentication, then a
 * per-guest budget keyed by the VERIFIED guest id. IPv6 is bucketed by /64 so
 * one host cannot rotate through a subnet. Counters are per process
 * (express-rate-limit MemoryStore); the global API limiter still applies.
 */
export function ipBucket(req: Request): string {
  const ip = resolveTrustedClientIp(req) ?? 'unknown';
  return ip.includes(':') ? ipv6Prefix64(ip) : ip;
}

/** First four hextets of an expanded IPv6 address, so `2001:db8::1` and `2001:db8::2` share a bucket. */
export function ipv6Prefix64(ip: string): string {
  // Embedded IPv4 tail (::ffff:192.0.2.1 style) counts as two hextets.
  const dotted = ip.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    ip = ip.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail = ''] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(ip.includes('::') ? missing : 0).fill('0'), ...right];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0').toLowerCase()).join(':');
}
const hour = 60 * 60 * 1000;
const limiter = (limit: number, keyGenerator: (req: Request) => string) => rateLimit({ windowMs: hour, limit, standardHeaders: true, legacyHeaders: false, keyGenerator });
const mintLimiter = limiter(30, ipBucket);
const standingsLimiter = limiter(300, ipBucket);
const guestIpLimiter = limiter(600, ipBucket);
const guestTokenLimiter = limiter(240, (req) => req.guest?.id ?? ipBucket(req));

/** Cheap shape check before any database work; malformed headers never reach a lookup. */
function requireTokenShape(req: Request, _res: unknown, next: (error?: unknown) => void): void {
  const raw = req.headers[GUEST_TOKEN_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  next(token && GUEST_TOKEN_SHAPE.test(token) ? undefined : new AuthenticationError('Missing guest token'));
}

const router = Router();
router.post('/session', mintLimiter, validate({ body: createGuestSessionSchema }), guestController.createSession);
router.get('/standings', standingsLimiter, async (_req, res) => { res.json(await publicStandingsService.get()); });

const daily = Router();
daily.use(guestIpLimiter, requireTokenShape, guestAuthMiddleware, guestTokenLimiter);
daily.get('/stat-sniper/leaderboard', guestController.statSniperLeaderboard);
daily.post('/pass-chain/link', validate({ body: passChainLinkBodySchema }), guestController.passChainLink);
daily.post('/:challengeType/session', validate({ params: dailyChallengeParamSchema, query: dailyChallengeLocaleQuerySchema }), guestController.createDailySession);
daily.post('/:challengeType/complete', validate({ params: dailyChallengeParamSchema, body: completeDailyChallengeBodySchema }), guestController.completeDaily);
router.use('/daily-challenges', daily);

export { router as guestRoutes };
