import type { AuthSession } from './auth.schemas.js';

/**
 * Auth client interface.
 * Defines operations for interacting with an auth provider (e.g., Supabase).
 */
export interface AuthClient {
  /**
   * Sign up with email and password.
   * May return accessToken=null if email confirmation is required.
   */
  signUp(email: string, password: string): Promise<AuthSession>;

  /**
   * Sign in with email and password.
   */
  signIn(email: string, password: string): Promise<AuthSession>;

  /**
   * Refresh access token using refresh token.
   */
  refresh(refreshToken: string): Promise<AuthSession>;

  /**
   * Send password reset email.
   */
  forgotPassword(email: string, redirectTo?: string): Promise<void>;

  /**
   * Reset password using access token.
   */
  resetPassword(accessToken: string, newPassword: string): Promise<void>;

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
}
