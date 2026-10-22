import {
  codenamesController, codenamesGuestSessionRequired, dayQuerySchema, flipSchema, reviewQuerySchema, startSchema, stopSchema,
} from '../../modules/codenames/index.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { bucketIp } from '../../core/ip-bucket.js';
import { codenamesWordsController, practiceQuerySchema } from '../../modules/codenames/codenames.words.js';
import { resolveTrustedClientIp } from '../client-ip.js';
import { guestHttpBudget, requireGuestHttpEnabled } from '../middleware/guest-http-budget.js';
import { validate } from '../middleware/validate.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Football Codenames daily board. A run is a start and at most 20 flips and 3 stops, well inside the guest budgets. */
const daily = createDailyGameRouter({
  name: 'codenames',
  guestBudget: { address: 3_000, session: 500 },
  guestSessionRequired: codenamesGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: codenamesController.start,
  moves: [
    { path: 'flip', schema: flipSchema, handler: codenamesController.flip },
    { path: 'stop', schema: stopSchema, handler: codenamesController.stop },
  ],
  current: codenamesController.current,
  boards: codenamesController.boards,
  review: codenamesController.review,
  leaderboard: codenamesController.leaderboard,
});

// Solo word boards: unranked practice, no account and no run row (the board is played on the device).
const practiceLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyGenerator: (req) => bucketIp(resolveTrustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null },
});

export const codenamesRoutes = Router();
// Hourly per address (shared across replicas, in Redis) on top of the per-process burst limit: a board costs a deal.
const practiceBudget = guestHttpBudget('codenames-words-address', 600, (req) => bucketIp(resolveTrustedClientIp(req)));
codenamesRoutes.get('/words/practice', requireGuestHttpEnabled, practiceLimiter, practiceBudget, validate({ query: practiceQuerySchema }), codenamesWordsController.practice);
codenamesRoutes.use(daily);
