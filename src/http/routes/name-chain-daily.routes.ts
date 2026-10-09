import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { nameChainDailyController } from '../../modules/name-chain-daily/name-chain-daily.controller.js';
import { answerSchema, dayQuerySchema, moveSchema, nameReportSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';

/**
 * The footballer name chain, the solo daily. A long run is ~150 calls (three chains of up to thirty names, plus the
 * misses); guests play closed days only.
 */
export const nameChainDailyRoutes = createDailyGameRouter({
  name: 'name-chain',
  guestBudget: { address: 12_000, session: 2_000 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: nameChainDailyController.start,
  moves: [
    { path: 'next', schema: moveSchema, handler: nameChainDailyController.next },
    { path: 'answer', schema: answerSchema, handler: nameChainDailyController.answer },
    { path: 'pass', schema: moveSchema, handler: nameChainDailyController.pass },
  ],
  report: { schema: nameReportSchema, handler: nameChainDailyController.report },
  current: nameChainDailyController.current,
  boards: nameChainDailyController.boards,
  review: nameChainDailyController.review,
  leaderboard: nameChainDailyController.leaderboard,
});
