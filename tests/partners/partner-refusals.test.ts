import 'express-async-errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const analytics = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../../src/core/analytics.js', () => ({ trackEvent: analytics.trackEvent }));

import { ConflictError } from '../../src/core/errors.js';
import { resetPartnerConfigCache, sha256Hex, type PartnerConfig } from '../../src/modules/partners/partner-config.js';
import { parsePartnerInput, PartnerError, partnerErrorHandler } from '../../src/modules/partners/partner-errors.js';
import { machineRateLimiter, partnerMachineAuth, type BucketStore } from '../../src/modules/partners/partner-machine-auth.js';
import type { PartnerPrincipal } from '../../src/modules/partners/partner-player-auth.js';
import { REFUSAL_EVENTS_PER_MINUTE, resetPartnerRefusalLimit, trackPartnerRefusal } from '../../src/modules/partners/partner-refusals.js';
import { initBodySchema } from '../../src/modules/partners/partner-sessions.service.js';

const KEY = 'k'.repeat(64);
const HERE = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const config = (allowedCidrs: string[]): PartnerConfig => ({
  slug: 'freecroco',
  environment: 'test',
  inboundKeySha256: [sha256Hex(KEY)],
  allowedCidrs,
  launchBaseUrl: 'https://staging-freecroco.quizball.io',
});
const useConfig = (value: PartnerConfig | null) => {
  if (value) process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify(value);
  else delete process.env.PARTNER_FREECROCO_CONFIG;
  resetPartnerConfigCache();
};
const valid = { playerId: 'player-1', language: 'ka', channel: 'WEB', requestId: 'init-1', username: 'Nika' };
const player = { slug: 'freecroco', environment: 'test', userId: '11111111-1111-4111-8111-111111111111' } as PartnerPrincipal;
const events = () => analytics.trackEvent.mock.calls.map(([event, distinctId, properties]) => ({ event, distinctId, ...properties }));
const machineEvent = { event: 'partner_request_refused', distinctId: 'partner:freecroco:test', partner_slug: 'freecroco', partner_environment: 'test', caller: 'machine' };

function app(): express.Express {
  const a = express();
  a.use(express.json({ limit: '64kb' }));
  const openLimiter: BucketStore = { take: async () => [true, 0] };
  const machine = [partnerMachineAuth[0], machineRateLimiter(openLimiter, openLimiter)];
  a.post('/sessions/init', ...machine, (req, res) => { res.json(parsePartnerInput(initBodySchema, req.body)); });
  a.post('/reused', ...machine, () => { throw new PartnerError('request_conflict'); });
  a.post('/blocked', ...machine, () => { throw new PartnerError('player_blocked'); });
  a.post('/machine-crash', ...machine, () => { throw new Error('boom SECRET_DETAIL'); });
  const asPlayer: express.RequestHandler = (req, _res, next) => { req.partner = player; next(); };
  a.post('/games/:gameId/answer', asPlayer, (req, res) => { res.json(parsePartnerInput(initBodySchema, req.body)); });
  a.post('/games/:gameId/move', asPlayer, () => { throw new PartnerError('invalid_request', 'tile: already open'); });
  a.post('/games/:gameId/crash', asPlayer, () => { throw new Error('boom'); });
  a.post('/games/:gameId/shared', asPlayer, () => { throw new ConflictError('already there'); });
  a.post('/sessions/redeem', () => { throw new Error('boom'); });
  a.post('/sessions/sign', () => { throw new PartnerError('maintenance', undefined, 60); });
  a.post('/unsigned', (req, res) => { res.json(parsePartnerInput(initBodySchema, req.body)); });
  a.post('/partner-admin/v1/crash', () => { throw new Error('boom'); });
  a.post('/partner-admin/v1/input', (req, res) => { res.json(parsePartnerInput(initBodySchema, req.body)); });
  a.use(partnerErrorHandler);
  return a;
}

beforeEach(() => {
  analytics.trackEvent.mockClear();
  resetPartnerRefusalLimit();
});
afterEach(() => useConfig(null));

