import 'express-async-errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { SignJWT } from 'jose';

const auth = vi.hoisted(() => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'member' || token === 'staff') return { provider: 'supabase', subject: token, claims: {} };
    throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
  }),
}));
vi.mock('../../src/modules/auth/index.js', () => ({ getAuthProvider: () => ({ verifyToken: auth.verifyToken }) }));
vi.mock('../../src/modules/users/index.js', () => ({
  usersService: {
    getOrCreateFromIdentity: vi.fn(async (identity: { subject: string }) => ({
      id: `${identity.subject}-id`,
      role: identity.subject === 'staff' ? 'partner_staff' : 'user',
      country: 'GE',
    })),
  },
}));
vi.mock('../../src/modules/users/user-cache.js', () => ({ getCachedUser: vi.fn(async () => null) }));
vi.mock('../../src/core/geo.js', () => ({
  detectCountryFromRequest: vi.fn(async () => null),
  detectCountryFromHeaders: vi.fn(async () => null),
}));

import { authMiddleware, isStaffAllowedRoute, optionalAuthMiddleware } from '../../src/http/middleware/auth.js';
import { errorHandler, requestIdMiddleware } from '../../src/http/middleware/index.js';
import { resetPartnerConfigCache, sha256Hex, type PartnerConfig } from '../../src/modules/partners/partner-config.js';
import { addDays, nextPartnerMidnight, partnerDayOf } from '../../src/modules/partners/partner-games.js';
import {
  ipAllowed,
  localBucketStore,
  machineRateLimiter,
  matchApiKey,
  redisBucketStore,
  requirePartnerConfig,
  type BucketStore,
} from '../../src/modules/partners/partner-machine-auth.js';
import { logger } from '../../src/core/logger.js';
import { socketAuthMiddleware } from '../../src/realtime/socket-auth.js';
import { createClient } from 'redis';
import { cleanDisplayName, partnerHandle } from '../../src/modules/partners/partner-sessions.service.js';
import {
  isPartnerToken,
  newLaunchToken,
  signPartnerAccessToken,
  verifyPartnerAccessToken,
} from '../../src/modules/partners/partner-token.js';
import { overallStatus } from '../../src/modules/partners/partner-status.js';
import { Sealer } from '../../src/modules/partners/retained.js';

const KEY_A = 'k'.repeat(64);
const KEY_B = 'r'.repeat(64);
const CONFIG: PartnerConfig = {
  slug: 'freecroco',
  environment: 'test',
  inboundKeySha256: [sha256Hex(KEY_A), sha256Hex(KEY_B)],
  allowedCidrs: ['203.0.113.0/24', '2001:db8::/32', '198.51.100.7', 'not-an-ip', '10.0.0.1/'],
  launchBaseUrl: 'https://staging-freecroco.quizball.io',
};

beforeEach(() => {
  process.env.PARTNER_JWT_SECRET = 'unit-test-partner-jwt-secret-32-bytes-min';
  process.env.PARTNER_RESPONSE_SEAL_KEY = 'unit-test-partner-seal-key-32-bytes-minimum';
  resetPartnerConfigCache();
});

