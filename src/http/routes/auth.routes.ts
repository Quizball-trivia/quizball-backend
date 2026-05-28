import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { injectRefreshTokenFromCookie } from '../middleware/refresh-token-cookie.js';
import { authController } from '../../modules/auth/index.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  resetPasswordHeadersSchema,
  socialLoginSchema,
  socialLoginTokenSchema,
  georgianPhoneOtpStartSchema,
  georgianPhoneOtpVerifySchema,
  supabaseSmsHookHeadersSchema,
  supabaseSmsHookSchema,
} from '../../modules/auth/index.js';

const router = Router();

/**
 * POST /api/v1/auth/register
 * Register new user with email and password.
 */
router.post(
  '/register',
  validate({ body: registerSchema }),
  authController.register
);

/**
 * POST /api/v1/auth/login
 * Sign in with email and password.
 */
router.post('/login', validate({ body: loginSchema }), authController.login);

/**
 * POST /api/v1/auth/refresh
 * Refresh access token.
 */
router.post(
  '/refresh',
  injectRefreshTokenFromCookie,
  validate({ body: refreshSchema }),
  authController.refresh
);

/**
 * POST /api/v1/auth/forgot-password
 * Send password reset email.
 */
router.post(
  '/forgot-password',
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);

/**
 * POST /api/v1/auth/reset-password
 * Reset password using access token from Authorization header.
 */
router.post(
  '/reset-password',
  validate({ body: resetPasswordSchema, headers: resetPasswordHeadersSchema }),
  authController.resetPassword
);

/**
 * POST /api/v1/auth/social-login
 * Get OAuth authorization URL.
 */
router.post(
  '/social-login',
  validate({ body: socialLoginSchema }),
  authController.socialLogin
);

/**
 * POST /api/v1/auth/social-login-token
 * Exchange a provider-issued OIDC id_token (Google Identity Services or
 * Sign in with Apple) for a Supabase session.
 */
router.post(
  '/social-login-token',
  validate({ body: socialLoginTokenSchema }),
  authController.socialLoginToken
);

/**
 * POST /api/v1/auth/phone/ge/start
 * Start Georgian phone OTP sign-in/sign-up.
 */
router.post(
  '/phone/ge/start',
  validate({ body: georgianPhoneOtpStartSchema }),
  authController.startGeorgianPhoneOtp
);

/**
 * POST /api/v1/auth/phone/ge/verify
 * Verify Georgian phone OTP.
 */
router.post(
  '/phone/ge/verify',
  validate({ body: georgianPhoneOtpVerifySchema }),
  authController.verifyGeorgianPhoneOtp
);

/**
 * POST /api/v1/auth/sms/supabase-hook
 * Supabase Send SMS hook for SMSOffice delivery.
 */
router.post(
  '/sms/supabase-hook',
  validate({ body: supabaseSmsHookSchema, headers: supabaseSmsHookHeadersSchema }),
  authController.supabaseSmsHook
);

/**
 * POST /api/v1/auth/logout
 * Logout (client-side token deletion).
 */
router.post('/logout', authController.logout);

export const authRoutes = router;
