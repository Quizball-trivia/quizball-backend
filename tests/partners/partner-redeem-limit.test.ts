import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRedeemLimiters, REDEEM_LIMITS } from '../../src/http/routes/partner.routes.js';

function app(limits: typeof REDEEM_LIMITS) {
  const a = express();
  a.post('/redeem', ...createRedeemLimiters(limits), (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

describe('Freecroco launch exchange limits', () => {
  it('are 50 per 5 s and 600 per minute per address', () => {
    expect(REDEEM_LIMITS).toEqual({ burst: { windowMs: 5_000, max: 50 }, sustained: { windowMs: 60_000, max: 600 } });
  });

  it('the burst cap answers 429 rate_limited with Retry-After at max + 1', async () => {
    const a = app({ burst: { windowMs: 60_000, max: 3 }, sustained: { windowMs: 60_000, max: 100 } });
    for (let i = 0; i < 3; i += 1) expect((await request(a).post('/redeem')).status).toBe(200);
    const refused = await request(a).post('/redeem');
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(refused.headers['retry-after']).toBe('60');
  });

  it('the sustained cap applies on its own when bursts stay small', async () => {
    const a = app({ burst: { windowMs: 60_000, max: 100 }, sustained: { windowMs: 60_000, max: 5 } });
    for (let i = 0; i < 5; i += 1) expect((await request(a).post('/redeem')).status).toBe(200);
    expect((await request(a).post('/redeem')).status).toBe(429);
  });
});