describe("the partner's server", () => {
  it('a known key from an unlisted address is reported; a stranger on an unlisted address is not', async () => {
    useConfig(config(['203.0.113.0/24']));
    expect((await request(app()).post('/sessions/init').set('x-api-key', KEY).send(valid)).status).toBe(403);
    expect((await request(app()).post('/sessions/init').set('x-api-key', 'x'.repeat(64)).send(valid)).status).toBe(403);
    expect((await request(app()).post('/sessions/init').send(valid)).status).toBe(403);
    expect(events()).toEqual([{ ...machineEvent, reason: 'ip_not_allowed', status: 403, route: '/sessions/init' }]);
  });

  it('a wrong or missing key from a listed address is reported', async () => {
    useConfig(config(HERE));
    expect((await request(app()).post('/sessions/init').set('x-api-key', 'SECRET_WRONG_KEY').send(valid)).status).toBe(401);
    expect(events()).toEqual([{ ...machineEvent, reason: 'unknown_key', status: 401, route: '/sessions/init' }]);
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('SECRET');
  });

  it('a refused body names the field and never its content', async () => {
    useConfig(config(HERE));
    const res = await request(app()).post('/sessions/init').set('x-api-key', KEY).send({ ...valid, language: 'SECRET_LANG' });
    expect(res.status).toBe(400);
    expect(events()).toEqual([{ ...machineEvent, reason: 'invalid_request', status: 400, route: '/sessions/init', contentType: 'application/json', field: 'language', issue: 'invalid_enum_value' }]);
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('SECRET');
  });

  it('a reused requestId and our own failure are reported; an ordinary refusal and a good call are not', async () => {
    useConfig(config(HERE));
    expect((await request(app()).post('/reused').set('x-api-key', KEY).send({})).status).toBe(409);
    expect((await request(app()).post('/machine-crash').set('x-api-key', KEY).send({})).status).toBe(500);
    expect((await request(app()).post('/blocked').set('x-api-key', KEY).send({})).status).toBe(403);
    expect((await request(app()).post('/sessions/init').set('x-api-key', KEY).send(valid)).status).toBe(200);
    expect(events()).toEqual([
      { ...machineEvent, reason: 'request_conflict', status: 409, route: '/reused' },
      { ...machineEvent, reason: 'internal_error', status: 500, route: '/machine-crash' },
    ]);
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('SECRET');
  });

  it('being rate limited is reported', async () => {
    useConfig(config(HERE));
    const a = express();
    const full: BucketStore = { take: async () => [false, 2000] };
    a.post('/sessions/init', partnerMachineAuth[0], machineRateLimiter(full, full), (_req, res) => { res.json({}); });
    a.use(partnerErrorHandler);
    expect((await request(a).post('/sessions/init').set('x-api-key', KEY).send(valid)).status).toBe(429);
    expect(events()).toEqual([{ ...machineEvent, reason: 'rate_limited', status: 429, route: '/sessions/init' }]);
  });
});

