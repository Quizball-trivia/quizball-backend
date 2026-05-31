import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';
import { userResponseSchema } from '../users/users.schemas.js';

const authUserSchema = z
  .object({
    email: z.string().email().nullable(),
    phone: z.string().nullable(),
    provider_sub: z.string(),
  })
  .openapi('AuthUser');

const authResponseSchema = z
  .object({
    access_token: z.string().nullable(),
    refresh_token: z.string().nullable(),
    expires_in: z.number().nullable(),
    token_type: z.string(),
    user: authUserSchema.nullable(),
    provider: z.string(),
    already_registered: z.boolean().optional(),
    pending_deletion: z.boolean().optional(),
  })
  .openapi('AuthResponse');

const messageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi('MessageResponse');

const phoneLinkStartResponseSchema = messageResponseSchema.extend({
  phone: z.string(),
  otp_required: z.boolean(),
}).openapi('PhoneLinkStartResponse');

const georgianPhoneAvailabilityResponseSchema = z.object({
  country: z.string().nullable(),
  phone_auth_available: z.boolean(),
}).openapi('GeorgianPhoneAvailabilityResponse');

const smsOfficeStatusResponseSchema = z.object({
  reference: z.string(),
  destination: z.string(),
  status: z.string(),
  message: z.string().nullable(),
}).openapi('SmsOfficeStatusResponse');

const socialLoginResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .openapi('SocialLoginResponse');

