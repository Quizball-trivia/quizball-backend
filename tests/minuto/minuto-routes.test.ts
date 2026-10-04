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
    guess: vi.fn(async () => ({ run: { id: 'r', version: 2 }, state: {} })),
    next: vi.fn(async () => ({ run: { id: 'r', version: 4 }, state: {} })),
    current: vi.fn(async () => ({ run: null })),
    leaderboard: vi.fn(async () => ({ day: '2026-09-29', players: 0, top: [], me: null })),
    boards: vi.fn(async () => ({ days: { '2026-09-27': 5, '2026-09-28': 7 }, rankedFrom: '2026-09-29' })),
    review: vi.fn(async (day: string) => ({ day, goals: [] })),
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
vi.mock('../../src/modules/minuto/minuto.service.js', () => ({ minutoService: service, createMinutoService: vi.fn(), startMinutoReadinessCheck: vi.fn() }));
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

import { minutoRoutes } from '../../src/http/routes/minuto.routes.js';
import { guestService } from '../../src/modules/guest/guest.service.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/minuto', minutoRoutes);
app.use(errorHandler);

const post = (path: string, body: unknown) => request(app).post(`/api/v1/minuto${path}`).send(body as object);
const move = { runId: RUN_ID, version: 3 };
const reset = () => {
  vi.clearAllMocks();
  flags.guestHttp = true;
  redis.open = true;
  redis.counts.clear();
  redis.exhausted.clear();
};

describe('minuto routes', () => {
  beforeEach(reset);

  it('a member plays by bearer, a guest by its guest session; neither is a 401 on every player endpoint', async () => {
    await post('/start', { day: '2026-10-01', contentVersion: 9 }).set('authorization', 'Bearer good');
    expect(service.start).toHaveBeenLastCalledWith('2026-10-01', { kind: 'member', userId: 'user-a' }, 9);
    await post('/guess', { ...move, minute: 93 }).set('x-guest-token', GUEST_A);
    expect(service.guess).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, RUN_ID, 3, 93);
    await post('/next', move).set('x-guest-token', GUEST_B);
    expect(service.next).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-b' }, RUN_ID, 3);
    for (const [path, body] of [['/start', { day: '2026-10-01' }], ['/guess', { ...move, minute: 10 }], ['/next', move]] as const) {
      expect((await post(path, body)).body).toMatchObject({ code: 'guest_session_required' });
    }
    expect((await post('/guess', { ...move, minute: 10 }).set('x-guest-token', 'c'.repeat(64))).status).toBe(401);
    expect(guestService.resolve).toHaveBeenCalledTimes(3);
  });

  it('guests spend Minuto\'s own address and session budgets; no Redis or the guest switch off fails closed', async () => {
    await post('/next', move).set('x-guest-token', GUEST_A);
    const keys = [...redis.counts.keys()];
    expect(keys).toContainEqual(expect.stringMatching(/^guest:http:minuto-address:/));
    expect(keys).toContainEqual(expect.stringMatching(/^guest:http:minuto:guest-a:/));
    expect(keys.some((k) => /pistas|buscaminas|ultimo/.test(k))).toBe(false);
    redis.exhausted.add('minuto-address');
    expect((await post('/next', move).set('x-guest-token', GUEST_B)).status).toBe(429);
    expect((await post('/next', move).set('authorization', 'Bearer good')).status).toBe(200);
    redis.exhausted.clear();
    redis.open = false;
    expect((await post('/start', { day: '2026-10-01' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    redis.open = true;
    flags.guestHttp = false;
    expect((await post('/start', { day: '2026-10-01' }).set('x-guest-token', GUEST_A)).status).toBe(503);
    expect((await post('/start', { day: '2026-10-01' }).set('authorization', 'Bearer good')).status).toBe(200);
  });

  it('a guess is a whole minute from 1 to 130 (added time already summed); anything else is a 422 that never reaches the game', async () => {
    const guest = (body: unknown) => post('/guess', body).set('x-guest-token', GUEST_A);
    for (const minute of [0, 131, 12.5, '93', '90+3', null]) expect((await guest({ ...move, minute })).status).toBe(422);
    expect((await guest(move)).status).toBe(422);
    expect((await guest({ runId: 'nope', version: 0, minute: 10 })).status).toBe(422);
    expect(service.guess).not.toHaveBeenCalled();
    for (const minute of [1, 130]) expect((await guest({ ...move, minute })).status).toBe(200);
    expect((await post('/start', { day: '2026-02-30' }).set('x-guest-token', GUEST_A)).status).toBe(422);
  });

  it('service refusals keep their status and reason', async () => {
    const { signInForToday, staleState } = await import('../../src/modules/minuto/minuto.errors.js');
    service.start.mockRejectedValueOnce(signInForToday());
    const refused = await post('/start', { day: '2026-10-02' }).set('x-guest-token', GUEST_A);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'sign_in_for_today' });
    service.guess.mockRejectedValueOnce(staleState());
    expect((await post('/guess', { ...move, minute: 50 }).set('x-guest-token', GUEST_A)).body).toMatchObject({ code: 'stale_state' });
  });

  it('caching: own run never stored, boards five minutes, a closed day\'s review an hour, the board public only when anonymous', async () => {
    const current = await request(app).get('/api/v1/minuto/current?day=2026-10-01').set('x-guest-token', GUEST_A);
    expect(service.current).toHaveBeenLastCalledWith({ kind: 'guest', guestId: 'guest-a' }, '2026-10-01');
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect((await request(app).get('/api/v1/minuto/boards')).headers['cache-control']).toBe('public, max-age=300');
    const review = await request(app).get('/api/v1/minuto/review?day=2026-10-01');
    expect(review.headers['cache-control']).toBe('public, max-age=3600');
    const { NotFoundError } = await import('../../src/core/errors.js');
    service.review.mockRejectedValueOnce(new NotFoundError('Day not available'));
    const live = await request(app).get('/api/v1/minuto/review?day=2026-10-02');
    expect(live.status).toBe(404);
    expect(live.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/v1/minuto/leaderboard')).headers['cache-control']).toBe('public, max-age=15');
    expect((await request(app).get('/api/v1/minuto/leaderboard').set('authorization', 'Bearer good')).headers['cache-control']).toBe('private, no-store');
    expect(service.leaderboard).toHaveBeenLastCalledWith(undefined, 'user-a');
  });
});