describe('partner day (Asia/Tbilisi)', () => {
  it('rolls over at 20:00 UTC (00:00 Tbilisi)', () => {
    expect(partnerDayOf(new Date('2026-10-05T19:59:59.999Z'))).toBe('2026-10-05');
    expect(partnerDayOf(new Date('2026-10-05T20:00:00.000Z'))).toBe('2026-10-06');
    expect(nextPartnerMidnight(new Date('2026-10-05T19:59:59.999Z')).toISOString()).toBe('2026-10-05T20:00:00.000Z');
    expect(nextPartnerMidnight(new Date('2026-10-05T20:00:00.000Z')).toISOString()).toBe('2026-10-06T20:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('machine credentials', () => {
  it('matches either rotation key and nothing else', () => {
    expect(matchApiKey(CONFIG, KEY_A)).toBe(sha256Hex(KEY_A));
    expect(matchApiKey(CONFIG, KEY_B)).toBe(sha256Hex(KEY_B));
    expect(matchApiKey(CONFIG, 'x'.repeat(64))).toBeNull();
    expect(matchApiKey(CONFIG, '')).toBeNull();
    expect(matchApiKey(CONFIG, undefined)).toBeNull();
    expect(matchApiKey(CONFIG, ['k'])).toBeNull();
  });

  it('allows only listed addresses and blocks; malformed entries allow nothing', () => {
    expect(ipAllowed(CONFIG, '203.0.113.50')).toBe(true);
    expect(ipAllowed(CONFIG, '198.51.100.7')).toBe(true);
    expect(ipAllowed(CONFIG, '198.51.100.8')).toBe(false);
    expect(ipAllowed(CONFIG, '2001:db8::1')).toBe(true);
    expect(ipAllowed(CONFIG, '10.0.0.1')).toBe(false);
    expect(ipAllowed(CONFIG, '8.8.8.8')).toBe(false);
    expect(ipAllowed(CONFIG, undefined)).toBe(false);
    expect(ipAllowed({ ...CONFIG, allowedCidrs: [] }, '203.0.113.50')).toBe(false);
  });

  const limited = (shared: BucketStore, fallback: BucketStore) => {
    const app = express();
    app.use((req, _res, next) => {
      req.partnerMachine = { config: CONFIG, keyHash: String(req.headers['x-key']).padEnd(64, '0') };
      next();
    });
    app.use(machineRateLimiter(shared, fallback, 50, 100));
    app.get('/', (_req, res) => res.json({ ok: true }));
    return app;
  };
  const down: BucketStore = { take: async () => { throw new Error('redis is not connected'); } };

  it('per key: a burst of 100, then 50 per second, with Retry-After (local bucket)', async () => {
    let now = 1_000_000;
    const app = limited(down, localBucketStore(() => now));
    for (let i = 0; i < 100; i += 1) expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    const refused = await request(app).get('/').set('x-key', 'a');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
    expect(refused.headers['retry-after']).toBe('1');
    expect((await request(app).get('/').set('x-key', 'b')).status).toBe(200);
    now += 100;
    for (let i = 0; i < 5; i += 1) expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    expect((await request(app).get('/').set('x-key', 'a')).status).toBe(429);
  });

  it('decides deployment-wide in the shared store, keyed by partner, environment and key', async () => {
    const take = vi.fn(async () => [false, 1500] as [boolean, number]);
    const res = await request(limited({ take }, down)).get('/').set('x-key', 'abc');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('2');
    expect(take).toHaveBeenCalledWith(`partner:rl:freecroco:test:${'abc'.padEnd(16, '0')}`, 50, 100);
  });

  it('fails open to the per-process bucket (with one warning) when Redis is unavailable', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const fallback = { take: vi.fn(async () => [true, 0] as [boolean, number]) };
    const app = limited(down, fallback);
    expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    expect(fallback.take).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('rate limit store unavailable'))).toHaveLength(1);
    expect((await request(limited(redisBucketStore(() => null), fallback)).get('/').set('x-key', 'a')).status).toBe(200);
    warn.mockRestore();
  });

  it('falling back after shared-store admissions grants no second burst', async () => {
    let now = 5_000;
    let redisUp = true;
    const shared: BucketStore = {
      take: async () => {
        if (!redisUp) throw new Error('redis is not connected');
        return [true, 0];
      },
    };
    const app = limited(shared, localBucketStore(() => now));
    for (let i = 0; i < 100; i += 1) expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    redisUp = false;
    expect((await request(app).get('/').set('x-key', 'a')).status).toBe(429);
    now += 1_000;
    let admitted = 0;
    for (let i = 0; i < 60; i += 1) if ((await request(app).get('/').set('x-key', 'a')).status === 200) admitted += 1;
    expect(admitted).toBe(50);
  });

  it('getting Redis back grants no second burst either: a request needs both buckets', async () => {
    const now = 5_000;
    let redisUp = false;
    const shared: BucketStore = {
      take: async () => {
        if (!redisUp) throw new Error('redis is not connected');
        return [true, 0];
      },
    };
    const app = limited(shared, localBucketStore(() => now));
    for (let i = 0; i < 100; i += 1) expect((await request(app).get('/').set('x-key', 'a')).status).toBe(200);
    redisUp = true;
    const refused = await request(app).get('/').set('x-key', 'a');
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
  });

  it('when both refuse, Retry-After is the larger wait; a shared refusal spends no local token', async () => {
    const local = localBucketStore(() => 0);
    const app = limited({ take: async () => [false, 4_200] }, local);
    const refused = await request(app).get('/').set('x-key', 'a');
    expect(refused.headers['retry-after']).toBe('5');
    for (let i = 0; i < 100; i += 1) expect((await local.take(`partner:rl:freecroco:test:${'a'.padEnd(16, '0')}`, 50, 100))[0]).toBe(true);
  });

  it('the local bucket never refills on a backward clock step', async () => {
    let now = 10_000;
    const local = localBucketStore(() => now);
    for (let i = 0; i < 100; i += 1) expect((await local.take('k', 50, 100))[0]).toBe(true);
    now = 2_000;
    expect((await local.take('k', 50, 100))[0]).toBe(false);
    now = 10_000;
    expect((await local.take('k', 50, 100))[0]).toBe(false);
    now = 10_020;
    expect((await local.take('k', 50, 100))[0]).toBe(true);
    expect((await local.take('k', 50, 100))[0]).toBe(false);
  });

  it.skipIf(!process.env.PARTNER_TEST_REDIS_URL)('the Lua bucket keeps the highest timestamp: a backward step refills nothing twice', async () => {
    const client = createClient({ url: process.env.PARTNER_TEST_REDIS_URL });
    await client.connect();
    const key = `partner:rl:test:backstep:${Date.now()}`;
    try {
      // The state a backward clock step leaves: the stored timestamp 5 s ahead of Redis time, the bucket empty.
      const t = await client.time();
      const redisNow = Math.floor(t.getTime());
      const ahead = String(redisNow + 5_000);
      await client.hSet(key, { tokens: '0', at: ahead });
      const store = redisBucketStore(() => client as never);
      const [ok, retry] = await store.take(key, 50, 100);
      expect(ok).toBe(false);
      // The time still ahead (~5 s) plus one token's refill (20 ms).
      expect(retry).toBeGreaterThan(4_900);
      expect(retry).toBeLessThanOrEqual(5_020);
      expect(await client.hGet(key, 'at')).toBe(ahead);
      expect(await client.pTTL(key)).toBeGreaterThan(5_000 + 2_000);
      expect((await store.take(key, 50, 100))[0]).toBe(false);
    } finally {
      await client.del(key);
      await client.quit();
    }
  });

  // Opt-in, real Redis (the Lua bucket): PARTNER_TEST_REDIS_URL=redis://:changeme@127.0.0.1:6379/15
  it.skipIf(!process.env.PARTNER_TEST_REDIS_URL)('the Lua bucket on real Redis: the burst, then refused, then refilled', async () => {
    const client = createClient({ url: process.env.PARTNER_TEST_REDIS_URL });
    await client.connect();
    const key = `partner:rl:test:${Date.now()}`;
    try {
      // 1 per second, so no token refills while the burst is in flight.
      const store = redisBucketStore(() => client as never);
      const results = await Promise.all(Array.from({ length: 12 }, () => store.take(key, 1, 10)));
      expect(results.filter(([ok]) => ok)).toHaveLength(10);
      const [ok, retry] = await store.take(key, 1, 10);
      expect(ok).toBe(false);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(1000);
      await new Promise((r) => setTimeout(r, 1_100));
      expect((await store.take(key, 1, 10))[0]).toBe(true);
    } finally {
      await client.del(key);
      await client.quit();
    }
  });
});

