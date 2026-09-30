import {
  dayQuerySchema, guessSchema, moveSchema, pistasController, pistasGuestSessionRequired, reviewQuerySchema, startSchema,
} from '../../modules/pistas/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/**
 * Pistas futboleras. A full run is at most ~130 calls (10 rounds × 9 reveals + 2 guesses + next), which the
 * hourly guest budgets (the same as Buscaminas') cover several times over.
 */
export const pistasRoutes = createDailyGameRouter({
  name: 'pistas',
  guestBudget: { address: 9_000, session: 1_500 },
  guestSessionRequired: pistasGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: pistasController.start,
  moves: [
    { path: 'reveal', schema: moveSchema, handler: pistasController.reveal },
    { path: 'guess', schema: guessSchema, handler: pistasController.guess },
    { path: 'giveup', schema: moveSchema, handler: pistasController.giveUp },
    { path: 'next', schema: moveSchema, handler: pistasController.next },
  ],
  current: pistasController.current,
  boards: pistasController.boards,
  review: pistasController.review,
  leaderboard: pistasController.leaderboard,
});
