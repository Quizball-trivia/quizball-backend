import { z } from 'zod';
import { ALLOWED_REDIRECT_DOMAINS } from '../../core/constants.js';

// =============================================================================
// Shared Schemas
// =============================================================================

/**
 * Redirect URL schema with domain validation.
 * Prevents open redirect vulnerabilities.
 */
const redirectUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return ALLOWED_REDIRECT_DOMAINS.includes(parsed.host);
      } catch {
        return false;
      }
    },
    { message: 'Redirect URL must be to an allowed domain' }
  );

// =============================================================================
// Request Schemas
// =============================================================================

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  redirect_to: redirectUrlSchema.optional(),
  // Drives the language of the Supabase confirmation email. Stored as
  // user metadata (raw_user_meta_data) so the email template can branch on
  // {{ .Data.locale }}. Anything other than "ka" falls back to English.
  locale: z.enum(['en', 'ka']).optional(),
});
export type RegisterRequest = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});
export type RefreshRequest = z.infer<typeof refreshSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
  redirect_to: redirectUrlSchema.optional(),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  new_password: z.string().min(8),
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordSchema>;

export const resetPasswordHeadersSchema = z.object({
  authorization: z.string().regex(/^Bearer\s+\S+/i, 'Authorization header must be Bearer token'),
});
export type ResetPasswordHeaders = z.infer<typeof resetPasswordHeadersSchema>;

export const socialLoginSchema = z.object({
  provider: z.enum(['google', 'apple', 'facebook', 'github']),
  redirect_to: redirectUrlSchema,
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
});
export type SocialLoginRequest = z.infer<typeof socialLoginSchema>;

export const socialLoginTokenSchema = z.object({
  provider: z.enum(['google', 'apple']),
  id_token: z.string().min(1).max(8192),
  nonce: z.string().min(1).max(512).optional(),
});
export type SocialLoginTokenRequest = z.infer<typeof socialLoginTokenSchema>;

export const georgianPhoneOtpStartSchema = z.object({
  phone: z.string().min(9).max(32),
});
export type GeorgianPhoneOtpStartRequest = z.infer<typeof georgianPhoneOtpStartSchema>;

export const georgianPhoneOtpVerifySchema = z.object({
  phone: z.string().min(9).max(32),
  token: z.string().regex(/^\d{6}$/, 'OTP must be a 6 digit code'),
});
export type GeorgianPhoneOtpVerifyRequest = z.infer<typeof georgianPhoneOtpVerifySchema>;

export const georgianPhoneLinkStartSchema = z.object({
  phone: z.string().min(9).max(32),
});
export type GeorgianPhoneLinkStartRequest = z.infer<typeof georgianPhoneLinkStartSchema>;

export const georgianPhoneLinkVerifySchema = z.object({
  phone: z.string().min(9).max(32),
  token: z.string().regex(/^\d{6}$/, 'OTP must be a 6 digit code'),
});
export type GeorgianPhoneLinkVerifyRequest = z.infer<typeof georgianPhoneLinkVerifySchema>;

export const supabaseSmsHookHeadersSchema = z.object({
  authorization: z.string().optional(),
}).passthrough();
export type SupabaseSmsHookHeaders = z.infer<typeof supabaseSmsHookHeadersSchema>;

export const supabaseSmsHookSchema = z.object({
  user: z.object({
    phone: z.string().optional().nullable(),
    phone_change: z.string().optional().nullable(),
    new_phone: z.string().optional().nullable(),
  }).passthrough(),
  sms: z.object({
    otp: z.string().min(1).max(16),
  }).passthrough(),
}).passthrough();
export type SupabaseSmsHookRequest = z.infer<typeof supabaseSmsHookSchema>;

export const smsOfficeCallbackQuerySchema = z.object({
  reference: z.string().min(1).max(20),
  status: z.string().min(1).max(32),
  reason: z.string().optional().default(''),
  destination: z.string().min(9).max(32),
  timestamp: z.string().optional().default(''),
  operator: z.string().optional().default(''),
  secret: z.string().optional(),
}).passthrough();
export type SmsOfficeCallbackQuery = z.infer<typeof smsOfficeCallbackQuerySchema>;

export const smsOfficeStatusHeadersSchema = z.object({
  authorization: z.string().optional(),
}).passthrough();
export type SmsOfficeStatusHeaders = z.infer<typeof smsOfficeStatusHeadersSchema>;

export const smsOfficeStatusQuerySchema = z.object({
  destination: z.string().min(9).max(32),
  reference: z.string().min(1).max(20),
});
export type SmsOfficeStatusQuery = z.infer<typeof smsOfficeStatusQuerySchema>;

// =============================================================================
// Response Schemas
// =============================================================================

export const authUserSchema = z.object({
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
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

export const phoneLinkStartResponseSchema = messageResponseSchema.extend({
  phone: z.string(),
  otp_required: z.boolean(),
});
export type PhoneLinkStartResponse = z.infer<typeof phoneLinkStartResponseSchema>;

export const smsOfficeStatusResponseSchema = z.object({
  reference: z.string(),
  destination: z.string(),
  status: z.string(),
  message: z.string().nullable(),
});
export type SmsOfficeStatusResponse = z.infer<typeof smsOfficeStatusResponseSchema>;

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
    phone: string | null;
    phoneConfirmedAt: string | null;
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
          phone: session.user.phone,
          provider_sub: session.user.providerSub,
        }
      : null,
    provider: session.provider,
  };
}