describe('partner config errors', () => {
  it('a malformed config never logs its content', () => {
    const error = vi.spyOn(logger, 'error');
    process.env.PARTNER_FREECROCO_CONFIG = '{"slug":"freecroco","webhook":{"apiKey":"SECRET-KEY-TEXT-123456"';
    resetPartnerConfigCache();
    expect(() => requirePartnerConfig()).toThrow(expect.objectContaining({ code: 'maintenance' }));
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({ slug: 'freecroco', environment: 'test', inboundKeySha256: ['SECRET-KEY-TEXT-123456'], launchBaseUrl: 'x' });
    resetPartnerConfigCache();
    expect(() => requirePartnerConfig()).toThrow(expect.objectContaining({ code: 'maintenance' }));
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain('SECRET-KEY-TEXT');
    expect(error.mock.calls[0][0]).toEqual({ code: 'partner_config_invalid', issues: ['json'] });
    expect(error.mock.calls[1][0]).toMatchObject({ code: 'partner_config_invalid', issues: expect.arrayContaining(['inboundKeySha256.0:invalid_string']) });
    delete process.env.PARTNER_FREECROCO_CONFIG;
    resetPartnerConfigCache();
    error.mockRestore();
  });
});

describe('retained response sealer', () => {
  it('round-trips and refuses tampering or another key', () => {
    const sealer = new Sealer(process.env.PARTNER_RESPONSE_SEAL_KEY!);
    const sealed = sealer.seal('{"oneTimeToken":"qbl_x"}');
    expect(sealed).not.toContain('qbl_x');
    expect(sealer.open(sealed)).toBe('{"oneTimeToken":"qbl_x"}');
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] ^= 1;
    expect(sealer.open(raw.toString('base64'))).toBeNull();
    expect(new Sealer('another-key-of-at-least-32-bytes-long!').open(sealed)).toBeNull();
  });
});

