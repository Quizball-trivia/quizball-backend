import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { conexionesController, guessSchema, openSchema } from '../../modules/conexiones/index.js';
import { dayQuerySchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { createDailyGameRouter } from './daily-game.router.js';

/** Conexiones futboleras, the solo daily. A run is one `open` and at most seven guesses (repeats are refused); guests play closed days only. */
export const conexionesRoutes = createDailyGameRouter({
  name: 'conexiones',
  guestBudget: { address: 3_000, session: 500 },
  guestSessionRequired,
  schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
  start: conexionesController.start,
  moves: [
    { path: 'open', schema: openSchema, handler: conexionesController.open },
    { path: 'guess', schema: guessSchema, handler: conexionesController.guess },
  ],
  current: conexionesController.current,
  boards: conexionesController.boards,
  review: conexionesController.review,
  leaderboard: conexionesController.leaderboard,
});
