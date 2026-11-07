import 'express-async-errors';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { errorHandler, requestIdMiddleware } from '../../src/http/middleware/index.js';
import '../setup.js';

const stubs = vi.hoisted(() => ({ today: vi.fn(), freeStart: vi.fn(), freeCurrent: vi.fn() }));

vi.mock('../../src/http/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../../src/http/middleware/auth.js')>()),
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    req.user = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', role: 'player' } as Request['user'];
    next();
  },
  // A stale session cookie: the real middleware ignores it and carries on with no user.
  optionalAuthMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../src/modules/draft/draft.controller.js', async (original) => {
  const actual = await original<typeof import('../../src/modules/draft/draft.controller.js')>();
  const send = (stub: (req: Request) => void) => async (req: Request, res: Response) => { stub(req); res.json({ ok: true }); };
  return {
    ...actual,
    dailyController: (variant: 'budget' | 'classic' | 'knowledge') => ({ ...actual.dailyController(variant), today: send(stubs.today) }),
    draftPlayController: { ...actual.draftPlayController, freeStart: send(stubs.freeStart), freeCurrent: send(stubs.freeCurrent) },
  };
});

import { draftRoutes } from '../../src/http/routes/draft.routes.js';
import { draftPackSchema } from '../../src/modules/draft/draft.universe.js';
import { inventedPack } from './draft.fixture.js';

describe('draft routes', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use((req, _res, next) => { req.cookies = { qb_access_token: 'stale' }; next(); });
    app.use('/api/v1/draft', draftRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => vi.clearAllMocks());

  it('a stale cookie still reads today, with no identity', async () => {
    const response = await request(app).get('/api/v1/draft/budget/today');
    expect(response.status).toBe(200);
    expect(stubs.today).toHaveBeenCalledOnce();
    expect(stubs.today.mock.calls[0][0].user).toBeUndefined();
  });

  it('free play has no daily /current or /start: they are 404, and /free still works', async () => {
    const bearer = { Authorization: 'Bearer test' };
    expect((await request(app).get('/api/v1/draft/play/current').set(bearer)).status).toBe(404);
    expect((await request(app).post('/api/v1/draft/play/start').set(bearer).send({ day: '2026-11-08' })).status).toBe(404);
    expect(stubs.freeCurrent).not.toHaveBeenCalled();
    expect(stubs.freeStart).not.toHaveBeenCalled();
    const runId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect((await request(app).get(`/api/v1/draft/play/free?runId=${runId}`).set(bearer)).status).toBe(200);
    expect(stubs.freeCurrent).toHaveBeenCalledOnce();
  });
});

describe('the squad pack', () => {
  it('accepts every role we rate, and refuses one we do not', () => {
    const pack = inventedPack();
    expect(draftPackSchema.safeParse(pack).success).toBe(true);
    const row = [...pack.clubs[0].players[0]] as unknown[];
    row[10] = 'CAM';
    const bad = { ...pack, clubs: [{ ...pack.clubs[0], players: [row, ...pack.clubs[0].players.slice(1)] }, ...pack.clubs.slice(1)] };
    expect(draftPackSchema.safeParse(bad).success).toBe(false);
  });
});
