import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { authController } from '../../modules/auth/index.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  socialLoginSchema,
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
 * Reset password using access token.
 */
router.post(
  '/reset-password',
  validate({ body: resetPasswordSchema }),
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
 * POST /api/v1/auth/logout
 * Logout (client-side token deletion).
 */
router.post('/logout', authController.logout);

export const authRoutes = router;