export function registerAuthOpenApi(registry: OpenAPIRegistry): void {
  registry.register('AuthUser', authUserSchema);
  registry.register('AuthResponse', authResponseSchema);
  registry.register('MessageResponse', messageResponseSchema);
  registry.register('PhoneLinkStartResponse', phoneLinkStartResponseSchema);
  registry.register('GeorgianPhoneAvailabilityResponse', georgianPhoneAvailabilityResponseSchema);
  registry.register('SmsOfficeStatusResponse', smsOfficeStatusResponseSchema);
  registry.register('SocialLoginResponse', socialLoginResponseSchema);

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/register',
    summary: 'Register new user',
    tags: ['Auth'],
    body: z.object({
      email: z.string().email(),
      password: z.string().min(8),
      redirect_to: z.string().url().optional(),
      locale: z.enum(['en', 'ka']).optional(),
    }),
    responses: {
      201: { description: 'User registered', schema: authResponseSchema },
      400: { description: 'Bad request', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/login',
    summary: 'Sign in with email and password',
    tags: ['Auth'],
    body: z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }),
    responses: {
      200: { description: 'Login successful', schema: authResponseSchema },
      401: { description: 'Authentication failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/login/restore',
    summary: 'Restore pending-deletion account with email and password',
    tags: ['Auth'],
    body: z.object({
      email: z.string().email(),
      password: z.string().min(1),
    }),
    responses: {
      200: { description: 'Account restored and login successful', schema: authResponseSchema },
      400: { description: 'Account is not restorable', schema: errorResponseSchema },
      401: { description: 'Authentication failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/refresh',
    summary: 'Refresh access token',
    tags: ['Auth'],
    body: z.object({
      refresh_token: z.string(),
    }),
    responses: {
      200: { description: 'Token refreshed', schema: authResponseSchema },
      401: { description: 'Invalid refresh token', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/restore-pending-deletion',
    summary: 'Restore pending-deletion account with refresh token',
    description:
      'Used by OAuth callback flows after the provider has returned a valid Supabase refresh token. ' +
      'The endpoint restores only the account matching that token; it never accepts a user id.',
    tags: ['Auth'],
    body: z.object({
      refresh_token: z.string().optional(),
    }),
    responses: {
      200: { description: 'Account restored and session established', schema: authResponseSchema },
      400: { description: 'Missing token or account is not restorable', schema: errorResponseSchema },
      401: { description: 'Invalid refresh token', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/forgot-password',
    summary: 'Send password reset email',
    tags: ['Auth'],
    body: z.object({
      email: z.string().email(),
      redirect_to: z.string().url().optional(),
    }),
    responses: {
      200: { description: 'Reset email sent', schema: messageResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/reset-password',
    summary: 'Reset password',
    description:
      'Sets a new password for the session identified by the Authorization Bearer ' +
      'token (a Supabase recovery session, or a logged-in user adding/changing a ' +
      'password). The token is read from the Authorization header, not the body.',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      new_password: z.string().min(8),
    }),
    responses: {
      200: { description: 'Password reset successful', schema: messageResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/social-login',
    summary: 'Get OAuth authorization URL',
    tags: ['Auth'],
    body: z.object({
      provider: z.enum(['google', 'apple', 'facebook', 'github']),
      redirect_to: z.string().url(),
      scopes: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    responses: {
      200: { description: 'OAuth URL returned', schema: socialLoginResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/social-login-token',
    summary: 'Exchange a provider-issued OIDC id_token for a session',
    description:
      'Used by client-side OAuth flows like Google Identity Services and ' +
      'Sign in with Apple that return a signed id_token instead of doing a ' +
      'browser redirect. Required for in-app browsers where the classic ' +
      'OAuth redirect endpoint is blocked.',
    tags: ['Auth'],
    body: z.object({
      provider: z.enum(['google', 'apple']),
      id_token: z.string().min(1).max(8192),
      nonce: z.string().min(1).max(512).optional(),
      restore_pending_deletion: z.boolean().optional(),
    }),
    responses: {
      200: { description: 'Session created', schema: authResponseSchema },
      401: { description: 'Invalid id_token', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/auth/phone/ge/availability',
    summary: 'Check Georgian phone auth availability',
    description:
      'Detects the request country and reports whether Georgian phone sign-in should be shown to the client.',
    tags: ['Auth'],
    responses: {
      200: { description: 'Availability resolved', schema: georgianPhoneAvailabilityResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/phone/ge/start',
    summary: 'Start Georgian phone OTP sign-in or sign-up',
    description:
      'Starts Supabase phone OTP for Georgian mobile numbers only. SMS delivery is handled by the configured Supabase Send SMS hook.',
    tags: ['Auth'],
    body: z.object({
      phone: z.string().min(9).max(32),
    }),
    responses: {
      200: { description: 'Verification code sent', schema: messageResponseSchema },
      400: { description: 'Unsupported or invalid phone number', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/phone/ge/verify',
    summary: 'Verify Georgian phone OTP',
    tags: ['Auth'],
    body: z.object({
      phone: z.string().min(9).max(32),
      token: z.string().regex(/^\d{6}$/),
      restore_pending_deletion: z.boolean().optional(),
    }),
    responses: {
      200: { description: 'Session created', schema: authResponseSchema },
      400: { description: 'Invalid request', schema: errorResponseSchema },
      401: { description: 'Invalid OTP', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/phone/ge/link/start',
    summary: 'Start linking a Georgian phone number',
    description:
      'Starts a Supabase phone-change OTP for the authenticated account. Use this from Settings so Google/email users link a phone to the same account.',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      phone: z.string().min(9).max(32),
    }),
    responses: {
      200: { description: 'Verification code sent or already linked', schema: phoneLinkStartResponseSchema },
      400: { description: 'Unsupported or invalid phone number', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      409: { description: 'Phone number already linked elsewhere', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/phone/ge/link/verify',
    summary: 'Verify linked Georgian phone number',
    description:
      'Verifies the phone-change OTP and stores the verified phone number on the current QuizBall user.',
    tags: ['Auth'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      phone: z.string().min(9).max(32),
      token: z.string().regex(/^\d{6}$/),
    }),
    responses: {
      200: { description: 'Phone number linked', schema: userResponseSchema },
      400: { description: 'Invalid request', schema: errorResponseSchema },
      401: { description: 'Invalid OTP or not authenticated', schema: errorResponseSchema },
      409: { description: 'Phone number already linked elsewhere', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/sms/supabase-hook',
    summary: 'Supabase Send SMS hook for SMSOffice',
    description:
      'Called by Supabase Auth Send SMS hook. Sends only Georgian phone OTP messages through SMSOffice. ' +
      'Authenticated by the shared hook secret in the Authorization Bearer header.',
    tags: ['Auth'],
    security: [{ smsHookSecret: [] }],
    body: z.object({
      user: z.object({
        phone: z.string().nullable().optional(),
      }).passthrough(),
      sms: z.object({
        otp: z.string().min(1).max(16),
      }).passthrough(),
    }).passthrough(),
    responses: {
      200: { description: 'SMS accepted', schema: messageResponseSchema },
      401: { description: 'Invalid hook authorization', schema: errorResponseSchema },
      502: { description: 'SMS provider failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/auth/sms/smsoffice-callback',
    summary: 'SMSOffice delivery callback',
    description:
      'Receives SMSOffice delivery status updates. Responds with plain text OK. ' +
      'Authenticated by the shared callback secret in the `secret` query parameter.',
    tags: ['Auth'],
    // The `secret` credential is documented via the smsCallbackSecret security
    // scheme (apiKey in the `secret` query param), so it is intentionally omitted
    // from these documented params to avoid declaring the same credential twice.
    // Runtime validation still covers `secret` via smsOfficeCallbackQuerySchema.
    security: [{ smsCallbackSecret: [] }],
    query: z.object({
      reference: z.string().min(1).max(20),
      status: z.string().min(1).max(32),
      reason: z.string().optional(),
      destination: z.string().min(9).max(32),
      timestamp: z.string().optional(),
      operator: z.string().optional(),
    }),
    responses: {
      200: {
        description: 'Callback accepted',
        mediaType: 'text/plain',
        schema: z.string().openapi({ example: 'OK' }),
      },
      401: { description: 'Invalid callback secret', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/auth/sms/smsoffice-status',
    summary: 'Check SMSOffice message status',
    description:
      'Polls SMSOffice message status by destination and reference. Intended for manual/internal verification. ' +
      'Authenticated by the shared hook secret in the Authorization Bearer header.',
    tags: ['Auth'],
    security: [{ smsHookSecret: [] }],
    query: z.object({
      destination: z.string().min(9).max(32),
      reference: z.string().min(1).max(20),
    }),
    responses: {
      200: { description: 'SMSOffice status', schema: smsOfficeStatusResponseSchema },
      401: { description: 'Invalid status authorization', schema: errorResponseSchema },
      502: { description: 'SMS provider failed', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/logout',
    summary: 'Logout',
    tags: ['Auth'],
    responses: {
      200: { description: 'Logged out', schema: messageResponseSchema },
    },
  });
}
