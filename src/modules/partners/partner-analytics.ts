/** Server-side PostHog events for partner players (docs/FREECROCO-POSTHOG-DASHBOARD.md). The browser never sends
 *  PostHog on a partner host, so these are the only partner analytics. distinct_id is the player's users.id (never
 *  the partner's playerId); core/analytics adds access_type 'partner' and keeps them off PostHog persons.
 *
 *  Events that describe a database change are recorded on the transaction that makes it and sent only once that
 *  transaction has committed: run it with partnerBegin (and partnerSavepoint for savepoints inside it). A rolled-back
 *  transaction or savepoint sends nothing. Sending is fire-and-forget and never fails the caller. */

import { stableAnalyticsEventUuid, trackEvent } from '../../core/analytics.js';
import { logger } from '../../core/logger.js';
import { sql, type TransactionSql } from '../../db/index.js';
import { scoreEventIdFor } from './delivery/score-events.js';

export type PartnerEventName =
  | 'partner_session_started'
  | 'partner_session_ended'
  | 'partner_play_started'
  | 'partner_play_finished'
  | 'partner_play_cancelled'
  | 'partner_ranked_match_found'
  | 'partner_score_delivered'
  | 'partner_score_delivery_failed'
  | 'partner_player_blocked'
  | 'partner_player_unblocked';

export interface PartnerAnalyticsEvent {
  event: PartnerEventName;
  /** users.id of the partner player. */
  userId: string;
  slug: string;
  partnerEnvironment: string;
  /** Unique per occurrence: becomes the PostHog uuid, so a duplicate send is deduplicated. */
  key: string;
  occurredAt?: Date;
  properties?: Record<string, string | number | boolean | null | undefined>;
}

/** Ranked-only details of a finished play. */
export interface PartnerPlayDetails {
  endCause?: string;
  outcome?: 'win' | 'loss' | 'draw';
  /** Own goals minus the opponent's. */
  goalMargin?: number;
  opponentKind?: OpponentKind;
}

export type OpponentKind = 'partner' | 'bot' | 'member';

export function opponentKind(user: { partner_slug: string | null; is_ai: boolean | null } | undefined): OpponentKind {
  if (user?.partner_slug) return 'partner';
  return user?.is_ai ? 'bot' : 'member';
}

export function trackPartnerEvent(e: PartnerAnalyticsEvent): void {
  try {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(e.properties ?? {})) if (value !== undefined) properties[name] = value;
    trackEvent(
      e.event,
      e.userId,
      { ...properties, partner_slug: e.slug, partner_environment: e.partnerEnvironment },
      { uuid: stableAnalyticsEventUuid(`${e.event}:${e.key}`), occurredAt: e.occurredAt },
    );
  } catch (error) {
    logger.warn({ err: error, event: e.event }, 'Partner analytics event not sent');
  }
}

const pending = new WeakMap<object, PartnerAnalyticsEvent[]>();

function collect(tx: unknown, events: PartnerAnalyticsEvent[]): void {
  if ((typeof tx === 'object' && tx !== null) || typeof tx === 'function') pending.set(tx, events);
}

/** sql.begin that sends the partner events recorded on its transaction once it has committed. */
export async function partnerBegin<T>(work: (tx: TransactionSql) => T | Promise<T>): Promise<T> {
  const events: PartnerAnalyticsEvent[] = [];
  const result = await sql.begin((tx) => {
    collect(tx, events);
    return work(tx);
  });
  for (const e of events) trackPartnerEvent(e);
  return result as T;
}

/** tx.savepoint whose recorded events join the enclosing transaction's only if the savepoint is released. */
export async function partnerSavepoint<T>(tx: TransactionSql, work: (sp: TransactionSql) => T | Promise<T>): Promise<T> {
  const events: PartnerAnalyticsEvent[] = [];
  const result = await tx.savepoint((sp) => {
    collect(sp, events);
    return work(sp);
  });
  for (const e of events) recordPartnerEvent(tx, e);
  return result as T;
}

/** Queues an event to send when `tx` commits. */
export function recordPartnerEvent(tx: TransactionSql, e: PartnerAnalyticsEvent): void {
  const events = pending.get(tx);
  if (events) {
    events.push(e);
    return;
  }
  // Its commit cannot be observed, so sending now could report a change that is then rolled back.
  logger.error({ event: e.event }, 'Partner analytics event recorded outside partnerBegin; dropped');
}

export interface ScoreDeliveryOutcome {
  eventId: string;
  status: 'sent' | 'dead';
  attempts: number;
  lastError: string | null;
}

/** A score event reached its final state (sent, or dead after its retries). Called after that state committed. */
export async function trackScoreDeliveryOutcome(o: ScoreDeliveryOutcome): Promise<void> {
  const playId = o.eventId.replace(/^qb_/, '');
  if (scoreEventIdFor(playId) !== o.eventId) return;
  const [row] = await sql<{ user_id: string | null; partner_slug: string; environment: string; game_id: string; age_ms: number }[]>`
    SELECT pp.user_id, e.partner_slug, e.environment, e.game_id,
           floor(extract(epoch FROM clock_timestamp() - e.occurred_at) * 1000)::float8 AS age_ms
    FROM partner_score_events e
    JOIN partner_plays pl ON pl.id = e.play_id
    JOIN partner_players pp ON pp.id = pl.player_id
    WHERE e.event_id = ${o.eventId}`;
  if (!row?.user_id) return;
  const base = { userId: row.user_id, slug: row.partner_slug, partnerEnvironment: row.environment };
  if (o.status === 'sent') {
    trackPartnerEvent({
      ...base,
      event: 'partner_score_delivered',
      key: o.eventId,
      properties: { game_id: row.game_id, attempts: o.attempts, delivery_delay_ms: row.age_ms },
    });
  } else {
    trackPartnerEvent({
      ...base,
      event: 'partner_score_delivery_failed',
      // A dead event can be resent and die again.
      key: `${o.eventId}:${o.attempts}`,
      properties: { game_id: row.game_id, attempts: o.attempts, final_status: 'dead', last_error: o.lastError },
    });
  }
}
