import type { AuthIdentity } from '../../core/types.js';

/**
 * Auth provider interface.
 * Defines operations for verifying tokens from an auth provider.
 */
export interface AuthProvider {
  /**
   * Verify access token and extract identity.
   * Throws AuthenticationError if token is invalid.
   */
  verifyToken(token: string): Promise<AuthIdentity>;
}
