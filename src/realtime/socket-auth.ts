import type { Socket } from 'socket.io';
import { detectCountryFromHeaders } from '../core/geo.js';
import { getAuthProvider } from '../modules/auth/index.js';
import { usersService } from '../modules/users/index.js';
import { logger } from '../core/logger.js';
import { withSpan } from '../core/tracing.js';
import type { AuthIdentity } from '../core/types.js';
import type { User as DbUser } from '../db/types.js';
import { getCachedUser } from '../modules/users/user-cache.js';
import { rememberCurrentCountry } from './session-country.js';
import { AppError } from '../core/errors.js';
import { DbOverloadedError } from '../db/index.js';

export interface SocketAuthData {
  user: DbUser;
  identity: AuthIdentity;
  currentCountry?: string | null;
  lobbyId?: string;
  matchId?: string;
  connectedAt?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractToken(socket: Socket): string | null {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken;
  }
  const cookieHeader = socket.handshake.headers?.cookie;
  if (typeof cookieHeader === 'string') {
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((part) => {
        const [rawKey, ...rawValue] = part.trim().split('=');
        return [rawKey, safeDecode(rawValue.join('='))];
      })
    );
    const cookieToken = cookies.qb_access_token;
    if (typeof cookieToken === 'string' && cookieToken.trim()) {
      return cookieToken.trim();
    }
  }
  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string') {
    return header.replace(/^Bearer\s+/i, '').trim() || null;
  }
  return null;
}

export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void
): Promise<void> {
  try {
    await withSpan('realtime.socket_auth', {
      'quizball.socket_id': socket.id,
    }, async (span) => {
      const token = extractToken(socket);
      if (!token) {
        span.setAttribute('quizball.auth_token_present', false);
        logger.warn({ socketId: socket.id }, 'Socket authentication missing token');
        next(new Error('Authentication required'));
        return;
      }

      span.setAttribute('quizball.auth_token_present', true);
      const authProvider = getAuthProvider();
      const identity = await authProvider.verifyToken(token);
      const cached = await getCachedUser(identity.provider, identity.subject);
      // Only hit the (potentially 3s, external ip-api.com) geo lookup when we
      // don't already know the user's country. On every socket RECONNECT for a
      // known user this used to fire unconditionally — under a reconnect storm
      // (e.g. token-refresh churn) that floods outbound geo fetches and holds
      // the auth path open, amplifying DB/pool pressure. The CF header path is
      // still instant; this just skips the network fallback when redundant.
      const detectedCountry = cached?.country
        ? null
        : await detectCountryFromHeaders(socket.handshake.headers, socket.handshake.address);
      const user = await usersService.getOrCreateFromIdentity(
        identity,
        detectedCountry,
      );
      if (detectedCountry) {
        await rememberCurrentCountry(user.id, detectedCountry);
      }

      span.setAttribute('quizball.user_id', user.id);
      const data: SocketAuthData = {
        user,
        identity,
        currentCountry: detectedCountry ?? cached?.country ?? user.country ?? null,
      };
      socket.data = { ...(socket.data ?? {}), ...data };

      logger.info({ userId: user.id, socketId: socket.id }, 'Socket authenticated');
      next();
    });
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : error, socketId: socket.id },
      'Socket authentication failed'
    );
    // Preserve the ban reason so the client can show the ACCOUNT BANNED screen
    // instead of a generic connection error. Everything else stays opaque.
    const reason =
      error instanceof AppError &&
      typeof error.details === 'object' &&
      error.details !== null &&
      (error.details as { reason?: unknown }).reason === 'banned'
        ? 'banned'
        : null;
    if (reason === 'banned') {
      const bannedError = new Error('Account is banned');
      (bannedError as Error & { data?: unknown }).data = { reason: 'banned' };
      next(bannedError);
      return;
    }
    if (error instanceof DbOverloadedError) {
      const overloadedError = new Error('Server busy; retry connection');
      (overloadedError as Error & { data?: unknown }).data = {
        code: 'DB_OVERLOADED',
        retryable: true,
        reason:
          (error as DbOverloadedError & { reason?: unknown }).reason ??
          'overloaded',
      };
      next(overloadedError);
      return;
    }
    next(new Error('Invalid token'));
  }
}
