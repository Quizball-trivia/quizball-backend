import { sql } from '../../../db/index.js';
import { deliveryTransaction } from './dispatcher.js';
import type { PartnerGameId } from './score-events.js';

export type DeliveryStatus = 'pending' | 'sent' | 'dead';

export interface DeliveryItem {
  eventId: string;
  playerId: string;
  gameId: PartnerGameId;
  score: number;
  occurredAt: string;
  status: DeliveryStatus;
  attempts: number;
  lastAttemptAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
}

export interface DeliveriesResponse {
  items: DeliveryItem[];
  nextCursor: string | null;
}

export interface DeliveriesQuery {
  partnerSlug: string;
  status?: DeliveryStatus;
  gameId?: PartnerGameId;
  playerId?: string;
  /** Asia/Tbilisi days (YYYY-MM-DD), both inclusive, applied to occurredAt. */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/** httpStatus when the partner answered; error is our own classification (null only for a 2xx): timeout, dns,
 *  refused, reset, tls, network, aborted, lease_expired, dead_conflict (a 409) or http_<status>. Nothing from the
 *  answer's body is ever stored. */
export interface DeliveryAttempt {
  attempt: number;
  attemptedAt: string;
  latencyMs: number | null;
  httpStatus: number | null;
  error: string | null;
}

export interface MeResultsResponse {
  results: Array<{
    playId: string;
    gameId: PartnerGameId;
    score: number;
    finishedAt: string;
    delivery: 'pending' | 'sent' | 'failed';
  }>;
}

export const DELIVERIES_DEFAULT_LIMIT = 50;
export const DELIVERIES_MAX_LIMIT = 200;
export const SCORE_EVENT_ID = /^qb_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const encodeDeliveriesCursor = (id: string) => Buffer.from(`v1.${id}`).toString('base64url');

/** The row id a cursor this API made points after, or null. */
export function decodeDeliveriesCursor(cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cursor)) return null;
  const [version, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('.');
  if (version !== 'v1' || rest.length || !id || !/^[1-9][0-9]{0,18}$/.test(id)) return null;
  return BigInt(id) <= 2n ** 63n - 1n ? id : null;
}

/** Newest first (by queue order). Throws on a cursor this API did not make; callers check it first. */
export async function listPartnerDeliveries(q: DeliveriesQuery): Promise<DeliveriesResponse> {
  const limit = Math.min(Math.max(q.limit ?? DELIVERIES_DEFAULT_LIMIT, 1), DELIVERIES_MAX_LIMIT);
  const after = q.cursor ? decodeDeliveriesCursor(q.cursor) : null;
  if (q.cursor && !after) throw new Error('invalid cursor');
  const rows = await sql<{
    id: string; event_id: string; player_id: string; game_id: PartnerGameId; score: number; occurred_at: Date;
    status: DeliveryStatus; attempts: number; last_error: string | null;
    last_attempt_at: Date | null; last_http_status: number | null;
  }[]>`
    SELECT e.id::text AS id, e.event_id, e.player_id, e.game_id, e.score, e.occurred_at, e.status, e.attempts,
      e.last_error, a.started_at AS last_attempt_at, a.http_status AS last_http_status
    FROM partner_score_events e
    LEFT JOIN LATERAL (
      SELECT started_at, http_status FROM partner_score_event_attempts
      WHERE event_row_id = e.id ORDER BY id DESC LIMIT 1
    ) a ON true
    WHERE e.partner_slug = ${q.partnerSlug}
      ${q.status ? sql`AND e.status = ${q.status}` : sql``}
      ${q.gameId ? sql`AND e.game_id = ${q.gameId}` : sql``}
      ${q.playerId ? sql`AND e.player_id = ${q.playerId}` : sql``}
      ${q.from ? sql`AND e.occurred_at >= (${q.from}::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'` : sql``}
      ${q.to ? sql`AND e.occurred_at < (${q.to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'` : sql``}
      ${after ? sql`AND e.id < ${after}::bigint` : sql``}
    ORDER BY e.id DESC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      eventId: r.event_id,
      playerId: r.player_id,
      gameId: r.game_id,
      score: r.score,
      occurredAt: r.occurred_at.toISOString(),
      status: r.status,
      attempts: r.attempts,
      lastAttemptAt: iso(r.last_attempt_at),
      lastHttpStatus: r.last_http_status,
      lastError: r.last_error,
    })),
    nextCursor: rows.length > limit ? encodeDeliveriesCursor(page[page.length - 1]!.id) : null,
  };
}

