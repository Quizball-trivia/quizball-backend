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
    reveal: vi.fn(async () => ({ run: { id: 'r', version: 1 }, state: {} })),
    guess: vi.fn(async () => ({ run: { id: 'r', version: 2 }, state: {}, correct: false })),
    giveUp: vi.fn(async () => ({ run: { id: 'r', version: 3 }, state: {} })),
    next: vi.fn(async () => ({ run: { id: 'r', version: 4 }, state: {} })),
    current: vi.fn(async () => ({ run: null })),
    leaderboard: vi.fn(async () => ({ day: '2026-09-29', players: 0, top: [], me: null })),
    boards: vi.fn(async () => ({ days: { '2026-09-27': 5, '2026-09-28': 7 }, rankedFrom: '2026-09-29' })),
    review: vi.fn(async (day: string) => ({ day, rounds: [] })),
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
vi.mock('../../src/modules/pistas/pistas.service.js', () => ({ pistasService: service, createPistasService: vi.fn(), startPistasReadinessCheck: vi.fn() }));
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

import { pistasRoutes } from '../../src/http/routes/pistas.routes.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/pistas', pistasRoutes);
app.use(errorHandler);

const post = (path: string, body: unknown) => request(app).post(`/api/v1/pistas${path}`).send(body as object);
const move = { runId: RUN_ID, version: 3 };
const reset = () => {
  vi.clearAllMocks();
  flags.guestHttp = true;
  redis.open = true;
  redis.counts.clear();
  redis.exhausted.clear();
};

