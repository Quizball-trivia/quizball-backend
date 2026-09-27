import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { redis } = vi.hoisted(() => ({ redis: { current: null as unknown } }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => redis.current }));

import { RUN_TOKEN_TTL_SECONDS } from '../../src/modules/buscaminas/buscaminas.constants.js';
import { memoryRunLedger, redisRunLedger, redisStartCounter } from '../../src/modules/buscaminas/buscaminas.ledger.js';
import { errorHandler } from '../../src/http/middleware/error-handler.js';

const outage = { statusCode: 503, code: 'buscaminas_unavailable' };

function client(evalImpl: (...args: unknown[]) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const fake = { isReady: true, eval: vi.fn(evalImpl), hGet: vi.fn(async () => undefined), ...extra };
  redis.current = fake;
  return fake;
}

describe('buscaminas Redis ledger and start counter', () => {
  beforeEach(() => { redis.current = null; });
  afterEach(() => { vi.useRealTimers(); });

  it('claims with the token lifetime as TTL and the strict flag, and parses fresh / replay / stale', async () => {
    const fake = client(async () => ['fresh']);
    expect(await redisRunLedger.claim('rid-1', 3, 'tap:r0c1', 1_700, false)).toEqual({ kind: 'fresh' });
    expect(fake.eval).toHaveBeenCalledWith(expect.stringContaining("'iat'"), {
      keys: ['buscaminas:run:rid-1'], arguments: ['3', 'tap:r0c1', '1700', String(RUN_TOKEN_TTL_SECONDS), '0'],
    });
    await redisRunLedger.claim('rid-1', 3, 'tap:r0c1', 1_700, true);
    expect(fake.eval).toHaveBeenLastCalledWith(expect.stringContaining("ARGV[5] == '1' and sv > 0"), {
      keys: ['buscaminas:run:rid-1'], arguments: ['3', 'tap:r0c1', '1700', String(RUN_TOKEN_TTL_SECONDS), '1'],
    });
    fake.eval.mockResolvedValueOnce(['replay', '1650']);
    expect(await redisRunLedger.claim('rid-1', 3, 'tap:r0c1', 1_700, false)).toEqual({ kind: 'replay', iat: 1650 });
    fake.eval.mockResolvedValueOnce(['stale']);
    expect(await redisRunLedger.claim('rid-1', 3, 'tap:r0c2', 1_700, false)).toEqual({ kind: 'stale' });
    fake.eval.mockResolvedValueOnce(['replay']);
    await expect(redisRunLedger.claim('rid-1', 3, 'tap:r0c1', 1_700, false)).rejects.toMatchObject(outage);
  });

  it('consumed reads the last consumed version; a missing entry past the first action is consumed only when strict', async () => {
    const fake = client(async () => ['fresh']);
    expect(await redisRunLedger.consumed('rid-1', 2, false)).toBe(false);
    expect(await redisRunLedger.consumed('rid-1', 2, true)).toBe(true);
    expect(await redisRunLedger.consumed('rid-1', 0, true)).toBe(false);
    fake.hGet.mockResolvedValueOnce('2' as never);
    expect(await redisRunLedger.consumed('rid-1', 2, false)).toBe(true);
    fake.hGet.mockResolvedValueOnce('1' as never);
    expect(await redisRunLedger.consumed('rid-1', 2, true)).toBe(false);
    expect(fake.hGet).toHaveBeenCalledWith('buscaminas:run:rid-1', 'sv');
  });

  it('the in-memory ledger mirrors the strict semantics', async () => {
    const ledger = memoryRunLedger();
    expect(await ledger.claim('rid-1', 3, 'tap:a', 1, true)).toEqual({ kind: 'stale' });
    expect(await ledger.claim('rid-1', 0, 'tap:a', 1, true)).toEqual({ kind: 'fresh' });
    expect(await ledger.claim('rid-1', 1, 'tap:b', 2, true)).toEqual({ kind: 'fresh' });
    expect(await ledger.claim('rid-2', 3, 'tap:a', 1, false)).toEqual({ kind: 'fresh' });
  });

  it('counts live starts under a day+address key that expires', async () => {
    const fake = client(async () => 4);
    expect(await redisStartCounter.hit('2026-09-28:203.0.113.7')).toBe(4);
    expect(fake.eval).toHaveBeenCalledWith(expect.stringContaining('INCR'), { keys: ['buscaminas:live-starts:2026-09-28:203.0.113.7'], arguments: [String(26 * 3600)] });
  });

  it.each([
    ['no client', () => { redis.current = null; }],
    ['a client that is not ready (reconnecting)', () => { client(async () => ['fresh'], { isReady: false }); }],
    ['a rejected command', () => {
      const reset = async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); };
      client(reset, { hGet: vi.fn(reset) });
    }],
    ['a script error reply', () => {
      const scriptError = async () => { throw new Error('ERR Error running script'); };
      client(scriptError, { hGet: vi.fn(scriptError) });
    }],
    ['a malformed reply', () => { client(async () => 'nope', { hGet: vi.fn(async () => 'nope') }); }],
  ])('any Redis failure is a 503 buscaminas_unavailable: %s', async (_name, arrange) => {
    arrange();
    await expect(redisRunLedger.claim('rid-1', 0, 'bank:', 1, false)).rejects.toMatchObject(outage);
    await expect(redisRunLedger.consumed('rid-1', 0, false)).rejects.toMatchObject(outage);
    await expect(redisStartCounter.hit('k')).rejects.toMatchObject(outage);
  });

  it('a stalled command times out as a 503 instead of hanging the request', async () => {
    vi.useFakeTimers();
    client(() => new Promise(() => undefined));
    const pending = redisRunLedger.claim('rid-1', 0, 'bank:', 1, false);
    const settled = expect(pending).rejects.toMatchObject(outage);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it('reaches the client as a 503 with a clear code, never a database error or a raw 500', async () => {
    client(async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }); });
    const app = express();
    app.post('/claim', async (_req, _res, next) => {
      try {
        await redisRunLedger.claim('rid-1', 0, 'bank:', 1, false);
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);
    const res = await request(app).post('/claim');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'buscaminas_unavailable', message: 'Buscaminas is temporarily unavailable' });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|6379|Database/);
  });
});
