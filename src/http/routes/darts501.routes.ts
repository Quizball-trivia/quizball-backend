import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { darts501DailyController, throwRequestSchema } from '../../modules/darts501-daily/darts501-daily.controller.js';
import { dayQuerySchema, moveSchema, nameReportSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';

/**
 * Football Darts 501, the solo daily. A run is at most ten darts plus the free answers around them; guests play closed
 * days only. Suggestions come from GET /api/v1/tenable/suggest (the same footballers).
 */
export const darts501Routes = createDailyGameRouter({
  name: 'darts501',
  guestBudget: { address: 6_000, session: 600 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: darts501DailyController.start,
  moves: [
    // The word-game daily client's names: a dart (typed, or a picked suggestion), and giving up ("pass").
    { path: 'answer', schema: throwRequestSchema, handler: darts501DailyController.say },
    { path: 'pass', schema: moveSchema, handler: darts501DailyController.giveUp },
  ],
  report: { schema: nameReportSchema, handler: darts501DailyController.report },
  current: darts501DailyController.current,
  boards: darts501DailyController.boards,
  review: darts501DailyController.review,
  leaderboard: darts501DailyController.leaderboard,
});
