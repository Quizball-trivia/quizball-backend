import {
  answerSchema, dayQuerySchema, moveSchema, reviewQuerySchema, startSchema, ultimoController, ultimoGuestSessionRequired,
} from '../../modules/ultimo/index.js';
import { createDailyGameRouter } from './daily-game.router.js';

/**
 * Último en pie futbolero. A long run is ~250 calls (5 categories × begin, up to ~45 answers and misses, next);
 * guests play closed days only.
 */
export const ultimoRoutes = createDailyGameRouter({
  name: 'ultimo',
  guestBudget: { address: 12_000, session: 2_000 },
  guestSessionRequired: ultimoGuestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: ultimoController.start,
  moves: [
    { path: 'begin', schema: moveSchema, handler: ultimoController.begin },
    { path: 'answer', schema: answerSchema, handler: ultimoController.answer },
    { path: 'next', schema: moveSchema, handler: ultimoController.next },
  ],
  current: ultimoController.current,
  boards: ultimoController.boards,
  review: ultimoController.review,
  leaderboard: ultimoController.leaderboard,
});
