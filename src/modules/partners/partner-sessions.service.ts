/** Partner sessions (contract v1.1 §5): init (machine), redeem and refresh (browser), block/unblock (machine).
 *
 *  Postgres is the authority: init locks the partner player row, claims its requestId and keeps its sealed response
 *  in one transaction; redeem locks the player, consumes the token with one conditional update and ends the
 *  player's previous session (one active session per player, §5.3); block revokes every open session and unused
 *  token in the transaction that blocks. */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sql, type TransactionSql } from '../../db/index.js';
import { asSql, type Db } from './partner-db.js';
import { logger } from '../../core/logger.js';
import { isNicknameAllowed } from '../moderation/text-moderation.js';
import { sha256Hex, type PartnerConfig } from './partner-config.js';
import { PartnerError } from './partner-errors.js';
import { emitPartnerPlayerBlocked, type PartnerPlayerBlockedEvent } from './partner-events.js';
import { partnerBegin, recordPartnerEvent } from './partner-analytics.js';
import {
  ACCESS_TTL_S,
  getResponseSealer,
  LAUNCH_TTL_S,
  newLaunchToken,
  SESSION_TTL_S,
  signPartnerAccessToken,
} from './partner-token.js';

/** Contract §3: 1–64 characters from A–Z a–z 0–9 . _ : @ -, case-sensitive. */
export const PARTNER_IDENTIFIER = /^[A-Za-z0-9._:@-]{1,64}$/;

export const initBodySchema = z.object({
  playerId: z.string().regex(PARTNER_IDENTIFIER),
  language: z.enum(['ka', 'en', 'ru']),
  channel: z.enum(['WEB', 'MOBILE']),
  requestId: z.string().regex(PARTNER_IDENTIFIER),
  username: z.string().trim().min(1).max(50),
});
export type InitBody = z.infer<typeof initBodySchema>;

export const playerStatusBodySchema = z.object({
  at: z.string().datetime({ offset: true }),
  reason: z.string().max(200).nullable().optional(),
});

export const redeemBodySchema = z.object({ token: z.string().min(20).max(200) });

export interface InitResponse {
  sessionId: string;
  oneTimeToken: string;
  expiresAt: string;
  launchUrl: string;
}

export type PartnerLanguage = 'ka' | 'en' | 'ru';

export interface RedeemResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  player: { id: string; displayName: string; language: PartnerLanguage };
  partner: { slug: string; name: string };
}

const PARTNER_NAMES: Record<string, string> = { freecroco: 'Freecroco' };

interface PartnerPlayerRow {
  id: string;
  external_player_id: string;
  user_id: string | null;
  display_name: string | null;
  status: 'active' | 'blocked';
  status_version: number;
  status_changed_at: Date | null;
  block_reason: string | null;
}

/** Thrown inside a transaction to roll it back with an answer. */
class Rollback {
  constructor(readonly outcome: InitResponse | PartnerError) {}
}

function requestHash(body: InitBody): string {
  return sha256Hex(JSON.stringify([body.playerId, body.language, body.channel, body.requestId, body.username]));
}

// Control, zero-width and bidi-override characters never reach another player's screen.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function cleanDisplayName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.normalize('NFC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, 50).trim();
  return name.length > 0 && isNicknameAllowed(name) ? name : null;
}

function placeholderName(partnerPlayerId: string): string {
  return `Player-${createHash('sha256').update(`partner-name:${partnerPlayerId}`).digest('hex').slice(0, 6)}`;
}

const HANDLE_PREFIX: Record<string, string> = { freecroco: 'fc' };

/**
 * users.nickname of a partner player: an internal handle, never shown (partner-facing names read
 * partner_players.display_name). It keeps partner players out of the members' name space, so a masked partner
 * username can never block a member from a name.
 */
export function partnerHandle(slug: string): string {
  return `${HANDLE_PREFIX[slug] ?? slug.slice(0, 2)}_${randomBytes(6).toString('hex')}`;
}

function isNicknameUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; constraint_name?: string } | null;
  return e?.code === '23505' && /nickname/.test(e.constraint_name ?? '');
}

