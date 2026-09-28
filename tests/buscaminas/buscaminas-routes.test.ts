import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const { GUEST_A, GUEST_B } = vi.hoisted(() => ({ GUEST_A: 'a'.repeat(64), GUEST_B: 'b'.repeat(64) }));
const RUN_ID = '0b9f8a3e-9c55-4d8e-9a53-8a1b1f2c3d4e';

const { service, flags } = vi.hoisted(() => ({
  flags: { guestHttp: true },
  service: {
    start: vi.fn(async (day: string, player: { kind: string }) => ({ run: { id: 'r', version: 0 }, state: { day, ranked: player.kind === 'member' } })),
    tap: vi.fn(async () => ({ run: { id: 'r', version: 1 }, state: {}, ok: true })),
    bank: vi.fn(async () => ({ run: { id: 'r', version: 2 }, state: {} })),
    next: vi.fn(async () => ({ run: { id: 'r', version: 3 }, state: {} })),
    current: vi.fn(async () => ({ run: null })),
    leaderboard: vi.fn(async () => ({ day: '2026-09-27', players: 0, top: [], me: null })),
    board: vi.fn(async (day: string) => ({ board: { day, number: 2, contentVersion: 7, rounds: [] }, live: false })),
    boards: vi.fn(async () => ({ days: { '2026-09-26': 5, '2026-09-27': 7 } })),
  },
}));

// Shared guest budgets: an in-memory stand-in for the Redis counter. `exhausted` names budgets already at their limit.
const redis = vi.hoisted(() => ({ open: true, counts: new Map<string, number>(), exhausted: new Set<string>() }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => ({
  get isOpen() { return redis.open; },
  eval: async (_script: string, input: { keys: string[] }) => {
    const key = input.keys[0];
    const name = key.split(':')[2];
    const count = redis.exhausted.has(name) ? Number.MAX_SAFE_INTEGER : (redis.counts.get(key) ?? 0) + 1;
    redis.counts.set(key, count);
    return count;
  },
}) }));

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/config.js')>();
  return { ...original, config: new Proxy(original.config, { get: (target, key) => (key === 'GUEST_HTTP_ENABLED' ? flags.guestHttp : target[key as keyof typeof target]) }) };
});
vi.mock('../../src/modules/buscaminas/buscaminas.service.js', () => ({ buscaminasService: service, createBuscaminasService: vi.fn(), startBuscaminasReadinessCheck: vi.fn() }));
vi.mock('../../src/modules/guest/guest.service.js', async () => {
  const { AuthenticationError } = await import('../../src/core/errors.js');
  const sessions: Record<string, string> = { [GUEST_A]: 'guest-a', [GUEST_B]: 'guest-b' };
  return {
    GUEST_TOKEN_HEADER: 'x-guest-token',
    GUEST_TOKEN_SHAPE: /^[a-f0-9]{64}$/,
    guestService: {
      resolve: vi.fn(async (token: string | undefined) => {
        if (!token || !sessions[token]) throw new AuthenticationError('Unknown guest token');
        return { id: sessions[token], locale: null, linked_user_id: null };
      }),
    },
  };
});
vi.mock('../../src/http/middleware/auth.js', async () => {
  const { AuthenticationError } = await import('../../src/core/errors.js');
  const resolve = (req: express.Request) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? req.cookies?.qb_access_token;
    return token === 'good' ? { id: 'user-a' } : null;
  };
  const hasToken = (req: express.Request) => Boolean(req.headers.authorization || req.cookies?.qb_access_token);
  return {
    authMiddleware: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const user = resolve(req);
      if (!user) return next(new AuthenticationError('Invalid token'));
      req.user = user as never;
      next();
    },
    optionalAuthMiddleware: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      if (hasToken(req)) {
        const user = resolve(req);
        if (user) req.user = user as never;
      }
      next();
    },
  };
});

import { buscaminasRoutes } from '../../src/http/routes/buscaminas.routes.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/buscaminas', buscaminasRoutes);
app.use(errorHandler);

const post = (path: string, body: unknown) => request(app).post(`/api/v1/buscaminas${path}`).send(body as object);
const move = { runId: RUN_ID, version: 3 };

