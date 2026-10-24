import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { sayRequestSchema, tenableDailyController } from '../../modules/tenable-daily/tenable-daily.controller.js';
import { dayQuerySchema, moveSchema, nameReportSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { suggest } from '../../modules/tenable/tenable.suggest.js';
import { submitGameFeedback } from '../../modules/game-feedback/game-feedback.controller.js';
import { gameFeedbackSchema } from '../../modules/game-feedback/game-feedback.schemas.js';

/** Football Tenable, the solo daily. A long run is ~40 calls (ten finds, the misses and free retries); guests play closed days only. */
export const tenableDailyRoutes = createDailyGameRouter({
  name: 'tenable',
  guestBudget: { address: 6_000, session: 600 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: tenableDailyController.start,
  moves: [
    // The word-game daily client's names: an answer (typed, or a picked suggestion), and giving up ("pass").
    { path: 'answer', schema: sayRequestSchema, handler: tenableDailyController.say },
    { path: 'pass', schema: moveSchema, handler: tenableDailyController.giveUp },
  ],
  report: { schema: nameReportSchema, handler: tenableDailyController.report },
  feedback: { schema: gameFeedbackSchema, handler: submitGameFeedback('tenable') },
  current: tenableDailyController.current,
  boards: tenableDailyController.boards,
  review: tenableDailyController.review,
  leaderboard: tenableDailyController.leaderboard,
});

const suggestQuerySchema = z.object({
  kind: z.string().min(1).max(16),
  release: z.string().min(3).max(40),
  q: z.string().min(2).max(40),
  locale: z.string().max(8).optional(),
});

/**
 * GET /api/v1/tenable/suggest: names for the answer box, for members and guests alike (rooms are open to guests). The
 * answer depends only on (kind, release, q, locale), so it is cached publicly; a per-address burst limit bounds the work.
 */
tenableDailyRoutes.get(
  '/suggest',
  rateLimit({ windowMs: 10_000, max: 40, standardHeaders: true, legacyHeaders: false, message: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests, please try again later', details: null, request_id: null } }),
  validate({ query: suggestQuerySchema }),
  async (req, res, next) => {
    try {
      const { kind, release, q, locale } = req.validated.query as z.infer<typeof suggestQuerySchema>;
      const items = await suggest(kind, release, q, locale);
      // An empty answer may only mean "not seeded here yet": it is kept briefly.
      res.setHeader('Cache-Control', `public, max-age=${items.length > 0 ? 3600 : 60}`);
      res.json({ items });
    } catch (error) {
      next(error);
    }
  },
);