/** The users row a partner player plays as: no Supabase identity, onboarding done, no wallet. */
async function createPartnerUser(tx: TransactionSql, config: PartnerConfig): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // postgres.js rolls back to the savepoint itself; a manual ROLLBACK TO would poison the outer begin().
      return (await tx.savepoint(async (sp) => {
        const [row] = await asSql(sp)<{ id: string }[]>`
          INSERT INTO users (email, nickname, country, onboarding_complete, is_ai, is_guest, coins, tickets, partner_slug)
          VALUES (NULL, ${partnerHandle(config.slug)}, NULL, true, false, false, 0, 0, ${config.slug})
          RETURNING id`;
        return row.id;
      })) as string;
    } catch (error) {
      if (!isNicknameUniqueViolation(error)) throw error;
    }
  }
  throw new Error('Could not allocate a partner player handle');
}

interface ClaimedSessionRow {
  request_hash: string;
  state: 'issued' | 'redeemed' | 'revoked' | 'expired';
  expired: boolean;
  sealed_response: string | null;
}

/** The answer for a requestId that is already claimed, or null when it is not. */
async function existingInit(
  db: Db,
  config: PartnerConfig,
  body: InitBody,
  hash: string,
): Promise<InitResponse | PartnerError | null> {
  const [row] = await db<ClaimedSessionRow[]>`
    SELECT request_hash, state, token_expires_at <= clock_timestamp() AS expired, sealed_response
    FROM partner_sessions
    WHERE partner_slug = ${config.slug} AND environment = ${config.environment} AND request_id = ${body.requestId}`;
  if (!row) return null;
  if (row.request_hash !== hash) return new PartnerError('request_conflict');
  // A token revoked by a block or a newer launch behaves as used (§5.1).
  if (row.state !== 'issued' || row.expired) return new PartnerError('request_used');
  const plain = row.sealed_response ? getResponseSealer().open(row.sealed_response) : null;
  if (!plain) {
    logger.error({ requestId: body.requestId }, 'Retained partner init response unreadable');
    return new PartnerError('internal_error');
  }
  return JSON.parse(plain) as InitResponse;
}

function launchUrl(config: PartnerConfig, token: string): string {
  return `${config.launchBaseUrl.replace(/\/+$/, '')}/?token=${encodeURIComponent(token)}`;
}

export async function initSession(config: PartnerConfig, body: InitBody): Promise<InitResponse> {
  const hash = requestHash(body);
  const prior = await existingInit(sql, config, body, hash);
  if (prior instanceof PartnerError) throw prior;
  if (prior) return prior;

  const sessionId = randomUUID();
  const token = newLaunchToken();
  const sealer = getResponseSealer();
  const username = cleanDisplayName(body.username);
  try {
    return await sql.begin(async (t) => {
      const tx = asSql(t);
      // The player row lock serialises every init and block of this player (and same-requestId duplicates).
      const [player] = await tx<PartnerPlayerRow[]>`
        INSERT INTO partner_players (partner_slug, environment, external_player_id)
        VALUES (${config.slug}, ${config.environment}, ${body.playerId})
        ON CONFLICT (partner_slug, environment, external_player_id)
        DO UPDATE SET partner_slug = EXCLUDED.partner_slug
        RETURNING id, external_player_id, user_id, display_name, status, status_version, status_changed_at, block_reason`;
      if (player.status === 'blocked') throw new Rollback(new PartnerError('player_blocked'));

      // Issuing, retries and redeem all read Postgres's clock.
      const [{ at }] = await tx<{ at: Date }[]>`SELECT clock_timestamp() + make_interval(secs => ${LAUNCH_TTL_S}) AS at`;
      const response: InitResponse = {
        sessionId,
        oneTimeToken: token,
        expiresAt: at.toISOString(),
        launchUrl: launchUrl(config, token),
      };
      const [{ launch_seq: launchSeq }] = await tx<{ launch_seq: string }[]>`
        UPDATE partner_players SET launch_seq = launch_seq + 1 WHERE id = ${player.id} RETURNING launch_seq`;
      const [claimed] = await tx<{ id: string }[]>`
        INSERT INTO partner_sessions
          (id, partner_slug, environment, player_id, request_id, request_hash, launch_seq, token_hash, token_expires_at,
           sealed_response, channel, language)
        VALUES (${sessionId}, ${config.slug}, ${config.environment}, ${player.id}, ${body.requestId}, ${hash},
                ${launchSeq}, ${sha256Hex(token)}, ${at}, ${sealer.seal(JSON.stringify(response))}, ${body.channel},
                ${body.language})
        ON CONFLICT (partner_slug, environment, request_id) DO NOTHING
        RETURNING id`;
      if (!claimed) {
        const outcome = await existingInit(tx, config, body, hash);
        throw new Rollback(outcome ?? new PartnerError('internal_error'));
      }

      const displayName = username ?? player.display_name ?? placeholderName(player.id);
      if (!player.user_id) {
        const userId = await createPartnerUser(t, config);
        await tx`UPDATE partner_players SET user_id = ${userId} WHERE id = ${player.id}`;
      }
      await tx`
        UPDATE partner_players SET display_name = ${displayName}, last_seen_at = clock_timestamp()
        WHERE id = ${player.id}`;
      return response;
    });
  } catch (error) {
    if (error instanceof Rollback) {
      if (error.outcome instanceof PartnerError) throw error.outcome;
      return error.outcome;
    }
    throw error;
  }
}

