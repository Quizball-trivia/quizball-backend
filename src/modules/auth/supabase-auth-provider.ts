import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { createHash } from 'node:crypto';
import { config } from '../../core/config.js';
import { AuthenticationError, ExternalServiceError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import type { AuthIdentity } from '../../core/types.js';
import type { AuthProvider } from './auth.provider.js';

const INTROSPECTION_CACHE_MAX_TTL_MS = 60_000;
const INTROSPECTION_CACHE_MAX_ENTRIES = 5000;

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payloadSegment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payloadSegment.padEnd(
      payloadSegment.length + ((4 - (payloadSegment.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

function cloneIdentity(identity: AuthIdentity): AuthIdentity {
  return {
    ...identity,
    claims: { ...identity.claims },
  };
}

type IntrospectionCacheEntry = {
  identity: AuthIdentity;
  expiresAtMs: number;
};

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
  private readonly introspectionCache = new Map<string, IntrospectionCacheEntry>();
  private readonly introspectionInFlight = new Map<string, Promise<AuthIdentity>>();

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
    return withSpan('auth.verify_token', {
      'quizball.auth_provider': 'supabase',
      'quizball.auth_verify_method': this.jwks ? 'jwks' : 'introspection',
    }, async () => {
      if (this.jwks) {
        return this.verifyWithJwks(token);
      }
      return this.verifyWithCachedIntrospection(token);
    });
  }

  /**
   * Verify token using JWKS (preferred method).
   */
  private async verifyWithJwks(token: string): Promise<AuthIdentity> {
    return withSpan('auth.verify_token.jwks', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      try {
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
    });
  }

  /**
   * Verify token using introspection (fallback method).
   * Calls Supabase /auth/v1/user endpoint.
   */
  private async verifyWithCachedIntrospection(token: string): Promise<AuthIdentity> {
    const cacheKey = tokenCacheKey(token);
    const cached = this.introspectionCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cloneIdentity(cached.identity);
    }
    if (cached) {
      this.introspectionCache.delete(cacheKey);
    }

    const existing = this.introspectionInFlight.get(cacheKey);
    if (existing) {
      return cloneIdentity(await existing);
    }

    const verification = this.verifyWithIntrospection(token)
      .then((identity) => {
        this.cacheIntrospectionResult(cacheKey, token, identity);
        return identity;
      })
      .finally(() => {
        this.introspectionInFlight.delete(cacheKey);
      });

    this.introspectionInFlight.set(cacheKey, verification);
    return cloneIdentity(await verification);
  }

  private cacheIntrospectionResult(cacheKey: string, token: string, identity: AuthIdentity): void {
    const expMs = decodeJwtExpMs(token);
    if (!expMs) return;

    const ttlMs = Math.min(expMs - Date.now(), INTROSPECTION_CACHE_MAX_TTL_MS);
    if (ttlMs <= 0) return;

    if (this.introspectionCache.size >= INTROSPECTION_CACHE_MAX_ENTRIES) {
      this.pruneIntrospectionCache();
    }
    this.introspectionCache.set(cacheKey, {
      identity: cloneIdentity(identity),
      expiresAtMs: Date.now() + ttlMs,
    });
  }

  private pruneIntrospectionCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.introspectionCache) {
      if (entry.expiresAtMs <= now) {
        this.introspectionCache.delete(key);
      }
    }
    while (this.introspectionCache.size >= INTROSPECTION_CACHE_MAX_ENTRIES) {
      const oldestKey = this.introspectionCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.introspectionCache.delete(oldestKey);
    }
  }

  private async verifyWithIntrospection(token: string): Promise<AuthIdentity> {
    return withSpan('auth.verify_token.introspection', {
      'quizball.auth_provider': 'supabase',
    }, async (span) => {
      try {
        const response = await fetch(`${this.baseUrl}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: this.anonKey,
          },
        });

        span.setAttribute('http.response.status_code', response.status);
        if (!response.ok) {
          logger.warn({ status: response.status }, 'Token introspection failed');
          throw new AuthenticationError('Invalid or expired token');
        }

        const user = (await response.json()) as {
          id?: string;
          email?: string;
          phone?: string;
          phone_confirmed_at?: string | null;
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
          phoneNumber: user.phone,
          phoneVerifiedAt: user.phone_confirmed_at ?? null,
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
    });
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
      phoneNumber: normalizeOptionalText(payload.phone),
      phoneVerifiedAt: typeof payload.phone_confirmed_at === 'string' ? payload.phone_confirmed_at : null,
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
