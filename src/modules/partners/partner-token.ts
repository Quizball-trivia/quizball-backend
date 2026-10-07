/** Partner credentials: the one-time launch token (init → redeem) and the partner access token (an HS256 JWT our
 *  backend signs; internal API §4). Supabase never sees either, and the regular auth middleware refuses both. */

import { randomBytes } from 'node:crypto';
import { decodeJwt, jwtVerify, SignJWT } from 'jose';
import { logger } from '../../core/logger.js';
import type { PartnerConfig } from './partner-config.js';
import { PartnerError } from './partner-errors.js';
import { Sealer } from './retained.js';

export const PARTNER_TOKEN_ISSUER = 'quizball-partner';
/** The launch token works once, for 60 s (contract §4.1). */
export const LAUNCH_TTL_S = 60;
/** Access tokens are short; the web view refreshes them while the partner session is open. */
export const ACCESS_TTL_S = 30 * 60;
/** A gameplay session ends 12 h after redeem whatever happens. */
export const SESSION_TTL_S = 12 * 60 * 60;

const MIN_SECRET_BYTES = 32;

function secret(name: 'PARTNER_JWT_SECRET' | 'PARTNER_RESPONSE_SEAL_KEY'): string {
  const value = process.env[name];
  if (!value || Buffer.byteLength(value, 'utf8') < MIN_SECRET_BYTES) {
    logger.error({ name }, 'Partner secret missing or shorter than 32 bytes');
    throw new PartnerError('maintenance', undefined, 60);
  }
  return value;
}

let sealer: { key: string; sealer: Sealer } | null = null;
export function getResponseSealer(): Sealer {
  const key = secret('PARTNER_RESPONSE_SEAL_KEY');
  if (sealer?.key !== key) sealer = { key, sealer: new Sealer(key) };
  return sealer.sealer;
}

export function newLaunchToken(): string {
  return `qbl_${randomBytes(32).toString('base64url')}`;
}

export function partnerAudience(config: Pick<PartnerConfig, 'slug' | 'environment'>): string {
  return `${config.slug}-${config.environment}`;
}

export interface PartnerAccessClaims {
  /** partner_players.id */
  playerId: string;
  /** partner_sessions.id */
  sessionId: string;
}

export async function signPartnerAccessToken(
  config: Pick<PartnerConfig, 'slug' | 'environment'>,
  claims: PartnerAccessClaims,
  expiresAt: Date,
): Promise<string> {
  return new SignJWT({ psid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(PARTNER_TOKEN_ISSUER)
    .setAudience(partnerAudience(config))
    .setSubject(claims.playerId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(new TextEncoder().encode(secret('PARTNER_JWT_SECRET')));
}

/** The claims of a valid access token for this deploy's partner environment, or null. */
export async function verifyPartnerAccessToken(
  config: Pick<PartnerConfig, 'slug' | 'environment'>,
  token: string,
): Promise<PartnerAccessClaims | null> {
  const key = new TextEncoder().encode(secret('PARTNER_JWT_SECRET'));
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      issuer: PARTNER_TOKEN_ISSUER,
      audience: partnerAudience(config),
      // A signed token without an expiry, subject or session never counts.
      requiredClaims: ['exp', 'iat', 'sub', 'psid'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.psid !== 'string') return null;
    return { playerId: payload.sub, sessionId: payload.psid };
  } catch {
    return null;
  }
}

/** True when the token claims our partner issuer (signature not checked): such a token never goes to Supabase. */
export function isPartnerToken(token: string): boolean {
  if (token.startsWith('qbl_')) return true;
  try {
    return decodeJwt(token).iss === PARTNER_TOKEN_ISSUER;
  } catch {
    return false;
  }
}