interface RedeemRow {
  id: string;
  state: ClaimedSessionRow['state'];
  expired: boolean;
  language: PartnerLanguage;
  channel: string;
  player_id: string;
  player_status: 'active' | 'blocked';
  display_name: string | null;
  user_id: string | null;
  first_session: boolean;
}

function recordSessionsEnded(
  t: TransactionSql,
  config: PartnerConfig,
  userId: string | null,
  ended: Array<{ id: string; was_live: boolean }>,
  reason: 'replaced' | 'blocked',
): void {
  if (!userId) return;
  for (const session of ended) {
    // Only sessions that were open: a launch never opened or a session already past its end never started one.
    if (!session.was_live) continue;
    recordPartnerEvent(t, {
      event: 'partner_session_ended',
      userId,
      slug: config.slug,
      partnerEnvironment: config.environment,
      key: session.id,
      properties: { reason },
    });
  }
}

async function accessFor(
  config: PartnerConfig,
  session: { id: string; playerId: string; sessionExpiresAt: Date; language: PartnerLanguage; displayName: string },
): Promise<RedeemResponse> {
  const expiresAt = new Date(Math.min(Date.now() + ACCESS_TTL_S * 1000, session.sessionExpiresAt.getTime()));
  const accessToken = await signPartnerAccessToken(config, { playerId: session.playerId, sessionId: session.id }, expiresAt);
  return {
    accessToken,
    accessTokenExpiresAt: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000).toISOString(),
    player: { id: session.playerId, displayName: session.displayName, language: session.language },
    partner: { slug: config.slug, name: PARTNER_NAMES[config.slug] ?? config.slug },
  };
}

