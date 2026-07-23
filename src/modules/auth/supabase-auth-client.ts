import { config } from '../../core/config.js';
import {
  ExternalServiceError,
  AuthenticationError,
  BadRequestError,
  RateLimitError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import { withAuthAdmission } from './auth-admission.js';
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

  async signUp(
    email: string,
    password: string,
    redirectTo?: string,
    locale?: string,
  ): Promise<AuthSession> {
    return withSpan('auth.signup', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const path = redirectTo
        ? `/auth/v1/signup?${new URLSearchParams({ redirect_to: redirectTo }).toString()}`
        : '/auth/v1/signup';
      // `data` lands in raw_user_meta_data; the confirmation email template
      // reads it as {{ .Data.locale }} to localize the message.
      const body = locale
        ? { email, password, data: { locale } }
        : { email, password };
      const response = await this.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const session = this.normalizeSession(response);

      // Supabase anti-enumeration: when the email already belongs to a
      // confirmed account, /signup returns 200 with NO session tokens and a
      // user object whose `identities` array is empty (a real new signup has
      // exactly one identity). Detect that so the client can say "already
      // registered — sign in instead" rather than a misleading "check your
      // email" (no email is sent in this case).
      const userObj = (response as { user?: { identities?: unknown[] } } | null)?.user;
      const hasEmptyIdentities =
        userObj !== undefined &&
        Array.isArray(userObj.identities) &&
        userObj.identities.length === 0;
      if (!session.accessToken && hasEmptyIdentities) {
        session.alreadyRegistered = true;
      }

      return session;
    });
  }

  async signIn(email: string, password: string): Promise<AuthSession> {
    return withSpan('auth.signin', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const response = await this.request(
        '/auth/v1/token?grant_type=password',
        {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        }
      );

      return this.normalizeSession(response);
    });
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    return withSpan('auth.refresh', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const response = await this.request(
        '/auth/v1/token?grant_type=refresh_token',
        {
          method: 'POST',
          body: JSON.stringify({ refresh_token: refreshToken }),
        }
      );

      return this.normalizeSession(response);
    });
  }

  async forgotPassword(email: string, redirectTo?: string): Promise<void> {
    await withSpan('auth.forgot_password', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      await this.request('/auth/v1/recover', {
        method: 'POST',
        body: JSON.stringify({
          email,
          ...(redirectTo && { redirect_to: redirectTo }),
        }),
      });
    });
  }

  async resetPassword(accessToken: string, newPassword: string): Promise<void> {
    await withSpan('auth.reset_password', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      await this.request('/auth/v1/user', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ password: newPassword }),
      });
    });
  }

  async updateUserPhone(accessToken: string, phone: string): Promise<void> {
    await withSpan('auth.update_user_phone', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      await this.request('/auth/v1/user', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ phone }),
      });
    });
  }

  async signInWithIdToken(
    provider: string,
    idToken: string,
    nonce?: string,
  ): Promise<AuthSession> {
    return withSpan('auth.signin_id_token', {
      'quizball.auth_provider': 'supabase',
      'quizball.oauth_provider': provider,
    }, async () => {
      const response = await this.request('/auth/v1/token?grant_type=id_token', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          id_token: idToken,
          ...(nonce ? { nonce } : {}),
        }),
      });
      return this.normalizeSession(response);
    });
  }

  async sendPhoneOtp(phone: string): Promise<void> {
    await withSpan('auth.phone_otp_send', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      await this.request('/auth/v1/otp', {
        method: 'POST',
        body: JSON.stringify({
          phone,
          create_user: false,
        }),
      });
    });
  }

  async verifyPhoneOtp(phone: string, token: string): Promise<AuthSession> {
    return withSpan('auth.phone_otp_verify', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const response = await this.request('/auth/v1/verify', {
        method: 'POST',
        body: JSON.stringify({
          phone,
          token,
          type: 'sms',
        }),
      });

      return this.normalizeSession(response);
    });
  }

  async verifyPhoneChange(accessToken: string, phone: string, token: string): Promise<AuthSession> {
    return withSpan('auth.phone_change_verify', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const response = await this.request('/auth/v1/verify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          phone,
          token,
          type: 'phone_change',
        }),
      });

      return this.normalizeSession(response);
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
    return withSpan('auth.supabase.request', {
      'quizball.auth_provider': 'supabase',
      'http.request.method': options.method ?? 'GET',
      'url.path': path,
    }, async (span) => {
      const url = `${this.baseUrl}${path}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        apikey: this.anonKey,
      };

      if (options.headers) {
        Object.assign(headers, options.headers);
      }

      try {
        const { response, data } = await withAuthAdmission(async () => {
          const admittedResponse = await fetch(url, {
            ...options,
            headers,
            signal: AbortSignal.timeout(config.AUTH_REQUEST_TIMEOUT_MS ?? 10_000),
          });
          const admittedData: unknown = await admittedResponse.json();
          return { response: admittedResponse, data: admittedData };
        });

        span.setAttribute('http.response.status_code', response.status);

        if (!response.ok) {
          this.handleError(response.status, data);
        }

        return data;
      } catch (error) {
        if (error instanceof ExternalServiceError ||
            error instanceof AuthenticationError ||
            error instanceof BadRequestError ||
            error instanceof RateLimitError) {
          throw error;
        }

        logger.error({ error, url }, 'Supabase request failed');
        throw new ExternalServiceError('Failed to communicate with auth service');
      }
    });
  }

  private normalizeOptionalText(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
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
      case 429:
        // Supabase email/auth rate limit — surface as our own 429 so clients
        // can back off, instead of masking it as a 502 upstream failure.
        throw new RateLimitError(message);
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
        phone?: string;
        phone_confirmed_at?: string | null;
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
            phone: this.normalizeOptionalText(session.user.phone),
            phoneConfirmedAt: session.user.phone_confirmed_at ?? null,
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