describe('partner access token', () => {
  const claims = { playerId: '6f1c2b0e-8a7d-4c3b-9e2f-1a2b3c4d5e6f', sessionId: '0b9f8a3e-9c55-4d8e-9a53-8a1b1f2c3d4e' };

  it('verifies for its own environment only', async () => {
    const token = await signPartnerAccessToken(CONFIG, claims, new Date(Date.now() + 60_000));
    expect(await verifyPartnerAccessToken(CONFIG, token)).toEqual(claims);
    expect(await verifyPartnerAccessToken({ ...CONFIG, environment: 'production' }, token)).toBeNull();
    expect(isPartnerToken(token)).toBe(true);
  });

  it('refuses expired, foreign-signed and alg-none tokens', async () => {
    const expired = await signPartnerAccessToken(CONFIG, claims, new Date(Date.now() - 1_000));
    expect(await verifyPartnerAccessToken(CONFIG, expired)).toBeNull();
    const foreign = await new SignJWT({ psid: claims.sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('quizball-partner')
      .setAudience('freecroco-test')
      .setSubject(claims.playerId)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('some-other-secret-that-is-32-bytes-long'));
    expect(await verifyPartnerAccessToken(CONFIG, foreign)).toBeNull();
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ iss: 'quizball-partner', aud: 'freecroco-test', sub: claims.playerId, psid: claims.sessionId, exp: 9999999999 })).toString('base64url');
    expect(await verifyPartnerAccessToken(CONFIG, `${header}.${body}.`)).toBeNull();
  });

  it.each(['exp', 'iat', 'sub', 'psid'])('refuses a correctly signed token without %s', async (claim) => {
    const payload: Record<string, unknown> = {
      iss: 'quizball-partner', aud: 'freecroco-test', sub: claims.playerId, psid: claims.sessionId,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    };
    delete payload[claim];
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode(process.env.PARTNER_JWT_SECRET!));
    expect(await verifyPartnerAccessToken(CONFIG, token)).toBeNull();
  });

  it('recognises launch tokens and leaves other tokens alone', () => {
    expect(isPartnerToken(newLaunchToken())).toBe(true);
    expect(isPartnerToken('a'.repeat(64))).toBe(false);
    expect(isPartnerToken('not.a.jwt')).toBe(false);
  });
});

