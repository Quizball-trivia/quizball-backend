import { getAuthClient } from './supabase-auth-client.js';
import { usersService } from '../users/index.js';
import { logger } from '../../core/logger.js';
import type { AuthSession, RegisterRequest, LoginRequest } from './auth.schemas.js';

/**
 * Provision user identity in our database.
 * Called after successful auth to ensure user record exists.
 */
async function provisionIdentity(session: AuthSession): Promise<void> {
  if (!session.provider || !session.user?.providerSub) {
    logger.warn(
      { provider: session.provider, providerSub: session.user?.providerSub },
      'Missing provider or providerSub, skipping identity provisioning'
    );
    return;
  }

  try {
    await usersService.getOrCreateFromIdentity({
      provider: session.provider,
      subject: session.user.providerSub,
      email: session.user.email ?? undefined,
      claims: {},
    });
  } catch (error) {
    // Log but don't fail the auth flow - user can still use the app
    // Identity will be created on next login or WebSocket connect
    logger.warn(
      { error: error instanceof Error ? error.message : error, provider: session.provider, userId: session.user.providerSub },
      'Failed to provision identity during auth'
    );
  }
}

export const authService = {
  async register(request: RegisterRequest): Promise<AuthSession> {
    const authClient = getAuthClient();
    const session = await authClient.signUp(request.email, request.password);
    await provisionIdentity(session);
    return session;
  },

  async login(request: LoginRequest): Promise<AuthSession> {
    const authClient = getAuthClient();
    const session = await authClient.signIn(request.email, request.password);
    await provisionIdentity(session);
    return session;
  },
};
