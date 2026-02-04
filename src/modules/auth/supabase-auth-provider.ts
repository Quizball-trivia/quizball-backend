import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../../core/config.js';
import { AuthenticationError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AuthIdentity } from '../../core/types.js';
import type { AuthProvider } from './auth.provider.js';

/**
 * Supabase auth provider.
 * JWKS-first verification with introspection fallback.
 */
export class SupabaseAuthProvider implements AuthProvider {
  private readonly baseUrl: string;
  private readonly anonKey: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | null;
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;

  constructor() {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    }

    this.baseUrl = config.SUPABASE_URL.replace(/\/$/, '');
    this.anonKey = config.SUPABASE_ANON_KEY;
    this.issuer = config.SUPABASE_JWT_ISSUER;
    this.audience = config.SUPABASE_JWT_AUDIENCE;

    // Create JWKS resolver if URL is configured
    // jose caches internally - create once at startup
    if (config.SUPABASE_JWKS_URL) {
      this.jwks = createRemoteJWKSet(new URL(config.SUPABASE_JWKS_URL));
      logger.info('Using JWKS verification for Supabase tokens');
    } else {
      this.jwks = null;
      logger.info('Using introspection fallback for Supabase tokens (no JWKS URL)');
    }
  }

  async verifyToken(token: string): Promise<AuthIdentity> {
    if (this.jwks) {
      return this.verifyWithJwks(token);
    }
    return this.verifyWithIntrospection(token);
  }

  /**
   * Verify token using JWKS (preferred method).
   */
  private async verifyWithJwks(token: string): Promise<AuthIdentity> {
    try {
      // Build verification options - only verify if configured
      const options: { issuer?: string; audience?: string } = {};
      if (this.issuer) {
        options.issuer = this.issuer;
      }
      if (this.audience) {
        options.audience = this.audience;
      }

      const { payload } = await jwtVerify(token, this.jwks!, options);

      return this.extractIdentity(payload);
    } catch (error) {
      logger.warn({ error }, 'JWKS verification failed');
      throw new AuthenticationError('Invalid or expired token');
    }
  }

  /**
   * Verify token using introspection (fallback method).
   * Calls Supabase /auth/v1/user endpoint.
   */
  private async verifyWithIntrospection(token: string): Promise<AuthIdentity> {
    try {
      const response = await fetch(`${this.baseUrl}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: this.anonKey,
        },
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Token introspection failed');
        throw new AuthenticationError('Invalid or expired token');
      }

      const user = (await response.json()) as {
        id?: string;
        email?: string;
        app_metadata?: Record<string, unknown>;
        user_metadata?: Record<string, unknown>;
      };

      if (!user.id) {
        throw new AuthenticationError('Invalid token: no user ID');
      }

      return {
        provider: 'supabase',
        subject: user.id,
        email: user.email,
        claims: {
          app_metadata: user.app_metadata,
          user_metadata: user.user_metadata,
        },
      };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      logger.error({ error }, 'Token introspection request failed');
      throw new ExternalServiceError('Failed to verify token');
    }
  }

  /**
   * Extract identity from JWT payload.
   */
  private extractIdentity(payload: JWTPayload): AuthIdentity {
    if (!payload.sub) {
      throw new AuthenticationError('Invalid token: no subject claim');
    }

    const userMetadata = payload.user_metadata as Record<string, unknown> | undefined;
    const name =
      (userMetadata?.full_name as string | undefined) ||
      (userMetadata?.name as string | undefined) ||
      (userMetadata?.preferred_username as string | undefined);
    const avatarUrl =
      (userMetadata?.avatar_url as string | undefined) ||
      (userMetadata?.picture as string | undefined);

    return {
      provider: 'supabase',
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name,
      avatarUrl,
      claims: payload as Record<string, unknown>,
    };
  }
}

/**
 * Singleton instance.
 */
let authProviderInstance: SupabaseAuthProvider | null = null;

export function getAuthProvider(): AuthProvider {
  if (!authProviderInstance) {
    authProviderInstance = new SupabaseAuthProvider();
  }
  return authProviderInstance;
}
