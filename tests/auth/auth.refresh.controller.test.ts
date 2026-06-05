import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { authController } from '../../src/modules/auth/auth.controller.js';
import { AuthenticationError, BadRequestError } from '../../src/core/errors.js';

vi.mock('../../src/modules/auth/supabase-auth-client.js', () => ({
  getAuthClient: vi.fn(),
}));

vi.mock('../../src/modules/auth/auth.service.js', () => ({
  authService: {
    ensureSessionAccountActive: vi.fn(),
    restorePendingDeletionWithRefreshToken: vi.fn(),
    restorePendingDeletionWithLogin: vi.fn(),
  },
}));

import { getAuthClient } from '../../src/modules/auth/supabase-auth-client.js';
import { authService } from '../../src/modules/auth/auth.service.js';

function mockResponse(): Response {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.cookie = vi.fn().mockReturnValue(res);
  res.clearCookie = vi.fn().mockReturnValue(res);
  return res;
}

function makeRequest(over: Partial<Request> = {}): Request {
  return {
    headers: {},
    cookies: {},
    validated: { body: {} },
    ...over,
  } as unknown as Request;
}

function clearedCookieNames(res: Response): string[] {
  return (res.clearCookie as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
}

describe('authController.refresh — cookie clearing on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears both auth cookies and throws BadRequestError when no refresh token is present', async () => {
    const res = mockResponse();
    const req = makeRequest({ cookies: {}, validated: { body: {} } as Request['validated'] });

    await expect(authController.refresh(req, res)).rejects.toBeInstanceOf(BadRequestError);

    const cleared = clearedCookieNames(res);
    expect(cleared).toContain('qb_access_token');
    expect(cleared).toContain('qb_refresh_token');
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('clears both auth cookies when authClient.refresh rejects with a 400 (bad token)', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new BadRequestError('Invalid Refresh Token'));
    (getAuthClient as ReturnType<typeof vi.fn>).mockReturnValue({ refresh: refreshFn });

    const res = mockResponse();
    const req = makeRequest({
      cookies: { qb_refresh_token: 'dead-token' },
      validated: { body: {} } as Request['validated'],
    });

    await expect(authController.refresh(req, res)).rejects.toBeInstanceOf(BadRequestError);

    const cleared = clearedCookieNames(res);
    expect(cleared).toContain('qb_access_token');
    expect(cleared).toContain('qb_refresh_token');
  });

  it('clears both auth cookies when ensureSessionAccountActive rejects (401 banned/deleted)', async () => {
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: 'a',
      refreshToken: 'r',
      expiresIn: 3600,
      user: { providerSub: 'sub' },
    });
    (getAuthClient as ReturnType<typeof vi.fn>).mockReturnValue({ refresh: refreshFn });
    (authService.ensureSessionAccountActive as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AuthenticationError('Account is no longer active')
    );

    const res = mockResponse();
    const req = makeRequest({
      validated: { body: { refresh_token: 'valid-but-banned' } } as Request['validated'],
    });

    await expect(authController.refresh(req, res)).rejects.toBeInstanceOf(AuthenticationError);

    const cleared = clearedCookieNames(res);
    expect(cleared).toContain('qb_access_token');
    expect(cleared).toContain('qb_refresh_token');
    // Should not have set new cookies on a failed refresh.
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('keeps only the rotated refresh cookie when refresh proves a pending-deletion account', async () => {
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: 'pending-access',
      refreshToken: 'rotated-refresh',
      expiresIn: 3600,
      tokenType: 'bearer',
      user: { email: 'a@b.com', phone: null, phoneConfirmedAt: null, providerSub: 'sub' },
      provider: 'supabase',
    });
    (getAuthClient as ReturnType<typeof vi.fn>).mockReturnValue({ refresh: refreshFn });
    (authService.ensureSessionAccountActive as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AuthenticationError('Account is scheduled for deletion', { reason: 'pending_deletion' })
    );

    const res = mockResponse();
    const req = makeRequest({
      validated: { body: { refresh_token: 'oauth-refresh' } } as Request['validated'],
    });

    await expect(authController.refresh(req, res)).rejects.toBeInstanceOf(AuthenticationError);

    const cleared = clearedCookieNames(res);
    expect(cleared).toContain('qb_access_token');
    expect(cleared).not.toContain('qb_refresh_token');
    expect(res.cookie).toHaveBeenCalledWith('qb_refresh_token', 'rotated-refresh', expect.any(Object));
  });

  it('sets cookies and does NOT clear them on a successful refresh', async () => {
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
      tokenType: 'bearer',
      user: { email: 'a@b.com', phone: null, phoneConfirmedAt: null, providerSub: 'sub' },
      provider: 'email',
    });
    (getAuthClient as ReturnType<typeof vi.fn>).mockReturnValue({ refresh: refreshFn });
    (authService.ensureSessionAccountActive as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = mockResponse();
    const req = makeRequest({
      cookies: { qb_refresh_token: 'good-token' },
      validated: { body: {} } as Request['validated'],
    });

    await authController.refresh(req, res);

    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalled();
  });
});

describe('authController pending deletion restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores by refresh token, sets auth cookies, and returns auth response', async () => {
    (authService.restorePendingDeletionWithRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: 'restored-access',
      refreshToken: 'restored-refresh',
      expiresIn: 3600,
      tokenType: 'bearer',
      provider: 'supabase',
      user: { email: 'a@b.com', phone: null, phoneConfirmedAt: null, providerSub: 'sub' },
    });

    const res = mockResponse();
    const req = makeRequest({
      validated: { body: { refresh_token: 'oauth-refresh' } } as Request['validated'],
    });

    await authController.restorePendingDeletion(req, res);

    expect(authService.restorePendingDeletionWithRefreshToken).toHaveBeenCalledWith('oauth-refresh');
    expect(res.clearCookie).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith('qb_access_token', 'restored-access', expect.any(Object));
    expect(res.cookie).toHaveBeenCalledWith('qb_refresh_token', 'restored-refresh', expect.any(Object));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      access_token: 'restored-access',
      refresh_token: 'restored-refresh',
    }));
  });

  it('clears auth cookies when restore by refresh token fails', async () => {
    (authService.restorePendingDeletionWithRefreshToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new AuthenticationError('Account is scheduled for deletion', { reason: 'pending_deletion' })
    );

    const res = mockResponse();
    const req = makeRequest({
      validated: { body: { refresh_token: 'bad-refresh' } } as Request['validated'],
    });

    await expect(authController.restorePendingDeletion(req, res)).rejects.toBeInstanceOf(AuthenticationError);

    const cleared = clearedCookieNames(res);
    expect(cleared).toContain('qb_access_token');
    expect(cleared).toContain('qb_refresh_token');
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('restores by email/password proof', async () => {
    (authService.restorePendingDeletionWithLogin as ReturnType<typeof vi.fn>).mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
      tokenType: 'bearer',
      provider: 'supabase',
      user: { email: 'a@b.com', phone: null, phoneConfirmedAt: null, providerSub: 'sub' },
    });

    const res = mockResponse();
    const req = makeRequest({
      validated: { body: { email: 'a@b.com', password: 'secret' } } as Request['validated'],
    });

    await authController.restorePendingDeletionLogin(req, res);

    expect(authService.restorePendingDeletionWithLogin).toHaveBeenCalledWith({
      email: 'a@b.com',
      password: 'secret',
    });
    expect(res.cookie).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      access_token: 'access',
      refresh_token: 'refresh',
    }));
  });
});
