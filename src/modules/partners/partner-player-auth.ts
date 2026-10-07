/** Player class: a partner access token (bearer only; cookies are ignored), checked against its partner session and
 *  the player's status on every request, so a block, a newer launch or the 12 h end takes effect at once: 401
 *  session_ended with reason 'blocked', 'replaced' or 'expired' (contract §5.3–5.4). */

import type { NextFunction, Request, Response } from 'express';
import { sql } from '../../db/index.js';
import { PartnerError } from './partner-errors.js';
import { requirePartnerConfig } from './partner-machine-auth.js';
import type { PartnerLanguage } from './partner-sessions.service.js';
import { verifyPartnerAccessToken } from './partner-token.js';

export interface PartnerPrincipal {
  slug: string;
  environment: 'test' | 'production';
  /** partner_players.id */
  playerId: string;
  /** The partner's own playerId (score events carry it). */
  externalPlayerId: string;
  /** users.id the game modules key on. */
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  language: PartnerLanguage;
  displayName: string;
  statusVersion: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The partner player (set by partnerPlayerAuth on /partner/v1 player routes). */
      partner?: PartnerPrincipal;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOUCH_AFTER_MS = 60_000;

interface SessionRow {
  state: 'issued' | 'redeemed' | 'revoked' | 'expired';
  end_reason: string | null;
  session_expires_at: Date | null;
  session_over: boolean;
  last_seen_at: Date | null;
  language: PartnerLanguage;
  external_player_id: string;
  user_id: string | null;
  display_name: string | null;
  status: 'active' | 'blocked';
  status_version: number;
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * The partner principal of a bearer access token, checked against its partner session and the player's status
 * (the HTTP middleware and the socket handshake share it). Throws session_ended with the reason.
 */
export async function resolvePartnerPrincipal(token: string): Promise<PartnerPrincipal> {
  const config = requirePartnerConfig();
  const claims = await verifyPartnerAccessToken(config, token);
  if (!claims || !UUID.test(claims.playerId) || !UUID.test(claims.sessionId)) {
    throw new PartnerError('session_ended', undefined, undefined, 'expired');
  }

  const [row] = await sql<SessionRow[]>`
    SELECT s.state, s.end_reason, s.session_expires_at, s.session_expires_at <= clock_timestamp() AS session_over,
           s.last_seen_at, s.language, p.external_player_id, p.user_id, p.display_name, p.status, p.status_version
    FROM partner_sessions s
    JOIN partner_players p ON p.id = s.player_id
    WHERE s.id = ${claims.sessionId} AND s.player_id = ${claims.playerId}
      AND s.partner_slug = ${config.slug} AND s.environment = ${config.environment}`;
  if (!row || !row.user_id) throw new PartnerError('session_ended', undefined, undefined, 'expired');
  if (row.status === 'blocked') throw new PartnerError('session_ended', undefined, undefined, 'blocked');
  if (row.state !== 'redeemed') {
    throw new PartnerError('session_ended', undefined, undefined, row.end_reason ?? 'expired');
  }
  if (row.session_over || !row.session_expires_at) {
    throw new PartnerError('session_ended', undefined, undefined, 'expired');
  }

  if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() > TOUCH_AFTER_MS) {
    // Two single-row statements, each its own transaction: holding both locks at once could deadlock with a block
    // or redeem (they lock player, then session).
    await sql`UPDATE partner_players SET last_seen_at = clock_timestamp() WHERE id = ${claims.playerId}`;
    await sql`UPDATE partner_sessions SET last_seen_at = clock_timestamp() WHERE id = ${claims.sessionId}`;
  }

  return {
    slug: config.slug,
    environment: config.environment,
    playerId: claims.playerId,
    externalPlayerId: row.external_player_id,
    userId: row.user_id,
    sessionId: claims.sessionId,
    sessionExpiresAt: row.session_expires_at,
    language: row.language,
    displayName: row.display_name ?? '',
    statusVersion: row.status_version,
  };
}

export async function partnerPlayerAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  requirePartnerConfig();
  const token = bearer(req);
  if (!token) throw new PartnerError('partner_session_required');
  req.partner = await resolvePartnerPrincipal(token);
  next();
}
