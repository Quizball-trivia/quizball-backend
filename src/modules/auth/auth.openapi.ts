import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { errorResponseSchema } from '../../http/openapi/common-schemas.js';

const authUserSchema = z
  .object({
    email: z.string().email().nullable(),
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
  })
  .openapi('AuthResponse');

const messageResponseSchema = z
  .object({
    message: z.string(),
  })
  .openapi('MessageResponse');

const socialLoginResponseSchema = z
  .object({
    url: z.string().url(),
  })
  .openapi('SocialLoginResponse');

export function registerAuthOpenApi(registry: OpenAPIRegistry): void {
  registry.register('AuthUser', authUserSchema);
  registry.register('AuthResponse', authResponseSchema);
  registry.register('MessageResponse', messageResponseSchema);
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
    tags: ['Auth'],
    body: z.object({
      access_token: z.string(),
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
    }),
    responses: {
      200: { description: 'Session created', schema: authResponseSchema },
      401: { description: 'Invalid id_token', schema: errorResponseSchema },
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
    }),
    responses: {
      200: { description: 'Session created', schema: authResponseSchema },
      400: { description: 'Invalid request', schema: errorResponseSchema },
      401: { description: 'Invalid OTP', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/auth/sms/supabase-hook',
    summary: 'Supabase Send SMS hook for SMSOffice',
    description:
      'Called by Supabase Auth Send SMS hook. Sends only Georgian phone OTP messages through SMSOffice.',
    tags: ['Auth'],
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
    method: 'post',
    path: '/api/v1/auth/logout',
    summary: 'Logout',
    tags: ['Auth'],
    responses: {
      200: { description: 'Logged out', schema: messageResponseSchema },
    },
  });
}
