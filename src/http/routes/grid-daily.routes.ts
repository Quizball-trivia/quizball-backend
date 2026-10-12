import {
  dayQuerySchema, gridDailyController, gridDailyGuestSessionRequired, guessSchema, moveSchema, reviewQuerySchema, startSchema,
} from '../../modules/grid-daily/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Daily grid. A full run is at most a dozen calls (a start, a kick-off, 9 guesses, a finish), well inside the guest budgets. */
export const gridDailyRoutes = createDailyGameRouter({
  name: 'grid-daily',
  guestBudget: { address: 3_000, session: 500 },
  guestSessionRequired: gridDailyGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: gridDailyController.start,
  moves: [
    { path: 'kickoff', schema: moveSchema, handler: gridDailyController.kickOff },
    { path: 'guess', schema: guessSchema, handler: gridDailyController.guess },
    { path: 'finish', schema: moveSchema, handler: gridDailyController.finish },
  ],
  current: gridDailyController.current,
  boards: gridDailyController.boards,
  review: gridDailyController.review,
  leaderboard: gridDailyController.leaderboard,
});
