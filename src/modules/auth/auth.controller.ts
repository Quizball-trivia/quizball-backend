import type { Request, Response } from 'express';
import { Webhook } from 'standardwebhooks';
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
  type SocialLoginTokenRequest,
  type GeorgianPhoneOtpStartRequest,
  type GeorgianPhoneOtpVerifyRequest,
  type GeorgianPhoneLinkStartRequest,
  type GeorgianPhoneLinkVerifyRequest,
  type SupabaseSmsHookHeaders,
  type SupabaseSmsHookRequest,
  type SmsOfficeCallbackQuery,
  type SmsOfficeStatusHeaders,
  type SmsOfficeStatusQuery,
} from './auth.schemas.js';
import { toUserResponse } from '../users/users.schemas.js';
import { AuthenticationError, BadRequestError } from '../../core/errors.js';
import { detectCountryFromRequest } from '../../core/geo.js';

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

function getAccessTokenFromRequest(req: Request): string {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string') {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }

  const cookieToken = typeof req.cookies?.qb_access_token === 'string'
    ? req.cookies.qb_access_token.trim()
    : '';
  if (cookieToken) {
    return cookieToken;
  }

  throw new AuthenticationError('Missing auth token');
}

function assertSmsOfficeStatusAuthorization(authorization: string | undefined): void {
  if (!config.SUPABASE_SMS_HOOK_SECRET) {
    return;
  }
  const expected = `Bearer ${config.SUPABASE_SMS_HOOK_SECRET}`;
  if (authorization !== expected) {
    throw new AuthenticationError('Invalid SMSOffice status authorization');
  }
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function verifySupabaseSignedWebhook(req: Request): void {
  if (!config.SUPABASE_SMS_HOOK_SECRET) {
    return;
  }

  const secret = config.SUPABASE_SMS_HOOK_SECRET.replace(/^v1,whsec_/, '');
  const payload = req.rawBody;
  if (!payload) {
    throw new AuthenticationError('Missing signed webhook payload');
  }

  const webhookId = getHeaderValue(req.headers['webhook-id']);
  const webhookTimestamp = getHeaderValue(req.headers['webhook-timestamp']);
  const webhookSignature = getHeaderValue(req.headers['webhook-signature']);

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new AuthenticationError('Missing SMS hook signature headers');
  }

  try {
    new Webhook(secret).verify(payload, {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': webhookSignature,
    });
  } catch {
    throw new AuthenticationError('Invalid SMS hook signature');
  }
}

function assertSupabaseSmsHookAuthorization(req: Request, authorization: string | undefined): void {
  if (!config.SUPABASE_SMS_HOOK_SECRET) {
    return;
  }

  if (config.SUPABASE_SMS_HOOK_SECRET.startsWith('v1,whsec_')) {
    verifySupabaseSignedWebhook(req);
    return;
  }

  const expected = `Bearer ${config.SUPABASE_SMS_HOOK_SECRET}`;
  if (authorization !== expected) {
    throw new AuthenticationError('Invalid SMS hook authorization');
  }
}

