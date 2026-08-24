import { sql } from '../../db/index.js';

/**
 * Pure-data repo for the `match_visibility_events` table (shadow anti-cheat
 * telemetry). Insert-only from the realtime path; analysis reads happen
 * offline (scripts/anti-cheat/visibility-suspicion.sql).
 */

export type MatchVisibilitySignal = 'hidden' | 'visible' | 'blur' | 'focus' | 'pagehide';

interface InsertVisibilityEventInput {
  matchId: string;
  userId: string;
  signal: MatchVisibilitySignal;
  qIndex: number | null;
  questionId: string | null;
  phase: string | null;
  questionKind: string | null;
  questionOpen: boolean;
  mode: string | null;
  /** Server clock at socket receipt — NOT insert time (inserts are queued). */
  occurredAt: Date;
}

export const matchVisibilityEventsRepo = {
  async insertVisibilityEvent(data: InsertVisibilityEventInput): Promise<void> {
    await sql`
      INSERT INTO match_visibility_events (
        match_id, user_id, signal, q_index, question_id, phase, question_kind, question_open, mode, occurred_at
      )
      VALUES (
        ${data.matchId},
        ${data.userId},
        ${data.signal},
        ${data.qIndex},
        ${data.questionId},
        ${data.phase},
        ${data.questionKind},
        ${data.questionOpen},
        ${data.mode},
        ${data.occurredAt}
      )
    `;
  },
};
