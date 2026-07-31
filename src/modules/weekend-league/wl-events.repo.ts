/**
 * wl_events outbox — allocation, leased claiming, fenced delivery.
 *
 * Contract:
 *  - Events are allocated INSIDE the transaction that commits the state
 *    change they describe, numbered by wl_tournaments.next_event_seq (the
 *    allocator row-update serializes concurrent allocators ⇒ gapless).
 *  - Public delivery is strictly in seq order: a claimant targets the EXACT
 *    minimum non-terminal seq (never SKIP-LOCKED past it — briefly blocking
 *    on the head row beats emitting seq N+1 before N), holds a 10s fenced
 *    lease renewed around the emission, and every write carries the token.
 *  - Delivery marking also advances the tournament's live_delivered_seq, so
 *    outbox progress is observable without scanning wl_events.
 *  - A poison head (attempts ≥ 5) pauses the tournament; recovery is the
 *    audited ops skip (skipped_at), after which the queue drains normally.
 */

import { randomUUID } from 'node:crypto';
import { sql } from '../../db/index.js';

export const WL_EVENT_LEASE_MS = 10_000;
export const WL_EVENT_POISON_ATTEMPTS = 5;

export type WlEventType =
  | 'phase' | 'dispatch' | 'clue_reveal' | 'reveal' | 'void'
  | 'game_result' | 'final_result' | 'cancellation';

export interface WlEventRow {
  tournament_id: string;
  seq: number;
  type: WlEventType;
  payload: Record<string, unknown>;
  redis_time_ms: number;
  live_emitted_redis_ms: number | null;
  visible_at_spec_ms: number | null;
  attempts: number;
  claim_token: string | null;
}

type Tx = typeof sql;

