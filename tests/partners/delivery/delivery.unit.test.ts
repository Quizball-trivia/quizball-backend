import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/db/index.js', () => ({ sql: {} }));

const {
  attemptClassification, classifyError, destinationId, isPermanentStatus, parseRetryAfter, retryDelayMs, settleDecision, BACKOFF_CAP_MS,
} = await import('../../../src/modules/partners/delivery/dispatcher.js');
const { scoreEventBody } = await import('../../../src/modules/partners/delivery/score-events.js');
const { decodeDeliveriesCursor, encodeDeliveriesCursor } = await import('../../../src/modules/partners/delivery/deliveries.js');
const worker = await import('../../../src/modules/partners/delivery/worker.js');
const { resetPartnerConfigCache } = await import('../../../src/modules/partners/partner-config.js');

describe('partner score delivery helpers', () => {
  afterEach(() => {
    delete process.env.PARTNER_FREECROCO_CONFIG;
    resetPartnerConfigCache();
  });

  it('backs off exponentially with equal jitter, capped', () => {
    expect(retryDelayMs(1, () => 0)).toBe(5_000);
    expect(retryDelayMs(1, () => 1)).toBe(10_000);
    expect(retryDelayMs(3, () => 0)).toBe(20_000);
    expect(retryDelayMs(40, () => 1)).toBe(BACKOFF_CAP_MS);
  });

  it('reads Retry-After as seconds, or an HTTP date kept absolute', () => {
    expect(parseRetryAfter('30')).toEqual({ delayMs: 30_000 });
    expect(parseRetryAfter('Wed, 07 Oct 2026 12:01:00 GMT')).toEqual({ at: Date.parse('2026-10-07T12:01:00Z') });
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it('retries 408, 429 and 5xx; every other 4xx is final', () => {
    for (const s of [408, 429, 500, 502, 503, 504]) expect(isPermanentStatus(s)).toBe(false);
    for (const s of [400, 401, 403, 404, 409, 410, 422]) expect(isPermanentStatus(s)).toBe(true);
    expect(isPermanentStatus(302)).toBe(false);
  });

  it('classifies network failures', () => {
    const stop = new Error('stop');
    expect(classifyError(stop, stop)).toBe('aborted');
    expect(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe('refused');
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe('dns');
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe('reset');
    expect(classifyError(new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }))).toBe('tls');
    expect(classifyError(new Error('?'))).toBe('network');
  });

  it('records attempts by our own classification only', () => {
    expect(attemptClassification({ kind: 'answered', status: 200 })).toBeNull();
    expect(attemptClassification({ kind: 'answered', status: 204 })).toBeNull();
    expect(attemptClassification({ kind: 'answered', status: 409 })).toBe('dead_conflict');
    expect(attemptClassification({ kind: 'answered', status: 503 })).toBe('http_503');
    expect(attemptClassification({ kind: 'answered', status: 302 })).toBe('http_302');
    expect(attemptClassification({ kind: 'failed', error: 'tls' })).toBe('tls');
  });

  it('settles strictly before the deadline, never sooner than Retry-After', () => {
    const base = {
      delivered: false, permanent: false, aborted: false, now: 0, windowEnd: 100_000, delayMs: 10_000,
      retryAfter: null as null | { delayMs: number } | { at: number }, marginMs: 5_000,
    };
    expect(settleDecision({ ...base, delivered: true })).toEqual({ status: 'sent', next: null });
    expect(settleDecision({ ...base, permanent: true })).toEqual({ status: 'dead', next: null });
    expect(settleDecision(base)).toEqual({ status: 'pending', next: new Date(10_000) });
    expect(settleDecision({ ...base, now: 90_000 })).toEqual({ status: 'pending', next: new Date(95_000) });
    expect(settleDecision({ ...base, now: 96_000 })).toEqual({ status: 'dead', next: null });
    expect(settleDecision({ ...base, now: 96_000, retryAfter: { delayMs: 2_000 } })).toEqual({ status: 'pending', next: new Date(98_000) });
    expect(settleDecision({ ...base, now: 90_000, retryAfter: { delayMs: 10_000 } })).toEqual({ status: 'dead', next: null });
    expect(settleDecision({ ...base, retryAfter: { delayMs: 50_000 } })).toEqual({ status: 'pending', next: new Date(50_000) });
    // An HTTP date is absolute: compared with the database's now, whatever this replica's clock says.
    expect(settleDecision({ ...base, now: 40_000, retryAfter: { at: 70_000 } })).toEqual({ status: 'pending', next: new Date(70_000) });
    expect(settleDecision({ ...base, now: 40_000, retryAfter: { at: 10_000 } })).toEqual({ status: 'pending', next: new Date(50_000) });
    expect(settleDecision({ ...base, now: 40_000, retryAfter: { at: 100_000 } })).toEqual({ status: 'dead', next: null });
    expect(settleDecision({ ...base, aborted: true, now: 99_000 })).toEqual({ status: 'pending', next: new Date(99_000) });
    expect(settleDecision({ ...base, aborted: true, now: 100_000 })).toEqual({ status: 'dead', next: null });
  });

  it('binds events to the destination origin plus a hash, never the URL itself', () => {
    const id = destinationId('https://partner.example/v1/hook?token=secret-token');
    expect(id).toMatch(/^https:\/\/partner\.example#[0-9a-f]{16}$/);
    expect(id).not.toContain('secret-token');
    expect(destinationId('https://partner.example/v2/hook')).not.toBe(id);
  });

  it('builds the wire body in the contract field order from the stored payload', () => {
    const body = scoreEventBody({
      score: 150, occurredAt: '2026-10-07T12:08:00.000Z', gameId: 'ranked', playerId: 'player-123',
      sessionId: 'c1f0e6b2-3c55-4a51-9a3e-6a7f2b0d9e41', eventId: 'qb_8a1d5c1e-4b6f-4f7a-9d1b-2e3f4a5b6c7d',
    });
    expect(JSON.stringify(body)).toBe(
      '{"eventId":"qb_8a1d5c1e-4b6f-4f7a-9d1b-2e3f4a5b6c7d","sessionId":"c1f0e6b2-3c55-4a51-9a3e-6a7f2b0d9e41",'
      + '"playerId":"player-123","gameId":"ranked","occurredAt":"2026-10-07T12:08:00.000Z","score":150}',
    );
  });

  it('round-trips cursors and rejects foreign ones', () => {
    expect(decodeDeliveriesCursor(encodeDeliveriesCursor('42'))).toBe('42');
    expect(decodeDeliveriesCursor('bogus!')).toBeNull();
    expect(decodeDeliveriesCursor(Buffer.from('v2.42').toString('base64url'))).toBeNull();
    expect(decodeDeliveriesCursor(Buffer.from('v1.-1').toString('base64url'))).toBeNull();
    expect(decodeDeliveriesCursor(Buffer.from('v1.99999999999999999999').toString('base64url'))).toBeNull();
  });

  it('the worker stays idle without a configured webhook and survives an invalid config', async () => {
    expect(worker.freecrocoDestination()).toBeNull();
    worker.startPartnerDeliveryWorker();
    worker.wakePartnerDelivery();
    await worker.stopPartnerDeliveryWorker();

    resetPartnerConfigCache();
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco', environment: 'test', inboundKeySha256: ['a'.repeat(64)], launchBaseUrl: 'https://example.test',
    });
    expect(worker.freecrocoDestination()).toBeNull();

    resetPartnerConfigCache();
    const { logger } = await import('../../../src/core/logger.js');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    process.env.PARTNER_FREECROCO_CONFIG = '{"webhook":{"apiKey":Kx7sEcretFragment9}}';
    expect(() => worker.startPartnerDeliveryWorker()).not.toThrow();
    await worker.stopPartnerDeliveryWorker();
    resetPartnerConfigCache();
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({ slug: 'freecroco', environment: 'test',
      inboundKeySha256: ['nothex'], launchBaseUrl: 'x', webhook: { url: 'http://h', apiKey: 'Kx7sEcretFragment9' } });
    worker.startPartnerDeliveryWorker();
    expect(logged).toHaveBeenCalledTimes(2);
    const [[first], [second]] = logged.mock.calls as unknown as [[Record<string, unknown>], [Record<string, unknown>]];
    expect(first).toEqual({ code: 'partner_config_invalid', issues: [{ path: '', code: 'invalid_json' }] });
    expect(second.code).toBe('partner_config_invalid');
    expect(second.issues).toEqual(expect.arrayContaining([
      { path: 'inboundKeySha256.0', code: 'invalid_string' },
      { path: 'webhook.url', code: 'invalid_string' },
    ]));
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Kx7sEcret|nothex|http:\/\/h/);
    logged.mockRestore();

    resetPartnerConfigCache();
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco', environment: 'production', inboundKeySha256: ['a'.repeat(64)],
      launchBaseUrl: 'https://example.test',
      webhook: { url: 'https://partner.example/v1/integrations/quizball/score-events', apiKey: 'x'.repeat(32) },
    });
    expect(worker.freecrocoDestination()).toEqual({
      slug: 'freecroco', environment: 'production',
      url: 'https://partner.example/v1/integrations/quizball/score-events', apiKey: 'x'.repeat(32),
    });
  });
});