describe('display names', () => {
  it('cleans invisible characters and keeps masked names', () => {
    expect(cleanDisplayName('  nik****om ')).toBe('nik****om');
    expect(cleanDisplayName(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x200b)}`)).toBe('ab');
    expect(cleanDisplayName('')).toBeNull();
    expect(cleanDisplayName(null)).toBeNull();
    expect(cleanDisplayName('Giorgi'.repeat(10))).toHaveLength(50);
  });

  it('gives partner users an internal handle outside the member names', () => {
    const a = partnerHandle('freecroco');
    expect(a).toMatch(/^fc_[0-9a-f]{12}$/);
    expect(partnerHandle('freecroco')).not.toBe(a);
  });
});

describe('status', () => {
  it('reports the worst component, an unknown one counting as degraded', () => {
    expect(overallStatus([{ name: 'api', status: 'ok' }])).toBe('ok');
    expect(overallStatus([{ name: 'a', status: 'ok' }, { name: 'b', status: 'unknown' }])).toBe('degraded');
    expect(overallStatus([{ name: 'a', status: 'down' }, { name: 'b', status: 'unknown' }])).toBe('down');
  });
});

describe('existing auth refuses partner tokens and scopes partner staff', () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  const ok = (req: Request, res: Response) => res.json({ userId: req.user?.id ?? null });
  app.get('/api/v1/protected', authMiddleware, ok);
  app.get('/api/v1/optional', optionalAuthMiddleware, ok);
  app.get('/api/v1/users/me', authMiddleware, ok);
  app.put('/api/v1/users/me', authMiddleware, ok);
  app.get('/partner-admin/v1/partners/freecroco/games', authMiddleware, ok);
  app.use(errorHandler);

  beforeEach(() => {
    auth.verifyToken.mockClear();
  });

  it('rejects a partner access token (bearer or cookie) without sending it to Supabase', async () => {
    const token = await signPartnerAccessToken(CONFIG, { playerId: 'p', sessionId: 's' }, new Date(Date.now() + 60_000));
    const bearer = await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${token}`);
    expect(bearer.status).toBe(401);
    const cookie = await request(app).get('/api/v1/protected').set('Cookie', `qb_access_token=${token}`);
    expect(cookie.status).toBe(401);
    const launch = await request(app).get('/api/v1/protected').set('Authorization', `Bearer ${newLaunchToken()}`);
    expect(launch.status).toBe(401);
    expect(auth.verifyToken).not.toHaveBeenCalled();
  });

  it('optional-auth routes treat a partner token as anonymous', async () => {
    const token = await signPartnerAccessToken(CONFIG, { playerId: 'p', sessionId: 's' }, new Date(Date.now() + 60_000));
    const res = await request(app).get('/api/v1/optional').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: null });
  });

  it('partner staff reach only GET /users/me and the partner admin API', async () => {
    const as = (path: string, method: 'get' | 'put' = 'get') => request(app)[method](path).set('Authorization', 'Bearer staff');
    expect((await as('/api/v1/protected')).status).toBe(403);
    expect((await as('/api/v1/users/me', 'put')).status).toBe(403);
    expect((await as('/api/v1/users/me')).body).toEqual({ userId: 'staff-id' });
    expect((await as('/api/v1/users/me?x=1')).status).toBe(200);
    expect((await as('/partner-admin/v1/partners/freecroco/games')).status).toBe(200);
    expect((await request(app).get('/api/v1/optional').set('Authorization', 'Bearer staff')).body).toEqual({ userId: null });
    expect((await request(app).get('/api/v1/protected').set('Authorization', 'Bearer member')).body).toEqual({ userId: 'member-id' });
  });

  it('matches staff routes by path, not by prefix tricks', () => {
    expect(isStaffAllowedRoute('GET', '/api/v1/users/me/')).toBe(true);
    expect(isStaffAllowedRoute('GET', '/api/v1/users/me/stats')).toBe(false);
    expect(isStaffAllowedRoute('GET', '/partner-admin/v1')).toBe(false);
    expect(isStaffAllowedRoute('POST', '/partner-admin/v1/partners/freecroco/games')).toBe(true);
    expect(isStaffAllowedRoute('GET', '/api/v1/partner-admin/v1/x')).toBe(false);
  });
});

describe('sockets refuse partner tokens and partner staff', () => {
  const connect = async (token: string) => {
    const next = vi.fn();
    const socket = { id: 's1', handshake: { auth: { token }, headers: {}, address: '127.0.0.1' }, data: {} };
    await socketAuthMiddleware(socket as never, next);
    return next;
  };

  it('a partner access or launch token never reaches Supabase', async () => {
    auth.verifyToken.mockClear();
    const token = await signPartnerAccessToken(CONFIG, { playerId: 'p', sessionId: 's' }, new Date(Date.now() + 60_000));
    for (const t of [token, newLaunchToken()]) {
      const next = await connect(t);
      expect(next).toHaveBeenCalledWith(expect.any(Error));
    }
    expect(auth.verifyToken).not.toHaveBeenCalled();
  });

  it('a partner staff session is refused; a member connects', async () => {
    const staffNext = await connect('staff');
    expect(staffNext).toHaveBeenCalledWith(expect.objectContaining({ message: 'Authentication required' }));
    const memberNext = await connect('member');
    expect(memberNext).toHaveBeenCalledWith();
  });
});