describe('buscaminas routes: identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.guestHttp = true;
    redis.open = true;
    redis.counts.clear();
    redis.exhausted.clear();
  });

  it('a member plays by bearer (or session cookie), a guest by its guest session', async () => {
    await post('/start', { day: '2026-09-27' }).set('authorization', 'Bearer good');
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', { kind: 'member', userId: 'user-a' }, undefined);
    await post('/start', { day: '2026-09-27' }).set('cookie', 'qb_access_token=good');
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', { kind: 'member', userId: 'user-a' }, undefined);
    await post('/start', { day: '2026-09-27', contentVersion: 9 }).set('x-guest-token', GUEST_A);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', { kind: 'guest', guestId: 'guest-a' }, 9);
    // A member session wins over a guest token sent alongside it.
    await post('/start', { day: '2026-09-27' }).set('authorization', 'Bearer good').set('x-guest-token', GUEST_A);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', { kind: 'member', userId: 'user-a' }, undefined);
  });

  it('neither session is a 401 guest_session_required on every player endpoint', async () => {
    for (const [path, body] of [['/start', { day: '2026-09-27' }], ['/tap', { ...move, cardId: 'c' }], ['/bank', move], ['/next', move]] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'guest_session_required', details: { reason: 'guest_session_required' } });
    }
    expect((await request(app).get('/api/v1/buscaminas/current')).body).toMatchObject({ code: 'guest_session_required' });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('a bad bearer is a 401, never a silent guest run; a stale cookie falls back to the guest session', async () => {
    const bad = await post('/start', { day: '2026-09-27' }).set('authorization', 'Bearer expired').set('x-guest-token', GUEST_A);
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('AUTHENTICATION_ERROR');
    const stale = await post('/start', { day: '2026-09-27' }).set('cookie', 'qb_access_token=expired').set('x-guest-token', GUEST_A);
    expect(stale.status).toBe(200);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-27', { kind: 'guest', guestId: 'guest-a' }, undefined);
  });

  it('an unknown or expired guest token is a 401 the client answers with a fresh session', async () => {
    const res = await post('/tap', { ...move, cardId: 'c' }).set('x-guest-token', 'c'.repeat(64));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_ERROR');
    expect(service.tap).not.toHaveBeenCalled();
  });

  it('guest calls spend the shared address budget before the session lookup, then a per-guest budget', async () => {
    await post('/tap', { ...move, cardId: 'c' }).set('x-guest-token', GUEST_A);
    const keys = [...redis.counts.keys()];
    expect(keys.some((k) => k.startsWith('guest:http:buscaminas-address:'))).toBe(true);
    expect(keys).toContainEqual(expect.stringMatching(/^guest:http:buscaminas:guest-a:/));
    await post('/tap', { ...move, cardId: 'c' }).set('authorization', 'Bearer good');
    expect(redis.counts.size).toBe(keys.length);
  });

  it('a flood of fake tokens stops at the address budget without reaching the session lookup', async () => {
    const fake = await post('/tap', { ...move, cardId: 'c' }).set('x-guest-token', 'c'.repeat(64));
    expect(fake.status).toBe(401);
    expect(guestService.resolve).toHaveBeenCalledTimes(1);
    redis.exhausted.add('buscaminas-address');
    const limited = await post('/tap', { ...move, cardId: 'c' }).set('x-guest-token', 'd'.repeat(64));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(guestService.resolve).toHaveBeenCalledTimes(1);
    expect((await post('/tap', { ...move, cardId: 'c' }).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('a malformed guest token is a 401 without a session lookup', async () => {
    const res = await post('/start', { day: '2026-09-27' }).set('x-guest-token', 'not-a-token');
    expect(res.status).toBe(401);
    expect(guestService.resolve).not.toHaveBeenCalled();
  });

  it('one guest over its budget is 429; another guest keeps playing', async () => {
    redis.exhausted.add('buscaminas');
    expect((await post('/next', move).set('x-guest-token', GUEST_B)).status).toBe(429);
    redis.exhausted.clear();
    expect((await post('/next', move).set('x-guest-token', GUEST_A)).status).toBe(200);
    expect(service.next).toHaveBeenCalledTimes(1);
  });

  it('without Redis guest play fails closed with 503; members still play', async () => {
    redis.open = false;
    expect((await post('/start', { day: '2026-09-27' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    expect(guestService.resolve).not.toHaveBeenCalled();
    expect((await post('/start', { day: '2026-09-27' }).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('guest play follows the guest HTTP switch; members are unaffected', async () => {
    flags.guestHttp = false;
    expect((await post('/start', { day: '2026-09-27' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    expect((await post('/start', { day: '2026-09-27' }).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('moves pass the player, run id and version through; /current reads the player\'s own run, never cached', async () => {
    await post('/tap', { ...move, cardId: 'r0c1' }).set('x-guest-token', GUEST_B);
    expect(service.tap).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-b' }, RUN_ID, 3, 'r0c1');
    await post('/bank', move).set('authorization', 'Bearer good');
    expect(service.bank).toHaveBeenLastCalledWith({ kind: 'member', userId: 'user-a' }, RUN_ID, 3);
    await post('/next', move).set('x-guest-token', GUEST_A);
    expect(service.next).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, RUN_ID, 3);
    const current = await request(app).get('/api/v1/buscaminas/current?day=2026-09-27').set('x-guest-token', GUEST_A);
    expect(service.current).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, '2026-09-27');
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect(current.headers.vary).toMatch(/x-guest-token/i);
  });
});

describe('buscaminas routes: validation, caching, limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.guestHttp = true;
    redis.open = true;
    redis.counts.clear();
    redis.exhausted.clear();
  });

  it('start validates contentVersion as a positive integer up to 2^32', async () => {
    const start = (contentVersion: number) => post('/start', { day: '2026-09-27', contentVersion }).set('x-guest-token', GUEST_A);
    expect((await start(2 ** 32)).status).toBe(200);
    expect((await start(2 ** 32 + 1)).status).toBe(422);
    expect((await start(1.5)).status).toBe(422);
  });

  it('moves need a run uuid and a non-negative integer version', async () => {
    const tap = (body: unknown) => post('/tap', body).set('x-guest-token', GUEST_A);
    expect((await tap({ runId: 'nope', version: 0, cardId: 'c' })).status).toBe(422);
    expect((await tap({ runId: RUN_ID, version: -1, cardId: 'c' })).status).toBe(422);
    expect((await tap({ runId: RUN_ID, cardId: 'c' })).status).toBe(422);
    expect((await tap({ token: 'x.y', cardId: 'c' })).status).toBe(422);
    expect((await post('/bank', { runId: RUN_ID, version: 0.5 }).set('x-guest-token', GUEST_A)).status).toBe(422);
    expect(service.tap).not.toHaveBeenCalled();
  });

  it('a guest refused the live day gets 403 with code sign_in_for_today', async () => {
    const { signInForToday } = await import('../../src/modules/buscaminas/buscaminas.errors.js');
    service.start.mockRejectedValueOnce(signInForToday());
    const res = await post('/start', { day: '2026-09-28' }).set('x-guest-token', GUEST_A);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'sign_in_for_today', details: { reason: 'sign_in_for_today' } });
  });

  it('the leaderboard needs no session, ignores a guest token and is only publicly cacheable for anonymous callers', async () => {
    const anon = await request(app).get('/api/v1/buscaminas/leaderboard').set('x-guest-token', GUEST_A);
    expect(anon.status).toBe(200);
    expect(anon.headers['cache-control']).toBe('public, max-age=15');
    expect(anon.headers.vary).toMatch(/Authorization/);
    expect(anon.headers.vary).toMatch(/Cookie/);
    expect(anon.headers.vary ?? '').not.toMatch(/x-guest-token/i);
    expect(service.leaderboard).toHaveBeenLastCalledWith(undefined, null);
    const authed = await request(app).get('/api/v1/buscaminas/leaderboard?day=2026-09-27').set('authorization', 'Bearer good');
    expect(authed.headers['cache-control']).toBe('private, no-store');
    expect(service.leaderboard).toHaveBeenLastCalledWith('2026-09-27', 'user-a');
  });

  it('rate limits per player: one guest\'s burst does not limit another guest', async () => {
    let last = 200;
    for (let i = 0; i < 31; i += 1) last = (await post('/start', { day: '2026-09-27' }).set('x-guest-token', GUEST_B)).status;
    expect(last).toBe(429);
    expect((await post('/start', { day: '2026-09-27' }).set('x-guest-token', GUEST_A)).status).toBe(200);
  });

  it('boards/:day: a finished day is cacheable for a day, the live day for five minutes, both varying on Origin', async () => {
    const past = await request(app).get('/api/v1/buscaminas/boards/2026-09-27');
    expect(past.status).toBe(200);
    expect(past.body).toEqual({ day: '2026-09-27', number: 2, contentVersion: 7, rounds: [] });
    expect(past.headers['cache-control']).toBe('public, max-age=86400');
    expect(past.headers.vary).toMatch(/Origin/);
    expect(past.headers.vary ?? '').not.toMatch(/Authorization|Cookie/);
    service.board.mockResolvedValueOnce({ board: { day: '2026-09-28', number: 3, contentVersion: 8, rounds: [] }, live: true });
    const live = await request(app).get('/api/v1/buscaminas/boards/2026-09-28');
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
  });

  it('the boards index is public for five minutes', async () => {
    const res = await request(app).get('/api/v1/buscaminas/boards');
    expect(res.body).toEqual({ days: { '2026-09-26': 5, '2026-09-27': 7 } });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });
});
