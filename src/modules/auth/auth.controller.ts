import type { Request, Response } from 'express';
import { getAuthClient } from './supabase-auth-client.js';
import { authService } from './auth.service.js';
import { config } from '../../core/config.js';
import {
  toAuthResponse,
  type RegisterRequest,
  type LoginRequest,
  type RefreshRequest,
  type ForgotPasswordRequest,
  type ResetPasswordRequest,
  type ResetPasswordHeaders,
  type SocialLoginRequest,
} from './auth.schemas.js';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.NODE_ENV === 'prod',
  sameSite: (config.NODE_ENV === 'prod' ? 'none' : 'lax') as
    | 'lax'
    | 'strict'
    | 'none',
  path: '/',
};

const REFRESH_TOKEN_MAX_AGE_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000; // 7 days

function setAuthCookies(
  res: Response,
  session: { accessToken: string | null; refreshToken: string | null; expiresIn: number | null }
): void {
  if (session.accessToken) {
    res.cookie('qb_access_token', session.accessToken, {
      ...COOKIE_OPTIONS,
      maxAge: (session.expiresIn ?? 3600) * 1000,
    });
  }
  if (session.refreshToken) {
    res.cookie('qb_refresh_token', session.refreshToken, {
      ...COOKIE_OPTIONS,
      maxAge: config.REFRESH_TOKEN_MAX_AGE_MS ?? REFRESH_TOKEN_MAX_AGE_MS_DEFAULT,
    });
  }
}

function clearAuthCookies(res: Response): void {
  res.clearCookie('qb_access_token', COOKIE_OPTIONS);
  res.clearCookie('qb_refresh_token', COOKIE_OPTIONS);
}

/**
 * Auth controller.
 * Translates HTTP ↔ Auth client calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const authController = {
  /**
   * POST /api/v1/auth/register
   * Register new user with email and password.
   */
  async register(req: Request, res: Response): Promise<void> {
    const { email, password } = req.validated.body as RegisterRequest;
    const session = await authService.register({ email, password });

    setAuthCookies(res, session);
    res.status(201).json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/login
   * Sign in with email and password.
   */
  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.validated.body as LoginRequest;
    const session = await authService.login({ email, password });

    setAuthCookies(res, session);
    res.json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/refresh
   * Refresh access token.
   */
  async refresh(req: Request, res: Response): Promise<void> {
    const { refresh_token } = req.validated.body as RefreshRequest;
    const authClient = getAuthClient();

    const session = await authClient.refresh(refresh_token);

    setAuthCookies(res, session);
    res.json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/forgot-password
   * Send password reset email.
   */
  async forgotPassword(req: Request, res: Response): Promise<void> {
    const { email, redirect_to } = req.validated.body as ForgotPasswordRequest;
    const authClient = getAuthClient();

    await authClient.forgotPassword(email, redirect_to);

    res.json({ message: 'Password reset email sent' });
  },

  /**
   * POST /api/v1/auth/reset-password
   * Reset password using access token from Authorization header.
   */
  async resetPassword(req: Request, res: Response): Promise<void> {
    const { authorization } = req.validated.headers as ResetPasswordHeaders;
    // Extract token after "Bearer " (validation ensures format is correct)
    const accessToken = authorization.replace(/^Bearer\s+/i, '');

    const { new_password } = req.validated.body as ResetPasswordRequest;
    const authClient = getAuthClient();

    await authClient.resetPassword(accessToken, new_password);

    res.json({ message: 'Password reset successfully' });
  },

  /**
   * POST /api/v1/auth/social-login
   * Get OAuth authorization URL.
   * Note: Social login is typically done client-side via Supabase SDK.
   */
  async socialLogin(req: Request, res: Response): Promise<void> {
    const { provider, redirect_to, scopes } = req.validated
      .body as SocialLoginRequest;
    const authClient = getAuthClient();

    const url = authClient.oauthAuthorizeUrl(provider, redirect_to, scopes);

    res.json({ url });
  },

  /**
   * POST /api/v1/auth/logout
   * Logout (client-side token deletion).
   * Backend doesn't track sessions - just returns success.
   */
  async logout(_req: Request, res: Response): Promise<void> {
    clearAuthCookies(res);
    res.json({ message: 'Logged out successfully' });
  },
};
