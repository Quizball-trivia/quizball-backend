import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trackEventMock = vi.fn();

vi.mock('../../src/core/analytics.js', () => ({
  trackEvent: (...args: unknown[]) => trackEventMock(...args),
}));

const { analyticsMiddleware } = await import('../../src/http/middleware/analytics.middleware.js');

function runMiddleware(options: {
  path?: string;
  userId?: string;
  trackEnv?: string;
  legacyTrackEnv?: string;
}) {
  if (options.trackEnv === undefined) delete process.env.POSTHOG_TRACK_API_REQUESTS;
  else process.env.POSTHOG_TRACK_API_REQUESTS = options.trackEnv;

  if (options.legacyTrackEnv === undefined) delete process.env.POSTHOG_TRACK_DEV;
  else process.env.POSTHOG_TRACK_DEV = options.legacyTrackEnv;

  const req = {
    method: 'GET',
    path: options.path ?? '/api/v1/users/me',
    ip: '127.0.0.1',
    user: options.userId ? { id: options.userId } : undefined,
    get: vi.fn((header: string) => (header === 'user-agent' ? 'vitest' : undefined)),
  } as unknown as Request;
  const res = new EventEmitter() as Response & EventEmitter;
  const next = vi.fn() as NextFunction;

  analyticsMiddleware(req, res, next);
  res.emit('finish');

  expect(next).toHaveBeenCalledTimes(1);
}

describe('analyticsMiddleware', () => {
  const originalTrackApiRequests = process.env.POSTHOG_TRACK_API_REQUESTS;
  const originalTrackDev = process.env.POSTHOG_TRACK_DEV;

  beforeEach(() => {
    trackEventMock.mockClear();
    delete process.env.POSTHOG_TRACK_API_REQUESTS;
    delete process.env.POSTHOG_TRACK_DEV;
  });

  afterEach(() => {
    if (originalTrackApiRequests === undefined) delete process.env.POSTHOG_TRACK_API_REQUESTS;
    else process.env.POSTHOG_TRACK_API_REQUESTS = originalTrackApiRequests;

    if (originalTrackDev === undefined) delete process.env.POSTHOG_TRACK_DEV;
    else process.env.POSTHOG_TRACK_DEV = originalTrackDev;
  });

  it('does not track api_request by default', () => {
    runMiddleware({ userId: 'user-1' });

    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('treats POSTHOG_TRACK_DEV=false as disabled', () => {
    runMiddleware({ userId: 'user-1', legacyTrackEnv: 'false' });

    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('tracks authenticated api_request only when explicitly enabled', () => {
    runMiddleware({ userId: 'user-1', trackEnv: 'true' });

    expect(trackEventMock).toHaveBeenCalledWith(
      'api_request',
      'user-1',
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/users/me',
        status_code: undefined,
      }),
    );
  });

  it('does not create anonymous api_request persons', () => {
    runMiddleware({ trackEnv: 'true' });

    expect(trackEventMock).not.toHaveBeenCalled();
  });

  it('keeps skipping health checks', () => {
    runMiddleware({ path: '/health', userId: 'user-1', trackEnv: 'true' });

    expect(trackEventMock).not.toHaveBeenCalled();
  });
});
