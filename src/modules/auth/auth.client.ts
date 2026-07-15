import type { AuthSession } from './auth.schemas.js';

export interface AuthRequestContext {
  /** Trusted end-user address selected by our ingress, never raw caller XFF. */
  clientIp?: string;
}

/**
 * Auth client interface.
 * Defines operations for interacting with an auth provider (e.g., Supabase).
 */
export interface AuthClient {
  /**
   * Sign up with email and password.
   * May return accessToken=null if email confirmation is required.
   * `locale` is persisted as user metadata so the confirmation email can be
   * localized via the Supabase template ({{ .Data.locale }}).
   */
  signUp(
    email: string,
    password: string,
    redirectTo?: string,
    locale?: string,
    context?: AuthRequestContext,
  ): Promise<AuthSession>;

  /**
   * Sign in with email and password.
   */
  signIn(email: string, password: string, context?: AuthRequestContext): Promise<AuthSession>;

  /**
   * Refresh access token using refresh token.
   */
  refresh(refreshToken: string, context?: AuthRequestContext): Promise<AuthSession>;

  /**
   * Send password reset email.
   */
  forgotPassword(email: string, redirectTo?: string, context?: AuthRequestContext): Promise<void>;

  /**
   * Reset password using access token.
   */
  resetPassword(accessToken: string, newPassword: string, context?: AuthRequestContext): Promise<void>;

  /**
   * Start a phone-change flow for the currently authenticated Supabase user.
   * Supabase sends the OTP through the configured Send SMS hook.
   */
  updateUserPhone(accessToken: string, phone: string, context?: AuthRequestContext): Promise<void>;

  /**
   * Generate OAuth authorization URL.
   * Note: Social login is typically done client-side via Supabase SDK.
   * This endpoint exists for parity and custom flows.
   */
  oauthAuthorizeUrl(
    provider: string,
    redirectTo: string,
    scopes?: string | string[]
  ): string;

  /**
   * Exchange a provider-issued OIDC id_token (e.g. from Google Identity
   * Services / Sign in with Apple) for a Supabase session. Used when the
   * frontend does sign-in client-side without a redirect — required for
   * in-app browsers (Messenger/Instagram) where the classic OAuth redirect
   * endpoint is blocked by Google.
   *
   * `nonce` must match the nonce sent to the provider on the original
   * id_token request, when one was used.
   */
  signInWithIdToken(
    provider: string,
    idToken: string,
    nonce?: string,
    context?: AuthRequestContext,
  ): Promise<AuthSession>;

  /**
   * Start Supabase phone OTP flow. SMS delivery is handled by Supabase's
   * configured Send SMS hook.
   */
  sendPhoneOtp(phone: string, context?: AuthRequestContext): Promise<void>;

  /**
   * Verify a Supabase phone OTP and return a normal Supabase session.
   */
  verifyPhoneOtp(phone: string, token: string, context?: AuthRequestContext): Promise<AuthSession>;

  /**
   * Verify a phone-change OTP for the currently authenticated Supabase user.
   */
  verifyPhoneChange(
    accessToken: string,
    phone: string,
    token: string,
    context?: AuthRequestContext,
  ): Promise<AuthSession>;
}