describe('players and unsigned requests', () => {
  const playerEvent = { event: 'partner_request_refused', distinctId: player.userId, partner_slug: 'freecroco', partner_environment: 'test', caller: 'player' };

  it("a player's malformed request and our failure are reported under the player; a refused move is not", async () => {
    useConfig(config(HERE));
    expect((await request(app()).post('/games/SECRET_GAME/answer').send({ ...valid, channel: 'TV' })).status).toBe(400);
    expect((await request(app()).post('/games/SECRET_GAME/move').send({})).status).toBe(400);
    expect((await request(app()).post('/games/SECRET_GAME/crash').send({})).status).toBe(500);
    expect(events()).toEqual([
      { ...playerEvent, reason: 'invalid_request', status: 400, route: '/games/:gameId/answer', contentType: 'application/json', field: 'channel', issue: 'invalid_enum_value' },
      { ...playerEvent, reason: 'internal_error', status: 500, route: '/games/:gameId/crash' },
    ]);
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('SECRET');
  });

  it("a player's request refused by a shared Quizball rule is not reported", async () => {
    useConfig(config(['203.0.113.0/24']));
    expect((await request(app()).post('/games/x/shared').send({})).status).toBe(400);
    expect(events()).toEqual([]);
  });

  it("an unreadable body is reported when the address or the key is the partner's, and not for a stranger", async () => {
    const broken = (a: express.Express, key?: string) => {
      const r = request(a).post('/sessions/init').set('Content-Type', 'application/json');
      return (key ? r.set('x-api-key', key) : r).send('{"playerId": "SECRET_BODY');
    };
    const unreadable = { ...machineEvent, reason: 'invalid_request', status: 400, contentType: 'application/json', field: 'body', issue: 'entity.parse.failed' };
    useConfig(config(['203.0.113.0/24']));
    expect((await broken(app())).status).toBe(400);
    expect((await broken(app(), 'x'.repeat(64))).status).toBe(400);
    expect(events()).toEqual([]);
    expect((await broken(app(), KEY)).status).toBe(400);
    expect(events()).toEqual([unreadable]);
    useConfig(config(HERE));
    expect((await broken(app())).status).toBe(400);
    expect(events()).toEqual([unreadable, unreadable]);
    expect(JSON.stringify(analytics.trackEvent.mock.calls)).not.toContain('SECRET');
  });

  it('our own failure on an unsigned request is reported under the deploy; a stranger\'s bad request is not', async () => {
    useConfig(config(['203.0.113.0/24']));
    const unsigned = { event: 'partner_request_refused', distinctId: 'partner:freecroco:test', partner_slug: 'freecroco', partner_environment: 'test', caller: 'unknown' };
    expect((await request(app()).post('/unsigned').send({})).status).toBe(400);
    expect(events()).toEqual([]);
    expect((await request(app()).post('/sessions/redeem').send({})).status).toBe(500);
    expect((await request(app()).post('/sessions/sign').send({})).status).toBe(503);
    expect(events()).toEqual([
      { ...unsigned, reason: 'internal_error', status: 500, route: '/sessions/redeem' },
      { ...unsigned, reason: 'maintenance', status: 503, route: '/sessions/sign' },
    ]);
  });

  it('the staff admin API reports nothing, even from a partner address', async () => {
    useConfig(config(HERE));
    expect((await request(app()).post('/partner-admin/v1/crash').set('x-api-key', KEY).send({})).status).toBe(500);
    expect((await request(app()).post('/partner-admin/v1/input').set('x-api-key', KEY).send({})).status).toBe(400);
    expect(events()).toEqual([]);
  });

  it('a deploy without a partner reports nothing', async () => {
    useConfig(null);
    expect((await request(app()).post('/sessions/init').set('x-api-key', KEY).send(valid)).status).toBe(503);
    expect((await request(app()).post('/sessions/redeem').send({})).status).toBe(500);
    expect(events()).toEqual([]);
  });
});

describe('event cap', () => {
  const refusal = { slug: 'freecroco', environment: 'test', reason: 'unknown_key', status: 401, caller: 'machine' as const };
  const sent = async () => { await new Promise((resolve) => setImmediate(resolve)); return analytics.trackEvent.mock.calls.length; };

  it('sends at most the cap in any 60 seconds and says how many were dropped', async () => {
    trackPartnerRefusal(refusal, 1_000);
    for (let i = 1; i < REFUSAL_EVENTS_PER_MINUTE; i += 1) trackPartnerRefusal(refusal, 60_000);
    for (let i = 0; i < 7; i += 1) trackPartnerRefusal(refusal, 60_500);
    expect(await sent()).toBe(REFUSAL_EVENTS_PER_MINUTE);
    // The first event has left the window; the nine sent at 60 s have not, so exactly one more fits.
    trackPartnerRefusal(refusal, 61_000);
    trackPartnerRefusal(refusal, 61_001);
    expect(await sent()).toBe(REFUSAL_EVENTS_PER_MINUTE + 1);
    expect(analytics.trackEvent.mock.calls.at(-1)?.[2]).toMatchObject({ dropped_before: 7 });
    trackPartnerRefusal(refusal, 120_001);
    expect(await sent()).toBe(REFUSAL_EVENTS_PER_MINUTE + 2);
    expect(analytics.trackEvent.mock.calls.at(-1)?.[2]).toMatchObject({ dropped_before: 1 });
  });

  it('nothing is sent before the caller has its answer, and a failing analytics client never reaches the caller', async () => {
    analytics.trackEvent.mockImplementationOnce(() => { throw new Error('posthog down'); });
    expect(() => trackPartnerRefusal(refusal, 1_000)).not.toThrow();
    expect(analytics.trackEvent).not.toHaveBeenCalled();
    expect(await sent()).toBe(1);
  });
});
