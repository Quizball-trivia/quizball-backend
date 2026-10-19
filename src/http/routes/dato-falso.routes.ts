import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { datoFalsoController, jokerSchema, pickSchema } from '../../modules/dato-falso/index.js';
import { dayQuerySchema, moveSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Dato falso futbolero, the solo daily. A run is ten cards: ten `next`, one pick each and at most two jokers; guests play closed days only. */
export const datoFalsoRoutes = createDailyGameRouter({
  name: 'dato-falso',
  guestBudget: { address: 6_000, session: 1_000 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: datoFalsoController.start,
  moves: [
    { path: 'next', schema: moveSchema, handler: datoFalsoController.next },
    { path: 'joker', schema: jokerSchema, handler: datoFalsoController.joker },
    { path: 'pick', schema: pickSchema, handler: datoFalsoController.pick },
  ],
  current: datoFalsoController.current,
  boards: datoFalsoController.boards,
  review: datoFalsoController.review,
  leaderboard: datoFalsoController.leaderboard,
});
