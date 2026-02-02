import type { Request, Response } from 'express';
import { getAuthClient } from './supabase-auth-client.js';
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
import { usersService } from '../users/index.js';

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
    const authClient = getAuthClient();

    const session = await authClient.signUp(email, password);
    if (session.user?.providerSub) {
      await usersService.getOrCreateFromIdentity({
        provider: session.provider,
        subject: session.user.providerSub,
        email: session.user.email ?? undefined,
        claims: {},
      });
    }

    res.status(201).json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/login
   * Sign in with email and password.
   */
  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.validated.body as LoginRequest;
    const authClient = getAuthClient();

    const session = await authClient.signIn(email, password);

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
    res.json({ message: 'Logged out successfully' });
  },
};