describe('pistas routes: identity', () => {
  beforeEach(reset);

  it('a member plays by bearer (or session cookie), a guest by its guest session', async () => {
    await post('/start', { day: '2026-09-28' }).set('authorization', 'Bearer good');
    expect(service.start).toHaveBeenLastCalledWith('2026-09-28', { kind: 'member', userId: 'user-a' }, undefined);
    await post('/start', { day: '2026-09-28' }).set('cookie', 'qb_access_token=good');
    expect(service.start).toHaveBeenLastCalledWith('2026-09-28', { kind: 'member', userId: 'user-a' }, undefined);
    await post('/start', { day: '2026-09-28', contentVersion: 9 }).set('x-guest-token', GUEST_A);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-28', { kind: 'guest', guestId: 'guest-a' }, 9);
    await post('/start', { day: '2026-09-28' }).set('authorization', 'Bearer good').set('x-guest-token', GUEST_A);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-28', { kind: 'member', userId: 'user-a' }, undefined);
  });

  it('neither session is a 401 guest_session_required on every player endpoint', async () => {
    for (const [path, body] of [['/start', { day: '2026-09-28' }], ['/reveal', move], ['/guess', { ...move, guess: 'x' }], ['/giveup', move], ['/next', move]] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'guest_session_required', details: { reason: 'guest_session_required' } });
    }
    expect((await request(app).get('/api/v1/pistas/current')).body).toMatchObject({ code: 'guest_session_required' });
    expect(service.start).not.toHaveBeenCalled();
  });

  it('a bad bearer is a 401, never a silent guest run; a stale cookie falls back to the guest session', async () => {
    const badBearer = await post('/start', { day: '2026-09-28' }).set('authorization', 'Bearer expired').set('x-guest-token', GUEST_A);
    expect(badBearer.status).toBe(401);
    expect(badBearer.body.code).toBe('AUTHENTICATION_ERROR');
    const stale = await post('/start', { day: '2026-09-28' }).set('cookie', 'qb_access_token=expired').set('x-guest-token', GUEST_A);
    expect(stale.status).toBe(200);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenLastCalledWith('2026-09-28', { kind: 'guest', guestId: 'guest-a' }, undefined);
  });

  it('unknown or malformed guest tokens are 401s; the malformed one without a session lookup', async () => {
    const unknown = await post('/reveal', move).set('x-guest-token', 'c'.repeat(64));
    expect(unknown.status).toBe(401);
    expect(guestService.resolve).toHaveBeenCalledTimes(1);
    expect((await post('/start', { day: '2026-09-28' }).set('x-guest-token', 'not-a-token')).status).toBe(401);
    expect(guestService.resolve).toHaveBeenCalledTimes(1);
    expect(service.reveal).not.toHaveBeenCalled();
  });

  it('guest calls spend the shared address budget before the session lookup, then a per-guest budget, apart from Buscaminas\'', async () => {
    await post('/reveal', move).set('x-guest-token', GUEST_A);
    const keys = [...redis.counts.keys()];
    expect(keys).toContainEqual(expect.stringMatching(/^guest:http:pistas-address:/));
    expect(keys).toContainEqual(expect.stringMatching(/^guest:http:pistas:guest-a:/));
    expect(keys.some((k) => k.includes('buscaminas'))).toBe(false);
    await post('/reveal', move).set('authorization', 'Bearer good');
    expect(redis.counts.size).toBe(keys.length);
    redis.exhausted.add('pistas-address');
    const limited = await post('/reveal', move).set('x-guest-token', 'd'.repeat(64));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(guestService.resolve).toHaveBeenCalledTimes(1);
    redis.exhausted.clear();
    redis.counts.clear();
    redis.exhausted.add('pistas');
    expect((await post('/next', move).set('x-guest-token', GUEST_B)).status).toBe(429);
    expect((await post('/next', move).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('without Redis, or with the guest HTTP switch off, guest play fails closed with 503; members still play', async () => {
    redis.open = false;
    expect((await post('/start', { day: '2026-09-28' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    expect(guestService.resolve).not.toHaveBeenCalled();
    expect((await post('/start', { day: '2026-09-28' }).set('authorization', 'Bearer good')).status).toBe(200);
    redis.open = true;
    flags.guestHttp = false;
    expect((await post('/start', { day: '2026-09-28' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    expect((await post('/start', { day: '2026-09-28' }).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('moves pass the player, run id, version (and guess) through; /current reads the player\'s own run, never cached', async () => {
    await post('/reveal', move).set('x-guest-token', GUEST_B);
    expect(service.reveal).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-b' }, RUN_ID, 3);
    const guessed = await post('/guess', { ...move, guess: 'Dé Lorén' }).set('authorization', 'Bearer good');
    expect(service.guess).toHaveBeenLastCalledWith({ kind: 'member', userId: 'user-a' }, RUN_ID, 3, 'Dé Lorén');
    expect(guessed.body).toMatchObject({ correct: false });
    await post('/giveup', move).set('x-guest-token', GUEST_A);
    expect(service.giveUp).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, RUN_ID, 3);
    await post('/next', move).set('x-guest-token', GUEST_A);
    expect(service.next).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, RUN_ID, 3);
    const current = await request(app).get('/api/v1/pistas/current?day=2026-09-28').set('x-guest-token', GUEST_A);
    expect(service.current).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, '2026-09-28');
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect(current.headers.vary).toMatch(/x-guest-token/i);
  });
});

describe('pistas routes: validation, caching, limits', () => {
  beforeEach(reset);

  it('validates days, content versions, run ids, versions and guesses (at most 60 characters, a letter or digit)', async () => {
    const guest = (path: string, body: unknown) => post(path, body).set('x-guest-token', GUEST_A);
    expect((await guest('/start', { day: '2026-09-28', contentVersion: 2 ** 32 })).status).toBe(200);
    expect((await guest('/start', { day: '2026-09-28', contentVersion: 2 ** 32 + 1 })).status).toBe(422);
    expect((await guest('/start', { day: '2026-02-30' })).status).toBe(422);
    expect((await guest('/reveal', { runId: 'nope', version: 0 })).status).toBe(422);
    expect((await guest('/reveal', { runId: RUN_ID, version: -1 })).status).toBe(422);
    expect((await guest('/giveup', { runId: RUN_ID, version: 0.5 })).status).toBe(422);
    expect((await guest('/guess', move)).status).toBe(422);
    expect((await guest('/guess', { ...move, guess: 'x'.repeat(61) })).status).toBe(422);
    expect((await guest('/guess', { ...move, guess: ' ¡!-. ' })).status).toBe(422);
    expect((await guest('/guess', { ...move, guess: 42 })).status).toBe(422);
    expect((await guest('/guess', { ...move, guess: 'x'.repeat(60) })).status).toBe(200);
    expect((await guest('/guess', { ...move, guess: 'ტესტი სახელი' })).status).toBe(200);
    expect(service.reveal).not.toHaveBeenCalled();
    expect(service.giveUp).not.toHaveBeenCalled();
    expect((await request(app).get('/api/v1/pistas/current?day=2026-13-01').set('x-guest-token', GUEST_A)).status).toBe(422);
  });

  it('service refusals keep their status and reason', async () => {
    const { signInForToday, rejected } = await import('../../src/modules/pistas/pistas.errors.js');
    service.start.mockRejectedValueOnce(signInForToday());
    const refused = await post('/start', { day: '2026-09-29' }).set('x-guest-token', GUEST_A);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'sign_in_for_today', details: { reason: 'sign_in_for_today' } });
    service.reveal.mockRejectedValueOnce(rejected('no_more_clues'));
    const noMore = await post('/reveal', move).set('x-guest-token', GUEST_A);
    expect(noMore.status).toBe(400);
    expect(noMore.body).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'no_more_clues' } });
  });

  it('the leaderboard needs no session, ignores a guest token and is only publicly cacheable for anonymous callers', async () => {
    const anon = await request(app).get('/api/v1/pistas/leaderboard').set('x-guest-token', GUEST_A);
    expect(anon.status).toBe(200);
    expect(anon.headers['cache-control']).toBe('public, max-age=15');
    expect(anon.headers.vary).toMatch(/Authorization/);
    expect(anon.headers.vary ?? '').not.toMatch(/x-guest-token/i);
    expect(service.leaderboard).toHaveBeenLastCalledWith(undefined, null);
    const authed = await request(app).get('/api/v1/pistas/leaderboard?day=2026-09-29').set('authorization', 'Bearer good');
    expect(authed.headers['cache-control']).toBe('private, no-store');
    expect(service.leaderboard).toHaveBeenLastCalledWith('2026-09-29', 'user-a');
  });

  it('rate limits per player: one guest\'s burst does not limit another guest', async () => {
    let last = 200;
    for (let i = 0; i < 31; i += 1) last = (await post('/start', { day: '2026-09-28' }).set('x-guest-token', GUEST_B)).status;
    expect(last).toBe(429);
    expect((await post('/start', { day: '2026-09-28' }).set('x-guest-token', GUEST_A)).status).toBe(200);
  });

  it('the boards index is public for five minutes and carries no content', async () => {
    const res = await request(app).get('/api/v1/pistas/boards');
    expect(res.body).toEqual({ days: { '2026-09-27': 5, '2026-09-28': 7 }, rankedFrom: '2026-09-29' });
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.headers.vary).toMatch(/Origin/);
  });

  it('review: a closed day is publicly cacheable; a refused day is a 404 never stored; the day is required', async () => {
    const ok = await request(app).get('/api/v1/pistas/review?day=2026-09-28');
    expect(ok.status).toBe(200);
    expect(service.review).toHaveBeenLastCalledWith('2026-09-28');
    expect(ok.headers['cache-control']).toBe('public, max-age=3600');
    expect(ok.headers.vary).toMatch(/Origin/);
    expect(ok.headers.vary ?? '').not.toMatch(/Authorization|Cookie/);
    const { NotFoundError } = await import('../../src/core/errors.js');
    service.review.mockRejectedValueOnce(new NotFoundError('Day not available'));
    const today = await request(app).get('/api/v1/pistas/review?day=2026-09-29');
    expect(today.status).toBe(404);
    expect(today.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/v1/pistas/review')).status).toBe(422);
  });
});
