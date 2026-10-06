import type { Request, Response, NextFunction } from 'express';
import { AuthenticationError, AuthorizationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { detectCountryFromRequest } from '../../core/geo.js';
import { getAuthProvider } from '../../modules/auth/index.js';
import { usersService } from '../../modules/users/index.js';
import { getCachedUser } from '../../modules/users/user-cache.js';
import { isPartnerToken } from '../../modules/partners/partner-token.js';
import {
  CAMPAIGN_ATTRIBUTION_HEADER,
  parseCampaignAttribution,
} from '../../core/campaign-attribution.js';
import {
  UTM_ATTRIBUTION_HEADER,
  parseUtmAttribution,
} from '../../core/utm-attribution.js';

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
 * Partner staff are CMS principals, not players: they may use the partner admin API and read their own account
 * (the CMS reads `role` from it), nothing else.
 */
export function isStaffAllowedRoute(method: string, originalUrl: string): boolean {
  const path = originalUrl.split('?')[0].replace(/\/+$/, '');
  return path.startsWith('/partner-admin/v1/') || (method === 'GET' && path === '/api/v1/users/me');
}

/**
 * Verify a Supabase JWT and attach req.user + req.identity.
 *
 * 1. Refuse partner tokens outright (they are never sent to Supabase; only /partner/v1 accepts them)
 * 2. Verify JWT → get AuthIdentity
 * 3. Resolve internal user via getOrCreateFromIdentity()
 */
export async function authenticateRequest(req: Request, token: string): Promise<void> {
  if (isPartnerToken(token)) {
    throw new AuthenticationError('Invalid or expired token');
  }

  const authProvider = getAuthProvider();
  const identity = await authProvider.verifyToken(token);

  logger.debug(
    { provider: identity.provider, subject: identity.subject },
    'Token verified'
  );

  // Only call geo detection if the user doesn't have a country yet — avoids blocking
  // third-party HTTP call on every authenticated request
  const cached = await getCachedUser(identity.provider, identity.subject);
  const detectedCountry = cached?.country ? null : await detectCountryFromRequest(req);
  const attribution = parseCampaignAttribution(
    req.headers[CAMPAIGN_ATTRIBUTION_HEADER],
  );
  const utm = parseUtmAttribution(req.headers[UTM_ATTRIBUTION_HEADER]);
  const user = await usersService.getOrCreateFromIdentity(identity, detectedCountry, {
    accountCreation: {
      ...(typeof req.headers['x-guest-token'] === 'string' ? { guestToken: req.headers['x-guest-token'] } : {}),
      attribution,
      utm,
    },
  });

  req.identity = identity;
  req.user = user;
}

/**
 * Auth middleware.
 * Verifies JWT and attaches user + identity to request.
 *
 * Token extraction supports cookies and Authorization header:
 * - extractBearerToken(req.headers.authorization) — preferred when present
 * - extractCookieToken(req.cookies?.qb_access_token) — fallback for cookie sessions
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = selectAuthToken(req.headers.authorization, req.cookies?.qb_access_token);
    if (!token) {
      throw new AuthenticationError('Missing auth token');
    }

    await authenticateRequest(req, token);

    if (req.user?.role === 'partner_staff' && !isStaffAllowedRoute(req.method, req.originalUrl)) {
      throw new AuthorizationError('Partner staff accounts cannot use this endpoint');
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Mounted in front of every /api/v1 route: a partner player's token (header or cookie) is refused outright, including
 * on public and optional-auth routes that would otherwise just treat it as a guest. Partner players only use
 * /partner/v1.
 */
export function rejectPartnerCredentials(req: Request, _res: Response, next: NextFunction): void {
  const bearer = extractBearerToken(req.headers.authorization);
  const cookie = extractCookieToken(req.cookies?.qb_access_token);
  if ((bearer && isPartnerToken(bearer)) || (cookie && isPartnerToken(cookie))) {
    next(new AuthenticationError('Invalid or expired token'));
    return;
  }
  next();
}

/**
 * Attach req.user when a valid session is present, but never reject the
 * request. For public endpoints that behave differently for signed-in users —
 * campaign quiz ratings are account-bound when possible and guest-keyed
 * otherwise. An invalid or expired token is treated as a guest rather than an
 * error, so a stale cookie cannot lock a visitor out of a page that is meant
 * to work signed-out.
 */
export async function optionalAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = selectAuthToken(req.headers.authorization, req.cookies?.qb_access_token);
  if (!token) return next();

  let failed: unknown;
  await authMiddleware(req, res, (error?: unknown) => {
    failed = error;
  });

  if (failed) {
    logger.debug({ err: failed }, 'Ignoring invalid token on optional-auth route');
    req.identity = undefined;
    req.user = undefined;
  }
  next();
}
