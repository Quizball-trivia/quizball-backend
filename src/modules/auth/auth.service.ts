import { getAuthClient } from './supabase-auth-client.js';
import { usersService } from '../users/index.js';
import { logger } from '../../core/logger.js';
import { withSpan } from '../../core/tracing.js';
import type { AuthSession, RegisterRequest, LoginRequest } from './auth.schemas.js';

/**
 * Provision user identity in our database.
 * Called after successful auth to ensure user record exists.
 */
async function provisionIdentity(session: AuthSession): Promise<void> {
  await withSpan('auth.provision_identity', {
    'quizball.auth_provider': session.provider ?? 'unknown',
  }, async (span) => {
    if (!session.provider || !session.user?.providerSub) {
      span.setAttribute('quizball.identity_provision_skipped', true);
      logger.warn(
        { provider: session.provider, providerSub: session.user?.providerSub },
        'Missing provider or providerSub, skipping identity provisioning'
      );
      return;
    }

    span.setAttribute('quizball.user_subject', session.user.providerSub);
    try {
      await usersService.getOrCreateFromIdentity({
        provider: session.provider,
        subject: session.user.providerSub,
        email: session.user.email ?? undefined,
        claims: {},
      });
    } catch (error) {
      span.setAttribute('quizball.identity_provision_warning', true);
      logger.warn(
        { error: error instanceof Error ? error.message : error, provider: session.provider, userId: session.user.providerSub },
        'Failed to provision identity during auth'
      );
    }
  });
}

export const authService = {
  async register(request: RegisterRequest): Promise<AuthSession> {
    return withSpan('auth.register', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signUp(request.email, request.password);
      await provisionIdentity(session);
      return session;
    });
  },

  async login(request: LoginRequest): Promise<AuthSession> {
    return withSpan('auth.login', {
      'quizball.auth_provider': 'supabase',
    }, async () => {
      const authClient = getAuthClient();
      const session = await authClient.signIn(request.email, request.password);
      await provisionIdentity(session);
      return session;
    });
  },
};