/** Consumes the launch token: judged on Postgres's clock once the session row is locked. */
export async function redeemSession(config: PartnerConfig, token: string): Promise<RedeemResponse> {
  const outcome = await partnerBegin(async (t) => {
    const tx = asSql(t);
    const hash = sha256Hex(token);
    const [target] = await tx<{ player_id: string }[]>`
      SELECT player_id FROM partner_sessions
      WHERE token_hash = ${hash} AND partner_slug = ${config.slug} AND environment = ${config.environment}`;
    if (!target) return new PartnerError('token_unknown');
    // Lock order everywhere is player, then session (init and block do the same), so they never deadlock.
    await tx`SELECT 1 FROM partner_players WHERE id = ${target.player_id} FOR UPDATE`;
    const [row] = await tx<RedeemRow[]>`
      SELECT s.id, s.state, s.token_expires_at <= clock_timestamp() AS expired, s.language, s.channel,
             s.player_id, p.status AS player_status, p.display_name, p.user_id,
             NOT EXISTS (SELECT 1 FROM partner_sessions o
                         WHERE o.player_id = s.player_id AND o.id <> s.id AND o.redeemed_at IS NOT NULL) AS first_session
      FROM partner_sessions s
      JOIN partner_players p ON p.id = s.player_id
      WHERE s.token_hash = ${hash} AND s.partner_slug = ${config.slug} AND s.environment = ${config.environment}
      FOR UPDATE OF s`;
    if (!row) return new PartnerError('token_unknown');
    if (row.player_status === 'blocked') return new PartnerError('player_blocked');
    // A token revoked by a block or a newer launch behaves as used (§5.1).
    if (row.state === 'redeemed' || row.state === 'revoked') return new PartnerError('token_used');
    if (row.state !== 'issued') return new PartnerError('token_expired');
    if (row.expired) {
      await tx`
        UPDATE partner_sessions
        SET state = 'expired', end_reason = 'expired', ended_at = clock_timestamp(), sealed_response = NULL
        WHERE id = ${row.id} AND state = 'issued'`;
      return new PartnerError('token_expired');
    }
    const [consumed] = await tx<{ session_expires_at: Date; redeemed_at: Date }[]>`
      UPDATE partner_sessions
      SET state = 'redeemed', redeemed_at = clock_timestamp(),
          session_expires_at = clock_timestamp() + make_interval(secs => ${SESSION_TTL_S}),
          last_seen_at = clock_timestamp(), sealed_response = NULL
      WHERE id = ${row.id} AND state = 'issued' AND token_expires_at > clock_timestamp()
      RETURNING session_expires_at, redeemed_at`;
    if (!consumed) return new PartnerError('token_expired');
    // One active session per player (§5.3): opening this launch ends the previous session, and launches issued
    // before this one can no longer be opened. The player row lock above serialises two launches opened at once.
    const replaced = await tx<{ id: string; was_live: boolean }[]>`
      UPDATE partner_sessions earlier
      SET state = 'revoked', end_reason = 'replaced', ended_at = clock_timestamp(), sealed_response = NULL
      FROM partner_sessions opened
      WHERE opened.id = ${row.id} AND earlier.player_id = opened.player_id AND earlier.id <> opened.id
        AND (earlier.state = 'redeemed' OR (earlier.state = 'issued' AND earlier.launch_seq < opened.launch_seq))
      RETURNING earlier.id, earlier.redeemed_at IS NOT NULL AND earlier.session_expires_at > clock_timestamp() AS was_live`;
    recordSessionsEnded(t, config, row.user_id, replaced, 'replaced');
    if (row.user_id) {
      recordPartnerEvent(t, {
        event: 'partner_session_started',
        userId: row.user_id,
        slug: config.slug,
        partnerEnvironment: config.environment,
        key: row.id,
        occurredAt: consumed.redeemed_at,
        properties: { language: row.language, channel: row.channel, is_new_player: row.first_session },
      });
    }
    // Signed before commit: a signing failure must not consume the token.
    return accessFor(config, {
      id: row.id,
      playerId: row.player_id,
      sessionExpiresAt: consumed.session_expires_at,
      language: row.language,
      displayName: row.display_name ?? placeholderName(row.player_id),
    });
  });
  if (outcome instanceof PartnerError) throw outcome;
  return outcome;
}

/** A fresh access token for a session partnerPlayerAuth has just verified; never past the session's 12 h end. */
export async function refreshSession(
  config: PartnerConfig,
  principal: { sessionId: string; playerId: string; sessionExpiresAt: Date; language: PartnerLanguage; displayName: string },
): Promise<RedeemResponse> {
  return accessFor(config, {
    id: principal.sessionId,
    playerId: principal.playerId,
    sessionExpiresAt: principal.sessionExpiresAt,
    language: principal.language,
    displayName: principal.displayName,
  });
}

export interface PlayerStatusResult {
  playerId: string;
  status: 'blocked' | 'active';
}

/** Block or unblock (§5.5). Applied only when `at` is later than the last applied one; the answer is always the
 *  player's current status. */
