import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { service } = vi.hoisted(() => ({
  service: {
    start: vi.fn(async (day: string, userId: string | null, _contentVersion?: number, _client?: string) => ({ token: 't', state: { day, ranked: userId !== null } })),
    leaderboard: vi.fn(async () => ({ day: '2026-09-27', players: 0, top: [], me: null })),
    current: vi.fn(async () => ({ run: null })),
    board: vi.fn(async (day: string) => ({ board: { day, number: 2, contentVersion: 7, rounds: [] }, live: false })),
    boards: vi.fn(async () => ({ days: { '2026-09-26': 5, '2026-09-27': 7 } })),
  },
}));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...original, config: { ...original.config, BUSCAMINAS_ENABLED: true, BUSCAMINAS_TOKEN_SECRET: 'k'.repeat(64) } };
});
vi.mock('../../src/modules/buscaminas/buscaminas.service.js', () => ({ buscaminasService: service, createBuscaminasService: vi.fn(), startBuscaminasReadinessCheck: vi.fn() }));
vi.mock('../../src/http/middleware/auth.js', async () => {
  const { AuthenticationError } = await import('../../src/core/errors.js');
  const resolve = (req: express.Request) => (req.headers.authorization === 'Bearer good' ? { id: 'user-a' } : null);
  return {
    authMiddleware: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const user = resolve(req);
      if (!user) return next(new AuthenticationError('Invalid token'));
      req.user = user as never;
      next();
    },
    optionalAuthMiddleware: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const user = resolve(req);
      if (user) req.user = user as never;
      next();
    },
  };
});

import { buscaminasRoutes } from '../../src/http/routes/buscaminas.routes.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';

const app = express();
app.use(express.json());
app.use('/api/v1/buscaminas', buscaminasRoutes);
app.use(errorHandler);

describe('buscaminas routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('start: no header plays as a guest, a valid bearer is ranked, a bad bearer is 401 (never a silent guest run)', async () => {
    expect((await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27' })).body.state.ranked).toBe(false);
    expect((await request(app).post('/api/v1/buscaminas/start').set('authorization', 'Bearer good').send({ day: '2026-09-27' })).body.state.ranked).toBe(true);
    const bad = await request(app).post('/api/v1/buscaminas/start').set('authorization', 'Bearer expired').send({ day: '2026-09-27' });
    expect(bad.status).toBe(401);
    expect(service.start).toHaveBeenCalledTimes(2);
  });

  it('start: a guest refused the live day gets 403 with code sign_in_for_today', async () => {
    const { signInForToday } = await import('../../src/modules/buscaminas/buscaminas.errors.js');
    service.start.mockRejectedValueOnce(signInForToday());
    const res = await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'sign_in_for_today', details: { reason: 'sign_in_for_today' } });
  });

  it('start passes the caller\'s address bucket for the live-day run cap', async () => {
    await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27' });
    const client = service.start.mock.calls.at(-1)?.[3];
    expect(client).toMatch(/^(127\.0\.0\.1|0000:0000:0000:0000)$/);
  });

  it('start validates contentVersion as a positive integer up to 2^32', async () => {
    expect((await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27', contentVersion: 2 ** 32 })).status).toBe(200);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', null, 2 ** 32, expect.any(String));
    expect((await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27', contentVersion: 2 ** 32 + 1 })).status).toBe(422);
    expect((await request(app).post('/api/v1/buscaminas/start').send({ day: '2026-09-27', contentVersion: 1.5 })).status).toBe(422);
  });

  it('leaderboard varies on auth and is only publicly cacheable for anonymous callers', async () => {
    const anon = await request(app).get('/api/v1/buscaminas/leaderboard');
    expect(anon.headers['cache-control']).toBe('public, max-age=15');
    expect(anon.headers.vary).toMatch(/Authorization/);
    expect(anon.headers.vary).toMatch(/Cookie/);
    const authed = await request(app).get('/api/v1/buscaminas/leaderboard').set('authorization', 'Bearer good');
    expect(authed.headers['cache-control']).toBe('private, no-store');
    expect(service.leaderboard).toHaveBeenLastCalledWith(undefined, 'user-a');
  });

  it('rate limits leaderboard reads per caller', async () => {
    let last = 200;
    for (let i = 0; i < 61; i += 1) last = (await request(app).get('/api/v1/buscaminas/leaderboard').set('authorization', 'Bearer good')).status;
    expect(last).toBe(429);
  });

  it('boards/:day: a finished day is cacheable for a day, the live day for five minutes, both varying on Origin', async () => {
    const past = await request(app).get('/api/v1/buscaminas/boards/2026-09-27');
    expect(past.status).toBe(200);
    expect(past.body).toEqual({ day: '2026-09-27', number: 2, contentVersion: 7, rounds: [] });
    expect(past.headers['cache-control']).toBe('public, max-age=86400');
    expect(past.headers.vary).toMatch(/Origin/);
    expect(past.headers.vary ?? '').not.toMatch(/Authorization|Cookie/);
    expect(service.board).toHaveBeenLastCalledWith('2026-09-27');

    service.board.mockResolvedValueOnce({ board: { day: '2026-09-28', number: 3, contentVersion: 8, rounds: [] }, live: true });
    const live = await request(app).get('/api/v1/buscaminas/boards/2026-09-28').set('authorization', 'Bearer good');
    expect(live.status).toBe(200);
    expect(live.headers['cache-control']).toBe('public, max-age=300');
  });

  it('boards/:day: a day that is not playable is a 404 that is never stored; a malformed day is 422', async () => {
    const { NotFoundError } = await import('../../src/core/errors.js');
    service.board.mockRejectedValueOnce(new NotFoundError('Day not available'));
    const missing = await request(app).get('/api/v1/buscaminas/boards/2026-09-29');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'NOT_FOUND', message: 'Day not available' });
    expect(missing.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/v1/buscaminas/boards/tomorrow')).status).toBe(422);
    expect(service.board).toHaveBeenCalledTimes(1);
  });

  it('boards index is public for five minutes', async () => {
    const res = await request(app).get('/api/v1/buscaminas/boards');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ days: { '2026-09-26': 5, '2026-09-27': 7 } });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it('rate limits board reads to 120 a minute per address, shared by the index and the boards', async () => {
    const first = await request(app).get('/api/v1/buscaminas/boards');
    expect(first.headers['ratelimit-limit']).toBe('120');
    const left = Number(first.headers['ratelimit-remaining']);
    const statuses: number[] = [];
    for (let i = 0; i <= left; i += 1) statuses.push((await request(app).get(i % 2 ? '/api/v1/buscaminas/boards' : '/api/v1/buscaminas/boards/2026-09-27')).status);
    expect(statuses.slice(0, left).every((s) => s === 200)).toBe(true);
    const limited = await request(app).get('/api/v1/buscaminas/boards/2026-09-27');
    expect(statuses.at(-1)).toBe(429);
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });
});
