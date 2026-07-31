/**
 * wl_events outbox — allocation, leased claiming, fenced delivery.
 *
 * Contract (from the converged design):
 *  - Events are allocated INSIDE the transaction that commits the state
 *    change they describe, numbered by wl_tournaments.next_event_seq
 *    (atomic row update ⇒ gapless per tournament).
 *  - Public delivery is strictly in seq order: a claimant may only claim the
 *    LOWEST non-terminal seq, holds a 10s lease (heartbeat 3s), and every
 *    write is fenced by the claim token. Later events wait until the head is
 *    terminal (delivered / aborted / ops-skipped).
 *  - Any poison event (attempts ≥ 5) pauses the tournament for ops.
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
  /**
   * Allocate the next seq and insert the event — call INSIDE the same
   * transaction as the state change it describes.
   */
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
   * Claim the lowest non-terminal event for a tournament. Returns null when
   * the head is already claimed under a live lease, or nothing is pending.
   * Claiming increments attempts; the poison check is the caller's duty.
   */
  async claimNext(tournamentId: string): Promise<(WlEventRow & { claim_token: string }) | null> {
    const token = randomUUID();
    const [row] = await sql<WlEventRow[]>`
      UPDATE wl_events e
      SET claim_token = ${token},
          claim_expires_at = NOW() + make_interval(secs => ${WL_EVENT_LEASE_MS / 1000}),
          attempts = e.attempts + 1
      WHERE (e.tournament_id, e.seq) = (
        SELECT tournament_id, seq FROM wl_events
        WHERE tournament_id = ${tournamentId}
          AND delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL
        ORDER BY seq ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
        AND (e.claim_token IS NULL OR e.claim_expires_at < NOW())
      RETURNING e.tournament_id, e.seq, e.type, e.payload, e.redis_time_ms,
                e.live_emitted_redis_ms, e.visible_at_spec_ms, e.attempts, e.claim_token
    `;
    return row ? { ...row, seq: Number(row.seq), claim_token: token } : null;
  },

  /** Heartbeat the lease; false = fence lost (another claimant took over). */
  async renewLease(tournamentId: string, seq: number, token: string): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET claim_expires_at = NOW() + make_interval(secs => ${WL_EVENT_LEASE_MS / 1000})
      WHERE tournament_id = ${tournamentId} AND seq = ${seq}
        AND claim_token = ${token} AND delivered_at IS NULL
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /**
   * Record the live emission time (fenced) — set immediately BEFORE the
   * physical broadcast so the spectator delay is measured from the first
   * emission attempt and can only stretch, never shrink.
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
          visible_at_spec_ms = COALESCE(visible_at_spec_ms, ${redisNowMs + spectatorDelayMs})
      WHERE tournament_id = ${tournamentId} AND seq = ${seq} AND claim_token = ${token}
      RETURNING seq
    `;
    return rows.length > 0;
  },

  /** Fenced terminal mark after successful delivery. */
  async markDelivered(tournamentId: string, seq: number, token: string): Promise<boolean> {
    const rows = await sql`
      UPDATE wl_events
      SET delivered_at = NOW()
      WHERE tournament_id = ${tournamentId} AND seq = ${seq}
        AND claim_token = ${token} AND delivered_at IS NULL
      RETURNING seq
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

  async recordError(tournamentId: string, seq: number, token: string, message: string): Promise<void> {
    await sql`
      UPDATE wl_events
      SET last_error = ${message}, claim_token = NULL, claim_expires_at = NULL
      WHERE tournament_id = ${tournamentId} AND seq = ${seq} AND claim_token = ${token}
    `;
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

  async pendingHead(tournamentId: string): Promise<{ seq: number; attempts: number } | null> {
    const [row] = await sql<{ seq: string; attempts: number }[]>`
      SELECT seq::text, attempts FROM wl_events
      WHERE tournament_id = ${tournamentId}
        AND delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL
      ORDER BY seq ASC LIMIT 1
    `;
    return row ? { seq: Number(row.seq), attempts: row.attempts } : null;
  },
};
