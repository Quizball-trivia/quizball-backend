import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { sharedPlayerDailyController } from '../../modules/shared-player-daily/shared-player-daily.controller.js';
import { answerSchema, dayQuerySchema, moveSchema, pairReportSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';

/**
 * "Played for both", the solo daily. A run is ten pairs: ten `next`, and an answer or a few per pair (a wrong one
 * blocks the input for a second); guests play closed days only.
 */
export const sharedPlayerDailyRoutes = createDailyGameRouter({
  name: 'shared-player',
  guestBudget: { address: 6_000, session: 1_000 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: sharedPlayerDailyController.start,
  moves: [
    { path: 'next', schema: moveSchema, handler: sharedPlayerDailyController.next },
    { path: 'answer', schema: answerSchema, handler: sharedPlayerDailyController.answer },
  ],
  report: { schema: pairReportSchema, handler: sharedPlayerDailyController.report },
  current: sharedPlayerDailyController.current,
  boards: sharedPlayerDailyController.boards,
  review: sharedPlayerDailyController.review,
  leaderboard: sharedPlayerDailyController.leaderboard,
});