export const wlEventsRepo = {
  /** Allocate the next seq + insert — INSIDE the owning transaction. */
  async append(
    tx: Tx,
    input: {
      tournamentId: string;
      type: WlEventType;
      payload: Record<string, unknown>;
      redisTimeMs: number;
    }
  ): Promise<number> {
    const [row] = await tx<{ seq: string }[]>`
      WITH allocated AS (
        UPDATE wl_tournaments
        SET next_event_seq = next_event_seq + 1
        WHERE id = ${input.tournamentId}
        RETURNING next_event_seq AS seq
      )
      INSERT INTO wl_events (tournament_id, seq, type, payload, redis_time_ms)
      SELECT ${input.tournamentId}, allocated.seq, ${input.type},
             ${tx.json(input.payload as never)}, ${input.redisTimeMs}
      FROM allocated
      RETURNING seq::text
    `;
    if (!row) throw new Error(`wl_events append failed for tournament ${input.tournamentId}`);
    return Number(row.seq);
  },

  /**
   * Claim the EXACT minimum non-terminal event. The head seq is read first,
   * then the conditional claim targets that specific row — a concurrent
   * holder makes the claim return null (retry next pass); the head is never
   * skipped, so emission order is total.
   */
  async claimNext(tournamentId: string): Promise<(WlEventRow & { claim_token: string }) | null> {
    const head = await this.pendingHead(tournamentId);
    if (!head) return null;
    const token = randomUUID();
    const [row] = await sql<WlEventRow[]>`
      UPDATE wl_events e
      SET claim_token = ${token},
          claim_expires_at = NOW() + make_interval(secs => ${WL_EVENT_LEASE_MS / 1000}),
          attempts = e.attempts + 1
      WHERE e.tournament_id = ${tournamentId} AND e.seq = ${head.seq}
        AND e.delivered_at IS NULL AND e.aborted_at IS NULL AND e.skipped_at IS NULL
        AND (e.claim_token IS NULL OR e.claim_expires_at < NOW())
      RETURNING e.tournament_id, e.seq, e.type, e.payload, e.redis_time_ms,
                e.live_emitted_redis_ms, e.visible_at_spec_ms, e.attempts, e.claim_token
    `;
    return row ? { ...row, seq: Number(row.seq), claim_token: token } : null;
  },

  /** Fenced lease renewal; false = lost (abort the attempt, do not emit). */
  async renewLease(tournamentId: string, seq: number, token: string): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET claim_expires_at = NOW() + make_interval(secs => ${WL_EVENT_LEASE_MS / 1000})
      WHERE tournament_id = ${tournamentId} AND seq = ${seq}
        AND claim_token = ${token}
        AND delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /**
   * Record the emission attempt (fenced), BEFORE the physical broadcast.
   * The FIRST attempt time is preserved; spectator visibility is pushed out
   * on every retry (GREATEST) so a crash-delayed re-emission can never let
   * spectators see an event at (or before) the moment players do.
   */
  async markLiveEmission(
    tournamentId: string,
    seq: number,
    token: string,
    redisNowMs: number,
    spectatorDelayMs: number
  ): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET live_emitted_redis_ms = COALESCE(live_emitted_redis_ms, ${redisNowMs}),
          visible_at_spec_ms = GREATEST(
            COALESCE(visible_at_spec_ms, 0), ${redisNowMs + spectatorDelayMs}
          )
      WHERE tournament_id = ${tournamentId} AND seq = ${seq} AND claim_token = ${token}
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /**
   * Fenced payload enrichment for dispatch events: persists the one-shot
   * playable/deadline stamps so the spectator replay (which re-reads the
   * stored payload 30s later) carries the same timing the players saw.
   */
  async persistDispatchStamps(
    tournamentId: string,
    seq: number,
    token: string,
    playableAt: number,
    deadlineAt: number
  ): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET payload = payload
        || jsonb_build_object('playableAt', ${playableAt}::bigint, 'deadlineAt', ${deadlineAt}::bigint)
      WHERE tournament_id = ${tournamentId} AND seq = ${seq} AND claim_token = ${token}
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /** Fenced terminal delivery mark + live cursor advance, atomically. */
  async markDelivered(tournamentId: string, seq: number, token: string): Promise<boolean> {
    const rows = await sql`
      WITH marked AS (
        UPDATE wl_events
        SET delivered_at = NOW()
        WHERE tournament_id = ${tournamentId} AND seq = ${seq}
          AND claim_token = ${token} AND delivered_at IS NULL
        RETURNING seq
      )
      UPDATE wl_tournaments t
      SET live_delivered_seq = GREATEST(t.live_delivered_seq, marked.seq)
      FROM marked
      WHERE t.id = ${tournamentId}
      RETURNING t.id
    `;
    return rows.length > 0;
  },

  /** Terminal abort for a dispatch that was never emitted (crash-void path). */
  async markAborted(tournamentId: string, seq: number, token: string, reason: string): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET aborted_at = NOW(), last_error = ${reason}
      WHERE tournament_id = ${tournamentId} AND seq = ${seq}
        AND claim_token = ${token} AND delivered_at IS NULL AND aborted_at IS NULL
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /**
   * Audited ops recovery: terminally skip the CURRENT poison head. Guarded
   * on the exact seq + attempts threshold so a racing delivery cannot be
   * skipped by accident.
   */
  async skipPoisonHead(tournamentId: string, seq: number, actor: string): Promise<boolean> {
    // Atomic guards: the tournament must (still) be paused, the row must be
    // the exact head, at/over the poison threshold, AND have no LIVE lease —
    // an active claimant may be mid-emission and must not be yanked away.
    const rows = await sql`
      UPDATE wl_events e
      SET skipped_at = NOW(), last_error = ${'ops_skip:' + actor}
      WHERE e.tournament_id = ${tournamentId} AND e.seq = ${seq}
        AND e.delivered_at IS NULL AND e.aborted_at IS NULL AND e.skipped_at IS NULL
        AND e.attempts >= ${WL_EVENT_POISON_ATTEMPTS}
        AND (e.claim_token IS NULL OR e.claim_expires_at < NOW())
        AND EXISTS (
          SELECT 1 FROM wl_tournaments t
          WHERE t.id = e.tournament_id AND t.status = 'paused'
        )
        AND NOT EXISTS (
          SELECT 1 FROM wl_events p
          WHERE p.tournament_id = e.tournament_id AND p.seq < e.seq
            AND p.delivered_at IS NULL AND p.aborted_at IS NULL AND p.skipped_at IS NULL
        )
      RETURNING e.seq
    `;
    return rows.length > 0;
  },

  async recordError(tournamentId: string, seq: number, token: string, message: string): Promise<void> {
    await sql`
      UPDATE wl_events
      SET last_error = ${message}, claim_token = NULL, claim_expires_at = NULL
      WHERE tournament_id = ${tournamentId} AND seq = ${seq} AND claim_token = ${token}
    `;
  },

  /**
   * Tournaments with ANY outstanding outbox work — pending live events or a
   * spectator cursor behind the live one — INCLUDING terminal tournaments,
   * so a completed/cancelled event still drains to players and spectators.
   */
  async listTournamentsWithPendingWork(): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
      SELECT DISTINCT t.id
      FROM wl_tournaments t
      WHERE t.spec_delivered_seq < t.live_delivered_seq
         OR EXISTS (
           SELECT 1 FROM wl_events e
           WHERE e.tournament_id = t.id
             AND e.delivered_at IS NULL AND e.aborted_at IS NULL AND e.skipped_at IS NULL
         )
    `;
    return rows.map((r) => r.id);
  },

  /** Events delivered live whose spectator visibility time has arrived. */
  async spectatorDue(
    tournamentId: string,
    afterSeq: number,
    redisNowMs: number,
    limit = 50
  ): Promise<WlEventRow[]> {
    const rows = await sql<WlEventRow[]>`
      SELECT tournament_id, seq, type, payload, redis_time_ms,
             live_emitted_redis_ms, visible_at_spec_ms, attempts, claim_token
      FROM wl_events
      WHERE tournament_id = ${tournamentId}
        AND seq > ${afterSeq}
        AND delivered_at IS NOT NULL
        AND visible_at_spec_ms IS NOT NULL
        AND visible_at_spec_ms <= ${redisNowMs}
      ORDER BY seq ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
  },

  /** Fenced spectator-cursor advance (monotonic). */
  async advanceSpectatorCursor(tournamentId: string, toSeq: number): Promise<void> {
    await sql`
      UPDATE wl_tournaments
      SET spec_delivered_seq = GREATEST(spec_delivered_seq, ${toSeq})
      WHERE id = ${tournamentId}
    `;
  },

  async pendingHead(
    tournamentId: string
  ): Promise<{ seq: number; attempts: number; claimLive: boolean } | null> {
    const [row] = await sql<{ seq: string; attempts: number; claim_live: boolean }[]>`
      SELECT seq::text, attempts,
             (claim_token IS NOT NULL AND claim_expires_at >= NOW()) AS claim_live
      FROM wl_events
      WHERE tournament_id = ${tournamentId}
        AND delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL
      ORDER BY seq ASC LIMIT 1
    `;
    return row ? { seq: Number(row.seq), attempts: row.attempts, claimLive: row.claim_live } : null;
  },
};
