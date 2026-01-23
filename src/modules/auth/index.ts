export type { AuthClient } from './auth.client.js';
export { getAuthClient } from './supabase-auth-client.js';
export type { AuthProvider } from './auth.provider.js';
export { getAuthProvider } from './supabase-auth-provider.js';
export { authController } from './auth.controller.js';
export {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  socialLoginSchema,
  authResponseSchema,
  messageResponseSchema,
  socialLoginResponseSchema,
  toAuthResponse,
  type AuthSession,
  type AuthResponse,
  type RegisterRequest,
  type LoginRequest,
  type RefreshRequest,
  type ForgotPasswordRequest,
  type ResetPasswordRequest,
  type SocialLoginRequest,
  type MessageResponse,
  type SocialLoginResponse,
} from './auth.schemas.js';
