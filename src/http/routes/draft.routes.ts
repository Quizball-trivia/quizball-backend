import { Router } from 'express';
import { guestSessionRequired } from '../../modules/daily/daily.errors.js';
import { academySchema, boardTieSchema, challengeCreateSchema, challengeParamsSchema, dailyController, draftPlayController, freeStartSchema, pickSchema, respinSchema, runQuerySchema, teamQuerySchema } from '../../modules/draft/draft.controller.js';
import { dayQuerySchema, moveSchema, reviewQuerySchema, startSchema } from '../../modules/wordgame-daily/wordgame-daily.shared.js';
import { validate } from '../middleware/validate.js';
import { createDailyGameRouter } from './daily-game.router.js';

const GUEST_BUDGET = { address: 6_000, session: 600 };

const dailyRouter = (variant: 'budget' | 'classic' | 'knowledge') => {
  const c = dailyController(variant);
  return createDailyGameRouter({
    name: 'football-draft',
    guestBudget: GUEST_BUDGET,
    guestSessionRequired,
    schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
    start: c.start,
    moves: [
      { path: 'spin', schema: moveSchema, handler: c.spin },
      { path: 'pick', schema: pickSchema, handler: c.pick },
      { path: 'academy', schema: academySchema, handler: c.academy },
      { path: 'respin', schema: respinSchema, handler: c.respin },
      { path: 'undo', schema: moveSchema, handler: c.undo },
      { path: 'finish', schema: moveSchema, handler: c.finish },
    ],
    current: c.current,
    boards: c.boards,
    review: c.review,
    leaderboard: c.leaderboard,
    extra: (router, { identify, limiter }) => {
      router.get('/team', identify, limiter(60), validate({ query: teamQuerySchema }), c.team);
      router.post('/tie', identify, limiter(30), validate({ body: boardTieSchema }), c.tie);
    },
  });
};

/** Free play, challenges and saved ties: same identity and budgets as the dailies, mounted on a router with no day of its own. */
const playRouter = (): Router => {
  const c = draftPlayController;
  const noDaily = dailyController('budget');
  return createDailyGameRouter({
    name: 'football-draft',
    guestBudget: GUEST_BUDGET,
    guestSessionRequired,
    schemas: { start: startSchema, dayQuery: dayQuerySchema, reviewQuery: reviewQuerySchema },
    start: c.freeStart,
    moves: [],
    current: c.freeCurrent,
    boards: noDaily.review,
    review: noDaily.review,
    leaderboard: noDaily.review,
    extra: (router, { identify, limiter }) => {
      router.post('/free', identify, limiter(30), validate({ body: freeStartSchema }), c.freeStart);
      router.get('/free', identify, limiter(60), validate({ query: runQuerySchema }), c.freeCurrent);
      router.post('/free/spin', identify, limiter(240), validate({ body: moveSchema }), c.freeSpin);
      router.post('/free/pick', identify, limiter(240), validate({ body: pickSchema }), c.freePick);
      router.post('/free/academy', identify, limiter(240), validate({ body: academySchema }), c.freeAcademy);
      router.post('/free/respin', identify, limiter(240), validate({ body: respinSchema }), c.freeRespin);
      router.post('/free/undo', identify, limiter(240), validate({ body: moveSchema }), c.freeUndo);
      router.post('/free/finish', identify, limiter(60), validate({ body: moveSchema }), c.freeFinish);
      router.post('/challenges', identify, limiter(20), validate({ body: challengeCreateSchema }), c.challengeCreate);
      router.get('/challenges/:code', identify, limiter(60), validate({ params: challengeParamsSchema }), c.challengeRead);
      router.post('/challenges/:code/accept', identify, limiter(20), validate({ params: challengeParamsSchema }), c.challengeAccept);
      router.post('/challenges/:code/tie', identify, limiter(30), validate({ params: challengeParamsSchema }), c.challengeTie);
      router.get('/ties', identify, limiter(60), c.myTies);
    },
  });
};

export const draftRoutes = Router();
draftRoutes.use('/budget', dailyRouter('budget'));
draftRoutes.use('/classic', dailyRouter('classic'));
draftRoutes.use('/knowledge', dailyRouter('knowledge'));
draftRoutes.use('/play', playRouter());
