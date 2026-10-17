import {
  chooseSchema, dayQuerySchema, footballRaceController, footballRaceGuestSessionRequired, pickSchema, reviewQuerySchema, startSchema,
} from '../../modules/football-race/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Football Horserace daily race. A run is a start and a handful of picks (5 to ~15), well inside the guest budgets. */
export const footballRaceRoutes = createDailyGameRouter({
  name: 'football-race',
  guestBudget: { address: 3_000, session: 500 },
  guestSessionRequired: footballRaceGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: footballRaceController.start,
  moves: [
    { path: 'choose', schema: chooseSchema, handler: footballRaceController.choose },
    { path: 'pick', schema: pickSchema, handler: footballRaceController.pick },
  ],
  current: footballRaceController.current,
  boards: footballRaceController.boards,
  review: footballRaceController.review,
  leaderboard: footballRaceController.leaderboard,
});
