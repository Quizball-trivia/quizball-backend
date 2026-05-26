import { sql, type TransactionSql } from '../../db/index.js';
import type { MatchGoalEventRow, MatchQuestionPhaseKind } from './matches.types.js';

/**
 * Pure-data repo for the `match_goal_events` table.
 *
 * Owns inserts and reads of goal-event rows. Cross-entity work
 * (incrementing player goal counters atomically with the insert)
 * lives in `matchesService` so the transaction stays at one
 * service-owned `sql.begin` boundary — see
 * `matchesService.incrementGoalsAndInsertEventIfMissing`.
 */

interface InsertGoalEventInput {
  matchId: string;
  userId: string;
  seat: 1 | 2;
  half: 1 | 2;
  phaseKind: MatchQuestionPhaseKind;
  qIndex: number | null;
  isPenalty: boolean;
}

export const matchEventsRepo = {
  /**
   * Idempotent insert. Returns the new row, or `null` when an event
   * with the same (match_id, user_id, phase_kind, q_index, is_penalty)
   * already exists. Safe to call from retries.
   */
  async insertGoalEventIfMissing(data: InsertGoalEventInput): Promise<MatchGoalEventRow | null> {
    const [row] = await sql<MatchGoalEventRow[]>`
      INSERT INTO match_goal_events (
        match_id, user_id, seat, half, phase_kind, q_index, is_penalty
      )
      VALUES (
        ${data.matchId},
        ${data.userId},
        ${data.seat},
        ${data.half},
        ${data.phaseKind},
        ${data.qIndex},
        ${data.isPenalty}
      )
      ON CONFLICT (match_id, user_id, phase_kind, q_index, is_penalty) DO NOTHING
      RETURNING *
    `;
    return row ?? null;
  },

  /**
   * Tx-aware variant for service orchestrators that need to insert a
   * goal event and update related rows (e.g. player counters) inside
   * one transaction.
   */
  async insertGoalEventIfMissingInTx(
    tx: TransactionSql,
    data: InsertGoalEventInput,
  ): Promise<MatchGoalEventRow | null> {
    const rows = await tx.unsafe<MatchGoalEventRow[]>(
      `
      INSERT INTO match_goal_events (
        match_id, user_id, seat, half, phase_kind, q_index, is_penalty
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (match_id, user_id, phase_kind, q_index, is_penalty) DO NOTHING
      RETURNING *
      `,
      [data.matchId, data.userId, data.seat, data.half, data.phaseKind, data.qIndex, data.isPenalty],
    );
    return rows[0] ?? null;
  },
};
