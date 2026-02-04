import type { Socket } from 'socket.io';
import { getAuthProvider } from '../modules/auth/index.js';
import { usersService } from '../modules/users/index.js';
import { logger } from '../core/logger.js';
import type { AuthIdentity } from '../core/types.js';
import type { User as DbUser } from '../db/types.js';

export interface SocketAuthData {
  user: DbUser;
  identity: AuthIdentity;
  lobbyId?: string;
  matchId?: string;
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
    const token = extractToken(socket);
    if (!token) {
      logger.warn({ socketId: socket.id }, 'Socket authentication missing token');
      return next(new Error('Authentication required'));
    }

    const authProvider = getAuthProvider();
    const identity = await authProvider.verifyToken(token);
    const user = await usersService.getOrCreateFromIdentity(identity);

    const data: SocketAuthData = { user, identity };
    socket.data = { ...(socket.data ?? {}), ...data };

    logger.info({ userId: user.id, socketId: socket.id }, 'Socket authenticated');
    next();
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : error, socketId: socket.id },
      'Socket authentication failed'
    );
    next(new Error('Invalid token'));
  }
}
