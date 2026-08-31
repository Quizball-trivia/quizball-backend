import { describe, expect, it } from 'vitest';
import {
  parseUtmAttribution,
  utmAttributionProperties,
  type UtmAttribution,
} from '../../src/core/utm-attribution.js';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

const valid = {
  utm_source: 'tiktok',
  utm_medium: 'creator',
  utm_campaign: 'quizball-launch',
  captured_at: '2026-08-30T18:00:00.000Z',
};

describe('parseUtmAttribution', () => {
  it('decodes a well-formed header', () => {
    expect(parseUtmAttribution(encode(valid), NOW)).toEqual(valid);
  });

  it('accepts a source-only payload (medium/campaign optional)', () => {
    const minimal = { utm_source: 'tiktok', captured_at: valid.captured_at };
    expect(parseUtmAttribution(encode(minimal), NOW)).toEqual(minimal);
  });

  it('takes the first value when the header is repeated', () => {
    expect(parseUtmAttribution([encode(valid), encode({ ...valid, utm_source: 'x' })], NOW))
      .toEqual(valid);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not base64/JSON', 'not-a-payload'],
    ['array payload', encode([valid])],
  ])('returns null for a %s header', (_label, raw) => {
    expect(parseUtmAttribution(raw as string | undefined, NOW)).toBeNull();
  });

  it('rejects unknown fields (strict schema)', () => {
    expect(parseUtmAttribution(encode({ ...valid, evil: 'x' }), NOW)).toBeNull();
  });

  it('rejects values with characters that do not belong in a campaign tag', () => {
    expect(parseUtmAttribution(encode({ ...valid, utm_source: 'tik tok' }), NOW)).toBeNull();
    expect(parseUtmAttribution(encode({ ...valid, utm_campaign: '<script>' }), NOW)).toBeNull();
  });

  it('rejects an oversized header without parsing it', () => {
    const huge = encode({ ...valid, utm_campaign: 'a'.repeat(600) });
    expect(parseUtmAttribution(huge, NOW)).toBeNull();
  });

  it('rejects values longer than the per-field cap', () => {
    expect(parseUtmAttribution(encode({ ...valid, utm_source: 'a'.repeat(65) }), NOW)).toBeNull();
  });

  it('rejects a payload older than the 30-day window', () => {
    const stale = { ...valid, captured_at: '2026-07-01T00:00:00.000Z' };
    expect(parseUtmAttribution(encode(stale), NOW)).toBeNull();
  });

  it('rejects a payload captured in the future beyond clock skew', () => {
    const future = { ...valid, captured_at: '2026-08-31T12:30:00.000Z' };
    expect(parseUtmAttribution(encode(future), NOW)).toBeNull();
  });

  it('allows small future skew (client clock slightly ahead)', () => {
    const skewed = { ...valid, captured_at: '2026-08-31T12:02:00.000Z' };
    expect(parseUtmAttribution(encode(skewed), NOW)).toEqual(skewed);
  });
});

describe('utmAttributionProperties', () => {
  it('flattens to PostHog-native utm_* names', () => {
    expect(utmAttributionProperties(valid as UtmAttribution)).toEqual({
      utm_source: 'tiktok',
      utm_medium: 'creator',
      utm_campaign: 'quizball-launch',
      utm_captured_at: valid.captured_at,
    });
  });

  it('omits optional fields that were not captured', () => {
    const minimal = { utm_source: 'tiktok', captured_at: valid.captured_at } as UtmAttribution;
    expect(utmAttributionProperties(minimal)).toEqual({
      utm_source: 'tiktok',
      utm_captured_at: valid.captured_at,
    });
  });
});

describe('authRequestContext carries UTM for the signup path', () => {
  it('includes parsed UTM alongside the client IP', async () => {
    const { authRequestContext } = await import('../../src/http/client-ip.js');
    const req = {
      headers: {
        'x-real-ip': '203.0.113.7',
        'x-quizball-utm': encode(valid),
      },
      socket: {},
    } as never;
    const context = authRequestContext(req);
    expect(context?.utm).toEqual(valid);
  });

  it('returns a context with UTM even when no trusted client IP is present', async () => {
    const { authRequestContext } = await import('../../src/http/client-ip.js');
    const req = { headers: { 'x-quizball-utm': encode(valid) }, socket: {} } as never;
    expect(authRequestContext(req)?.utm).toEqual(valid);
  });

  it('returns undefined when neither IP nor UTM is present', async () => {
    const { authRequestContext } = await import('../../src/http/client-ip.js');
    const req = { headers: {}, socket: {} } as never;
    expect(authRequestContext(req)).toBeUndefined();
  });
});
