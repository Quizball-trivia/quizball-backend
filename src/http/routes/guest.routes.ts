import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { validate } from '../middleware/validate.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { GUEST_TOKEN_HEADER, createGuestSessionSchema, guestAuthMiddleware, guestController } from '../../modules/guest/index.js';
import { completeDailyChallengeBodySchema, dailyChallengeLocaleQuerySchema, dailyChallengeParamSchema, passChainLinkBodySchema } from '../../modules/daily-challenges/index.js';
import { publicStandingsService } from '../../modules/public/public-standings.service.js';

/**
 * Public play without an account. Session minting is limited per IP; every
 * other guest call is limited per token, so one visitor cannot farm content.
 */
const mintLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => resolveTrustedClientIp(req) ?? 'unknown' });
const guestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => { const raw = req.headers[GUEST_TOKEN_HEADER]; const token = Array.isArray(raw) ? raw[0] : raw; return token ?? resolveTrustedClientIp(req) ?? 'unknown'; },
});

const router = Router();
router.post('/session', mintLimiter, validate({ body: createGuestSessionSchema }), guestController.createSession);
router.get('/standings', mintLimiter, async (_req, res) => { res.json(await publicStandingsService.get()); });

const daily = Router();
daily.use(guestLimiter, guestAuthMiddleware);
daily.get('/stat-sniper/leaderboard', guestController.statSniperLeaderboard);
daily.post('/pass-chain/link', validate({ body: passChainLinkBodySchema }), guestController.passChainLink);
daily.post('/:challengeType/session', validate({ params: dailyChallengeParamSchema, query: dailyChallengeLocaleQuerySchema }), guestController.createDailySession);
daily.post('/:challengeType/complete', validate({ params: dailyChallengeParamSchema, body: completeDailyChallengeBodySchema }), guestController.completeDaily);
router.use('/daily-challenges', daily);

export { router as guestRoutes };
