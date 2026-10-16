import { describe, expect, it } from 'vitest';
import { parseClientPlatform } from '../../src/core/client-platform.js';
import { authRequestContext } from '../../src/http/client-ip.js';
import type { Request } from 'express';

describe('analytics-only signup platform declaration', () => {
  it.each(['web', 'android', 'ios'] as const)('accepts exactly %s', platform => {
    expect(parseClientPlatform(platform)).toBe(platform);
  });
  it.each([undefined, null, '', 'Android', 'mobile', 'android,ios', ['android'], '<script>', 'unknown'])('keeps malformed/missing input unknown: %j', raw => {
    expect(parseClientPlatform(raw)).toBe('unknown');
  });
  it('does not infer native signup from user agent, provider, or current browser origin', () => {
    const context = authRequestContext({ headers: { 'user-agent': 'iPhone', origin: 'https://quizball.io' }, socket: {} } as Pick<Request, 'headers' | 'socket'>);
    expect(context?.clientPlatform).toBeUndefined();
  });
  it.each(['web', 'android', 'ios'] as const)('carries %s into the auth context without any IP', platform => {
    const context = authRequestContext({ headers: { 'x-quizball-platform': platform }, socket: {} } as Pick<Request, 'headers' | 'socket'>);
    expect(context).toEqual({ clientPlatform: platform });
  });
});
