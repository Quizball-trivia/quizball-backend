import { describe, expect, it } from 'vitest';
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
