import {
  codenamesController, codenamesGuestSessionRequired, dayQuerySchema, flipSchema, reviewQuerySchema, startSchema, stopSchema,
} from '../../modules/codenames/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Football Codenames daily board. A run is a start and at most 20 flips and 3 stops, well inside the guest budgets. */
export const codenamesRoutes = createDailyGameRouter({
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
