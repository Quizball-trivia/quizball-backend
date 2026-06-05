import type { Request, Response, NextFunction } from 'express';
import { AuthenticationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { detectCountryFromRequest } from '../../core/geo.js';
import { getAuthProvider } from '../../modules/auth/index.js';
import { usersService } from '../../modules/users/index.js';
import { getCachedUser } from '../../modules/users/user-cache.js';

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

function extractCookieToken(cookieToken: unknown): string | null {
  if (typeof cookieToken !== 'string') return null;
  return cookieToken.trim() || null;
}

export function selectAuthToken(authHeader: string | undefined, cookieToken: unknown): string | null {
  const bearerToken = extractBearerToken(authHeader);
  return bearerToken ?? extractCookieToken(cookieToken);
}

/**
 * Auth middleware.
 * Verifies JWT and attaches user + identity to request.
 *
 * Token extraction supports cookies and Authorization header:
 * - extractBearerToken(req.headers.authorization) — preferred when present
 * - extractCookieToken(req.cookies?.qb_access_token) — fallback for cookie sessions
 *
 * Flow:
 * 1. Extract token from Authorization header or cookies
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
    // 1. Extract token from cookies or Authorization header
    const token = selectAuthToken(req.headers.authorization, req.cookies?.qb_access_token);
    if (!token) {
      throw new AuthenticationError('Missing auth token');
    }

    // 2. Verify JWT → get AuthIdentity
    const authProvider = getAuthProvider();
    const identity = await authProvider.verifyToken(token);

    logger.debug(
      { provider: identity.provider, subject: identity.subject },
      'Token verified'
    );

    // 3. Resolve internal user
    // Only call geo detection if the user doesn't have a country yet — avoids blocking
    // third-party HTTP call on every authenticated request
    const cached = await getCachedUser(identity.provider, identity.subject);
    const detectedCountry = cached?.country ? null : await detectCountryFromRequest(req);
    const user = await usersService.getOrCreateFromIdentity(identity, detectedCountry);

    // 4. Attach BOTH to request
    req.identity = identity;
    req.user = user;

    next();
  } catch (error) {
    next(error);
  }
}
