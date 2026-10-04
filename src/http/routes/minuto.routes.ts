import {
  dayQuerySchema, guessSchema, minutoController, minutoGuestSessionRequired, moveSchema, reviewQuerySchema, startSchema,
} from '../../modules/minuto/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** "¿En qué minuto?". A full run is about 21 calls (10 guesses + 10 next + start), well inside the guest budgets. */
export const minutoRoutes = createDailyGameRouter({
  name: 'minuto',
  guestBudget: { address: 3_000, session: 500 },
  guestSessionRequired: minutoGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: minutoController.start,
  moves: [
    { path: 'guess', schema: guessSchema, handler: minutoController.guess },
    { path: 'next', schema: moveSchema, handler: minutoController.next },
  ],
  current: minutoController.current,
  boards: minutoController.boards,
  review: minutoController.review,
  leaderboard: minutoController.leaderboard,
});
