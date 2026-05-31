import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authMiddleware } from '../middleware/auth.js';
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
  georgianPhoneLinkStartSchema,
  georgianPhoneLinkVerifySchema,
  supabaseSmsHookHeadersSchema,
  supabaseSmsHookSchema,
  smsOfficeCallbackQuerySchema,
  smsOfficeStatusHeadersSchema,
  smsOfficeStatusQuerySchema,
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
 * GET /api/v1/auth/phone/ge/availability
 * Detect whether Georgian phone auth should be shown for this request.
 */
router.get(
  '/phone/ge/availability',
  authController.georgianPhoneAvailability
);

/**
 * POST /api/v1/auth/phone/ge/start
 * Start passwordless auth for Georgian mobile numbers.
 */
router.post(
  '/phone/ge/start',
  validate({ body: georgianPhoneOtpStartSchema }),
  authController.startGeorgianPhoneOtp
);

/**
 * POST /api/v1/auth/phone/ge/verify
 * Verify Georgian phone OTP and issue a session.
 */
router.post(
  '/phone/ge/verify',
  validate({ body: georgianPhoneOtpVerifySchema }),
  authController.verifyGeorgianPhoneOtp
);

/**
 * POST /api/v1/auth/phone/ge/link/start
 * Start adding/changing a Georgian phone number for the current account.
 */
router.post(
  '/phone/ge/link/start',
  authMiddleware,
  validate({ body: georgianPhoneLinkStartSchema }),
  authController.startGeorgianPhoneLink
);

/**
 * POST /api/v1/auth/phone/ge/link/verify
 * Verify adding/changing a Georgian phone number for the current account.
 */
router.post(
  '/phone/ge/link/verify',
  authMiddleware,
  validate({ body: georgianPhoneLinkVerifySchema }),
  authController.verifyGeorgianPhoneLink
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
 * GET /api/v1/auth/sms/smsoffice-callback
 * SMSOffice delivery status callback.
 */
router.get(
  '/sms/smsoffice-callback',
  validate({ query: smsOfficeCallbackQuerySchema }),
  authController.smsOfficeCallback
);

/**
 * GET /api/v1/auth/sms/smsoffice-status
 * Manual SMSOffice status polling for a sent reference.
 */
router.get(
  '/sms/smsoffice-status',
  validate({ query: smsOfficeStatusQuerySchema, headers: smsOfficeStatusHeadersSchema }),
  authController.smsOfficeStatus
);

/**
 * POST /api/v1/auth/logout
 * Logout (client-side token deletion).
 */
router.post('/logout', authController.logout);

export const authRoutes = router;