export async function setPlayerStatus(
  config: PartnerConfig,
  externalPlayerId: string,
  target: 'blocked' | 'active',
  input: { at: Date; reason: string | null },
): Promise<PlayerStatusResult> {
  let blocked: PartnerPlayerBlockedEvent | null = null;
  const result = await partnerBegin(async (t): Promise<PlayerStatusResult> => {
    const tx = asSql(t);
    const [player] = await tx<PartnerPlayerRow[]>`
      INSERT INTO partner_players (partner_slug, environment, external_player_id)
      VALUES (${config.slug}, ${config.environment}, ${externalPlayerId})
      ON CONFLICT (partner_slug, environment, external_player_id)
      DO UPDATE SET partner_slug = EXCLUDED.partner_slug
      RETURNING id, external_player_id, user_id, display_name, status, status_version, status_changed_at, block_reason`;
    if (player.status_changed_at && input.at.getTime() <= player.status_changed_at.getTime()) {
      logger.info({ playerId: externalPlayerId, target, at: input.at }, 'Partner status change not later than the last applied; ignored');
      return { playerId: externalPlayerId, status: player.status };
    }
    const changed = player.status !== target;
    const reason = target === 'blocked' ? (input.reason ?? (changed ? null : player.block_reason)) : null;
    await tx`
      UPDATE partner_players
      SET status = ${target}, status_version = status_version + ${changed ? 1 : 0},
          status_changed_at = ${input.at}, block_reason = ${reason}
      WHERE id = ${player.id}`;
    let revoked = 0;
    let sessionsEnded = 0;
    let playsCancelled = 0;
    if (target === 'blocked') {
      const sessions = await tx<{ id: string; was_live: boolean }[]>`
        UPDATE partner_sessions
        SET state = 'revoked', end_reason = 'blocked', ended_at = clock_timestamp(), sealed_response = NULL
        WHERE player_id = ${player.id} AND state IN ('issued', 'redeemed')
        RETURNING id, redeemed_at IS NOT NULL AND session_expires_at > clock_timestamp() AS was_live`;
      revoked = sessions.length;
      sessionsEnded = sessions.filter((r) => r.was_live).length;
      recordSessionsEnded(t, config, player.user_id, sessions, 'blocked');
      // A running game ends with no score event and its play stays used (§5.5), even if the player is unblocked
      // before the game reports its result.
      const plays = await tx<{ id: string; game_id: string; partner_day: Date; started_at: Date; cancelled_at: Date }[]>`
        UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp()
        WHERE player_id = ${player.id} AND state = 'started'
        RETURNING id, game_id, partner_day, started_at, cancelled_at`;
      playsCancelled = plays.length;
      const userId = player.user_id;
      for (const play of userId ? plays : []) {
        recordPartnerEvent(t, {
          event: 'partner_play_cancelled',
          userId: userId!,
          slug: config.slug,
          partnerEnvironment: config.environment,
          key: play.id,
          occurredAt: play.cancelled_at,
          properties: {
            game_id: play.game_id,
            partner_day: play.partner_day.toISOString().slice(0, 10),
            duration_ms: Math.max(0, play.cancelled_at.getTime() - play.started_at.getTime()),
            reason: 'blocked',
            refunded: false,
          },
        });
      }
      blocked = {
        slug: config.slug,
        environment: config.environment,
        playerId: player.id,
        externalPlayerId,
        userId: player.user_id,
        revokedSessionIds: sessions.map((r) => r.id),
        cancelledPlayIds: plays.map((r) => r.id),
      };
    }
    if (changed && player.user_id) {
      recordPartnerEvent(t, {
        event: target === 'blocked' ? 'partner_player_blocked' : 'partner_player_unblocked',
        userId: player.user_id,
        slug: config.slug,
        partnerEnvironment: config.environment,
        key: `${player.id}:${player.status_version + 1}`,
        occurredAt: input.at,
        properties: target === 'blocked' ? { ended_sessions: sessionsEnded, cancelled_plays: playsCancelled } : {},
      });
    }
    if (changed || reason !== player.block_reason) {
      await tx`
        INSERT INTO partner_audit (partner_slug, environment, actor, action, target, before, after)
        VALUES (${config.slug}, ${config.environment}, ${`partner:${config.slug}`},
                ${target === 'blocked' ? 'player.block' : 'player.unblock'}, ${externalPlayerId},
                ${tx.json({ status: player.status, reason: player.block_reason })},
                ${tx.json({ status: target, reason, at: input.at.toISOString(), revokedSessions: revoked })})`;
    }
    return { playerId: externalPlayerId, status: target };
  });
  if (blocked) await emitPartnerPlayerBlocked(blocked);
  return result;
}

/** Launches never opened: once their token is past its deadline they are marked expired and their sealed answer
 *  (which holds the dead token) is dropped. Run by the partner janitor. */
export async function forgetExpiredInitResponses(): Promise<number> {
  const result = await sql`
    UPDATE partner_sessions
    SET state = 'expired', end_reason = 'expired', ended_at = clock_timestamp(), sealed_response = NULL
    WHERE state = 'issued' AND token_expires_at < now() - interval '1 minute'`;
  return result.count;
}