/**
 * Auth controller.
 * Translates HTTP ↔ Auth client calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const authController = {
  /**
   * GET /api/v1/auth/phone/ge/availability
   * Public feature check for Georgian phone auth visibility.
   */
  async georgianPhoneAvailability(req: Request, res: Response): Promise<void> {
    const country = await detectCountryFromRequest(req);
    res.json({
      country,
      phone_auth_available: country === 'GE',
    });
  },

  /**
   * POST /api/v1/auth/register
   * Register new user with email and password.
   */
  async register(req: Request, res: Response): Promise<void> {
    const { email, password, redirect_to, locale } = req.validated.body as RegisterRequest;
    const session = await authService.register({ email, password, redirect_to, locale });

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
    const { refresh_token } = (req.validated.body ?? {}) as RefreshRequest;
    const authClient = getAuthClient();

    const cookieToken =
      typeof req.cookies?.qb_refresh_token === 'string'
        ? req.cookies.qb_refresh_token.trim()
        : null;
    const refreshToken = refresh_token ?? cookieToken ?? null;
    if (!refreshToken) {
      throw new BadRequestError('Missing refresh token');
    }

    const session = await authClient.refresh(refreshToken);
    await authService.ensureSessionAccountActive(session);

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

  // POST /api/v1/auth/social-login-token — exchange GIS id_token for a Supabase session.
  async socialLoginToken(req: Request, res: Response): Promise<void> {
    const { provider, id_token, nonce } = req.validated
      .body as SocialLoginTokenRequest;
    const session = await authService.socialLoginToken({ provider, id_token, nonce });

    setAuthCookies(res, session);
    res.json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/phone/ge/start
   * Start passwordless auth for Georgian mobile numbers.
   */
  async startGeorgianPhoneOtp(req: Request, res: Response): Promise<void> {
    const { phone } = req.validated.body as GeorgianPhoneOtpStartRequest;
    await authService.startGeorgianPhoneOtp(phone);

    res.json({ message: 'Verification code sent' });
  },

  /**
   * POST /api/v1/auth/phone/ge/verify
   * Verify Georgian phone OTP and issue a Supabase session.
   */
  async verifyGeorgianPhoneOtp(req: Request, res: Response): Promise<void> {
    const { phone, token } = req.validated.body as GeorgianPhoneOtpVerifyRequest;
    const session = await authService.verifyGeorgianPhoneOtp(phone, token);

    setAuthCookies(res, session);
    res.json(toAuthResponse(session));
  },

  /**
   * POST /api/v1/auth/phone/ge/link/start
   * Start adding/changing a Georgian phone number on the current account.
   */
  async startGeorgianPhoneLink(req: Request, res: Response): Promise<void> {
    const { phone } = req.validated.body as GeorgianPhoneLinkStartRequest;
    const accessToken = getAccessTokenFromRequest(req);
    const result = await authService.startGeorgianPhoneLink(req.user!.id, accessToken, phone);

    res.json(result);
  },

  /**
   * POST /api/v1/auth/phone/ge/link/verify
   * Verify adding/changing a Georgian phone number on the current account.
   */
  async verifyGeorgianPhoneLink(req: Request, res: Response): Promise<void> {
    const { phone, token } = req.validated.body as GeorgianPhoneLinkVerifyRequest;
    const accessToken = getAccessTokenFromRequest(req);
    const { session, user } = await authService.verifyGeorgianPhoneLink(
      req.user!.id,
      accessToken,
      phone,
      token,
    );

    setAuthCookies(res, session);
    res.json(toUserResponse(user));
  },

  /**
   * POST /api/v1/auth/sms/supabase-hook
   * Supabase Send SMS hook. Sends only Georgian numbers through SMSOffice.
   */
  async supabaseSmsHook(req: Request, res: Response): Promise<void> {
    const { authorization } = (req.validated.headers ?? {}) as SupabaseSmsHookHeaders;
    assertSupabaseSmsHookAuthorization(req, authorization);

    await authService.sendSupabaseSmsHook(req.validated.body as SupabaseSmsHookRequest);
    res.json({ message: 'SMS sent' });
  },

  /**
   * GET /api/v1/auth/sms/smsoffice-callback
   * SMSOffice delivery status callback. SMSOffice expects a plain `OK`.
   */
  async smsOfficeCallback(req: Request, res: Response): Promise<void> {
    await authService.handleSmsOfficeCallback(req.validated.query as SmsOfficeCallbackQuery);
    res.type('text/plain').send('OK');
  },

  /**
   * GET /api/v1/auth/sms/smsoffice-status
   * Manual status polling for a sent SMSOffice reference.
   */
  async smsOfficeStatus(req: Request, res: Response): Promise<void> {
    const { authorization } = (req.validated.headers ?? {}) as SmsOfficeStatusHeaders;
    assertSmsOfficeStatusAuthorization(authorization);
    const { destination, reference } = req.validated.query as SmsOfficeStatusQuery;
    const result = await authService.checkSmsOfficeStatus(destination, reference);

    res.json(result);
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
