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
    path: '/api/v1/auth/logout',
    summary: 'Logout',
    tags: ['Auth'],
    responses: {
      200: { description: 'Logged out', schema: messageResponseSchema },
    },
  });
}