/** Oldest first; null when the partner has no such event. */
export async function listDeliveryAttempts(partnerSlug: string, eventId: string): Promise<DeliveryAttempt[] | null> {
  const [event] = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM partner_score_events WHERE event_id = ${eventId} AND partner_slug = ${partnerSlug}`;
  if (!event) return null;
  const rows = await sql<{
    attempt: number; started_at: Date; latency_ms: number | null; http_status: number | null; error: string | null;
  }[]>`
    SELECT attempt, started_at, latency_ms, http_status, error
    FROM partner_score_event_attempts WHERE event_row_id = ${event.id}::bigint ORDER BY id`;
  return rows.map((r) => ({
    attempt: r.attempt,
    attemptedAt: r.started_at.toISOString(),
    latencyMs: r.latency_ms,
    httpStatus: r.http_status,
    error: r.error,
  }));
}

export type ResendResult =
  | { ok: true; eventId: string; status: 'pending' }
  | { ok: false; code: 'not_found' | 'not_resendable'; message: string };

/**
 * Requeues a dead event (same eventId, same frozen body) for another 24-hour retry window, to the current
 * destination, and audits it in the same transaction. Dead rows hold no lease, so nothing else is sending it.
 */
export async function resendPartnerScoreEvent(input: {
  partnerSlug: string; eventId: string; actorId: string; reason?: string;
}): Promise<ResendResult> {
  return deliveryTransaction(sql, async (tx) => {
    const [row] = await tx<{ id: string; play_id: string; status: DeliveryStatus; attempts: number }[]>`
      SELECT id::text AS id, play_id::text AS play_id, status, attempts
      FROM partner_score_events
      WHERE event_id = ${input.eventId} AND partner_slug = ${input.partnerSlug}
      FOR UPDATE`;
    if (!row) return { ok: false, code: 'not_found', message: 'No such event' } as const;
    if (row.status !== 'dead') {
      return { ok: false, code: 'not_resendable', message: `Only dead events can be resent (this one is ${row.status})` } as const;
    }
    await tx`
      UPDATE partner_score_events SET status = 'pending', next_attempt_at = now(), revived_at = now(),
        lease_token = NULL, lease_expires_at = NULL, destination = NULL
      WHERE id = ${row.id}::bigint`;
    await tx`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
      VALUES (${input.actorId}, 'partner_score_event.resend', 'partner_score_event', ${row.play_id},
              ${tx.json({
                eventId: input.eventId,
                partner: input.partnerSlug,
                attempts: row.attempts,
                reason: input.reason ?? null,
              })})`;
    return { ok: true, eventId: input.eventId, status: 'pending' } as const;
  });
}

/** `GET /partner/v1/me/results`: the player's latest finished plays and how their score events stand. */
export async function listRecentResultsForPlayer(
  partner: { slug: string; environment: string; externalPlayerId: string },
  limit = 20,
): Promise<MeResultsResponse> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const rows = await sql<{
    play_id: string; game_id: PartnerGameId; score: number; occurred_at: Date; status: DeliveryStatus;
  }[]>`
    SELECT play_id::text AS play_id, game_id, score, occurred_at, status
    FROM partner_score_events
    WHERE partner_slug = ${partner.slug} AND environment = ${partner.environment} AND player_id = ${partner.externalPlayerId}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${capped}`;
  return {
    results: rows.map((r) => ({
      playId: r.play_id,
      gameId: r.game_id,
      score: r.score,
      finishedAt: r.occurred_at.toISOString(),
      delivery: r.status === 'dead' ? 'failed' : r.status,
    })),
  };
}

export interface ScoreDeliveryHealth {
  status: 'ok' | 'degraded' | 'down';
  pending: number;
  oldestPendingSeconds: number;
}

/** Contract v1.1 §5.6 `score_delivery`: degraded when the oldest undelivered event (aged from the start of its
 *  retry window) is older than 5 minutes, down after 1 hour. */
export async function getScoreDeliveryHealth(partnerSlug = 'freecroco'): Promise<ScoreDeliveryHealth> {
  const [row] = await sql<{ pending: number; oldest_s: number | null }[]>`
    SELECT count(*)::int AS pending,
      floor(extract(epoch FROM now() - min(coalesce(revived_at, created_at))))::int AS oldest_s
    FROM partner_score_events
    WHERE partner_slug = ${partnerSlug} AND status = 'pending'`;
  const oldestPendingSeconds = Math.max(0, row?.oldest_s ?? 0);
  const status = oldestPendingSeconds > 3600 ? 'down' : oldestPendingSeconds > 300 ? 'degraded' : 'ok';
  return { status, pending: row?.pending ?? 0, oldestPendingSeconds };
}
