import type { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { getAuthProvider } from '../../modules/auth/index.js';
import { usersService } from '../../modules/users/index.js';

/**
 * Extract bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }

  return parts[1];
}

/**
 * Auth middleware.
 * Verifies JWT and attaches user + identity to request.
 *
 * Flow:
 * 1. Extract token from Authorization header
 * 2. Verify JWT → get AuthIdentity
 * 3. Resolve internal user via getOrCreateFromIdentity()
 * 4. Attach req.user and req.identity
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Extract token from Authorization header
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new AuthenticationError('Missing authorization header');
    }

    // 2. Verify JWT → get AuthIdentity
    const authProvider = getAuthProvider();
    const identity = await authProvider.verifyToken(token);

    logger.debug(
      { provider: identity.provider, subject: identity.subject },
      'Token verified'
    );

    // 3. Resolve internal user (CRITICAL - don't skip this!)
    const user = await usersService.getOrCreateFromIdentity(identity);

    // 4. Attach BOTH to request
    req.identity = identity;
    req.user = user;

    next();
  } catch (error) {
    next(error);
  }
}
