import { describe, expect, it } from 'vitest';
import { authRequestContext } from '../../src/http/client-ip.js';
import { CAMPAIGN_ATTRIBUTION_HEADER } from '../../src/core/campaign-attribution.js';
import type { Request } from 'express';
import { normalizeClientIp, resolveTrustedClientIp } from '../../src/http/client-ip.js';

function request(input: {
  headers?: Request['headers'];
  remoteAddress?: string;
}): Pick<Request, 'headers' | 'socket'> {
  return {
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress } as Request['socket'],
  };
}

describe('trusted client IP resolution', () => {
  it('uses Railway X-Real-IP outside local', () => {
    const req = request({
      headers: {
        'x-real-ip': '203.0.113.42',
        'x-forwarded-for': '198.51.100.99',
      },
      remoteAddress: '100.64.0.2',
    });

    expect(resolveTrustedClientIp(req, 'staging')).toBe('203.0.113.42');
  });

  it('never trusts X-Forwarded-For outside local', () => {
    const req = request({
      headers: { 'x-forwarded-for': '198.51.100.99' },
      remoteAddress: '100.64.0.2',
    });

    expect(resolveTrustedClientIp(req, 'staging')).toBeUndefined();
  });

  it('uses only the direct socket peer as the local fallback', () => {
    const req = request({
      headers: { 'x-forwarded-for': '198.51.100.99' },
      remoteAddress: '::ffff:127.0.0.1',
    });

    expect(resolveTrustedClientIp(req, 'local')).toBe('127.0.0.1');
  });

  it('ignores X-Real-IP in local mode where no trusted edge exists', () => {
    const req = request({
      headers: { 'x-real-ip': '203.0.113.42' },
      remoteAddress: '::ffff:127.0.0.1',
    });

    expect(resolveTrustedClientIp(req, 'local')).toBe('127.0.0.1');
  });

  it('rejects lists and non-IP values', () => {
    expect(normalizeClientIp('203.0.113.1, 198.51.100.2')).toBeUndefined();
    expect(normalizeClientIp('not-an-ip')).toBeUndefined();
  });
});


describe('authRequestContext attribution threading', () => {
  const campaignPayload = () => Buffer.from(JSON.stringify({
    source: 'campaign_quiz',
    quiz_slug: 'coventry-city',
    cta_placement: 'score',
    captured_at: new Date().toISOString(),
    campaign_conversion_id: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
  })).toString('base64url');

  it('parses the campaign attribution header on auth routes', () => {
    // The auth routes win the user INSERT for brand-new accounts (the
    // /users/me middleware only sees existing accounts), so dropping the
    // campaign header here made "accounts created by quiz" permanently zero:
    // 0 of 1,026 accounts carried source=campaign_quiz in the 30 days to
    // 2026-09-04 despite the client sending the header.
    const ctx = authRequestContext({
      headers: { 'x-real-ip': '203.0.113.9', [CAMPAIGN_ATTRIBUTION_HEADER]: campaignPayload() },
      socket: { remoteAddress: '10.0.0.1' },
    } as never);
    expect(ctx?.campaign?.quiz_slug).toBe('coventry-city');
    expect(ctx?.campaign?.source).toBe('campaign_quiz');
  });

  it('returns a context with campaign attribution even without a client IP', () => {
    const ctx = authRequestContext({
      headers: { [CAMPAIGN_ATTRIBUTION_HEADER]: campaignPayload() },
      socket: {},
    } as never);
    expect(ctx?.campaign?.quiz_slug).toBe('coventry-city');
  });

  it('ignores malformed campaign headers', () => {
    const ctx = authRequestContext({
      headers: { 'x-real-ip': '203.0.113.9', [CAMPAIGN_ATTRIBUTION_HEADER]: 'not-base64-json' },
      socket: {},
    } as never);
    expect(ctx?.campaign ?? null).toBeNull();
  });
});
