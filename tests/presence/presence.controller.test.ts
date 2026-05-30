import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import '../setup.js';

const recordPingMock = vi.fn();
const getOnlineCountMock = vi.fn();

vi.mock('../../src/realtime/presence-ping.service.js', () => ({
  recordPing: (...args: unknown[]) => recordPingMock(...args),
  getOnlineCount: (...args: unknown[]) => getOnlineCountMock(...args),
}));

import { presenceController } from '../../src/modules/presence/presence.controller.js';

function createReq(cookies: Record<string, string> = {}): Request {
  return { cookies, headers: {} } as unknown as Request;
}

function createRes(): Response & { _json: unknown; _cookies: Record<string, unknown> } {
  const res = {
    _json: undefined as unknown,
    _cookies: {} as Record<string, unknown>,
    json(payload: unknown) {
      this._json = payload;
      return this;
    },
    cookie(name: string, value: string, options: unknown) {
      this._cookies[name] = { value, options };
      return this;
    },
  };
  return res as unknown as Response & { _json: unknown; _cookies: Record<string, unknown> };
}

describe('presenceController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOnlineCountMock.mockResolvedValue(42);
    recordPingMock.mockResolvedValue(undefined);
  });

  it('issues a qb_presence_id cookie on first ping and records the anon member', async () => {
    const req = createReq();
    const res = createRes();

    await presenceController.ping(req, res);

    const cookie = res._cookies['qb_presence_id'] as { value: string; options: { httpOnly: boolean } };
    expect(cookie).toBeDefined();
    expect(cookie.options.httpOnly).toBe(true);
    expect(recordPingMock).toHaveBeenCalledWith(`anon:${cookie.value}`, expect.any(Number));
    expect(res._json).toEqual({ online: 42 });
  });

  it('reuses an existing cookie (no new cookie set)', async () => {
    const req = createReq({ qb_presence_id: 'existing-id' });
    const res = createRes();

    await presenceController.ping(req, res);

    expect(res._cookies['qb_presence_id']).toBeUndefined();
    expect(recordPingMock).toHaveBeenCalledWith('anon:existing-id', expect.any(Number));
  });

  it('counts every visitor by cookie regardless of auth (no token verification)', async () => {
    // Even with an Authorization header present, the ping path must not verify it
    // (that would hit Supabase introspection every 30s). It only uses the cookie.
    const req = { cookies: { qb_presence_id: 'cookie-1' }, headers: { authorization: 'Bearer whatever' } } as unknown as Request;
    const res = createRes();

    await presenceController.ping(req, res);

    expect(recordPingMock).toHaveBeenCalledWith('anon:cookie-1', expect.any(Number));
  });

  it('GET /online returns the count without recording a ping', async () => {
    getOnlineCountMock.mockResolvedValue(7);
    const req = createReq();
    const res = createRes();

    await presenceController.online(req, res);

    expect(recordPingMock).not.toHaveBeenCalled();
    expect(res._json).toEqual({ online: 7 });
  });
});
