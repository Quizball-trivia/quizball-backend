import { config } from '../../core/config.js';
import {
  ExternalServiceError,
  AuthenticationError,
  BadRequestError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AuthClient } from './auth.client.js';
import type { AuthSession } from './auth.schemas.js';

/**
 * Supabase auth client implementation.
 * HTTP calls to Supabase /auth/v1/* endpoints.
 */
export class SupabaseAuthClient implements AuthClient {
  private readonly baseUrl: string;
  private readonly anonKey: string;

  constructor() {
    if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    }
    this.baseUrl = config.SUPABASE_URL.replace(/\/$/, '');
    this.anonKey = config.SUPABASE_ANON_KEY;
  }

  async signUp(email: string, password: string): Promise<AuthSession> {
    const response = await this.request('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    return this.normalizeSession(response);
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    const response = await this.request(
      '/auth/v1/token?grant_type=password',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    );

    return this.normalizeSession(response);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const response = await this.request(
      '/auth/v1/token?grant_type=refresh_token',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      }
    );

    return this.normalizeSession(response);
  }

  async forgotPassword(email: string, redirectTo?: string): Promise<void> {
    await this.request('/auth/v1/recover', {
      method: 'POST',
      body: JSON.stringify({
        email,
        ...(redirectTo && { redirect_to: redirectTo }),
      }),
    });
  }

  async resetPassword(accessToken: string, newPassword: string): Promise<void> {
    await this.request('/auth/v1/user', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ password: newPassword }),
    });
  }

  oauthAuthorizeUrl(
    provider: string,
    redirectTo: string,
    scopes?: string | string[]
  ): string {
    const params = new URLSearchParams({
      provider,
      redirect_to: redirectTo,
    });

    // Passthrough scopes: if array, join with space; if string, use as-is
    if (scopes) {
      const scopeStr = Array.isArray(scopes) ? scopes.join(' ') : scopes;
      params.set('scopes', scopeStr);
    }

    return `${this.baseUrl}/auth/v1/authorize?${params.toString()}`;
  }

  /**
   * Make authenticated request to Supabase.
   */
  private async request(
    path: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {}
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      apikey: this.anonKey,
    };

    // Merge additional headers
    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        this.handleError(response.status, data);
      }

      return data;
    } catch (error) {
      if (error instanceof ExternalServiceError ||
          error instanceof AuthenticationError ||
          error instanceof BadRequestError) {
        throw error;
      }

      logger.error({ error, url }, 'Supabase request failed');
      throw new ExternalServiceError('Failed to communicate with auth service');
    }
  }

  /**
   * Handle Supabase error responses.
   */
  private handleError(status: number, data: unknown): never {
    const errorData = data as { error?: string; error_description?: string; message?: string; msg?: string };
    const message =
      errorData.error_description ||
      errorData.msg ||
      errorData.error ||
      errorData.message ||
      'Unknown error';

    logger.warn({ status, error: errorData }, 'Supabase error response');

    switch (status) {
      case 400:
        throw new BadRequestError(message);
      case 401:
        throw new AuthenticationError(message);
      case 422:
        throw new BadRequestError(message);
      default:
        throw new ExternalServiceError(message, { statusCode: status });
    }
  }

  /**
   * Normalize Supabase response to AuthSession.
   */
  private normalizeSession(data: unknown): AuthSession {
    const session = data as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      user?: {
        id?: string;
        email?: string;
      };
    };

    return {
      accessToken: session.access_token ?? null,
      refreshToken: session.refresh_token ?? null,
      expiresIn: session.expires_in ?? null,
      tokenType: session.token_type ?? 'bearer',
      user: session.user
        ? {
            email: session.user.email ?? null,
            providerSub: session.user.id ?? '',
          }
        : null,
      provider: 'supabase',
    };
  }
}

/**
 * Singleton instance.
 */
let authClientInstance: SupabaseAuthClient | null = null;

export function getAuthClient(): AuthClient {
  if (!authClientInstance) {
    authClientInstance = new SupabaseAuthClient();
  }
  return authClientInstance;
}
