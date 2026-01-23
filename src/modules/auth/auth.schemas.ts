import { z } from 'zod';

// =============================================================================
// Request Schemas
// =============================================================================

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type RegisterRequest = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof refreshSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  redirect_to: z.string().url().optional(),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  access_token: z.string().min(1),
  new_password: z.string().min(8),
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;

export const socialLoginSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github']),
  redirect_to: z.string().url(),
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
});
export type SocialLoginRequest = z.infer<typeof socialLoginSchema>;

// =============================================================================
// Response Schemas
// =============================================================================

export const authUserSchema = z.object({
  email: z.string().email().nullable(),
  provider_sub: z.string(),
});

export const authResponseSchema = z.object({
  access_token: z.string().nullable(),
  refresh_token: z.string().nullable(),
  expires_in: z.number().nullable(),
  token_type: z.string(),
  user: authUserSchema.nullable(),
  provider: z.string(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

export const messageResponseSchema = z.object({
  message: z.string(),
});
export type MessageResponse = z.infer<typeof messageResponseSchema>;

export const socialLoginResponseSchema = z.object({
  url: z.string().url(),
});
export type SocialLoginResponse = z.infer<typeof socialLoginResponseSchema>;

// =============================================================================
// Internal Types
// =============================================================================

/**
 * Auth session returned from auth client.
 */
export interface AuthSession {
  accessToken: string | null;
  refreshToken: string | null;
  expiresIn: number | null;
  tokenType: string;
  user: {
    email: string | null;
    providerSub: string;
  } | null;
  provider: string;
}

/**
 * Convert AuthSession to API response format.
 */
export function toAuthResponse(session: AuthSession): AuthResponse {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn,
    token_type: session.tokenType,
    user: session.user
      ? {
          email: session.user.email,
          provider_sub: session.user.providerSub,
        }
      : null,
    provider: session.provider,
  };
}
