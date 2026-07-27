/**
 * Read-only calibration queries. All are pure SELECTs run through the
 * read-only DB runner. They mirror the exclusion rules in
 * src/modules/bots/calibration/{constants,aggregate}.ts. The timeout-backfill
 * predicate is inlined per query (with ::int casts) rather than shared as a raw
 * fragment, so every statement stays a screenable tagged template.
 */

import type { ReadOnlyRunner } from './readonly-db.js';
import { FULL_DURATION_MS, TIMING_CLEAN_WINDOW_START, BERNOULLI_LOGIT_TYPES } from '../../src/modules/bots/calibration/constants.js';

const D = FULL_DURATION_MS;

export interface BatchRow {
  id: string;
  season_number: number | null;
  completed_at: string | null;
}

/** Resolve the S1 reset batch (by explicit id, by season, or earliest completed). */
export async function resolveBatch(
  query: ReadOnlyRunner,
  opts: { batchId?: string; season?: number },
): Promise<BatchRow | null> {
  if (opts.batchId) {
    const rows = await query<BatchRow[]>`
      SELECT id, season_number, completed_at FROM ranked_reset_batches WHERE id = ${opts.batchId}`;
    return rows[0] ?? null;
  }
  if (opts.season != null) {
    const rows = await query<BatchRow[]>`
      SELECT id, season_number, completed_at FROM ranked_reset_batches
      WHERE season_number = ${opts.season}
      ORDER BY completed_at NULLS LAST LIMIT 1`;
    return rows[0] ?? null;
  }
  const rows = await query<BatchRow[]>`
    SELECT id, season_number, completed_at FROM ranked_reset_batches
    ORDER BY completed_at NULLS LAST LIMIT 1`;
  return rows[0] ?? null;
}

export interface ArchivedProfile {
  user_id: string;
  rp: number;
  tier: string | null;
  placement_status: string | null;
}

/** Placed, non-AI/seed/deleted archived S1 profiles for the batch. */
export async function fetchPlacedProfiles(query: ReadOnlyRunner, batchId: string): Promise<ArchivedProfile[]> {
  return query<ArchivedProfile[]>`
    SELECT rpa.user_id, rpa.rp, rpa.tier, rpa.placement_status
    FROM ranked_profiles_archive rpa
    JOIN users u ON u.id = rpa.user_id
    WHERE rpa.reset_batch_id = ${batchId}
      AND rpa.placement_status = 'placed'
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL`;
}

export interface BernoulliAnswerRow {
  player_id: string;
  question_id: string;
  format: string;
  correct: boolean;
}

/**
 * Bernoulli answers (mcq/true_false/input_text) for latent-skill fitting.
 * Excludes AI/seed/deleted users, dev matches, timeout backfills; only
 * completed ranked matches. `limit` caps rows scanned for smoke runs.
 */
export async function fetchBernoulliAnswers(
  query: ReadOnlyRunner,
  opts: { limit?: number } = {},
): Promise<BernoulliAnswerRow[]> {
  const types = BERNOULLI_LOGIT_TYPES as unknown as string[];
  // A NULL bound disables the LIMIT (LIMIT NULL returns all rows in Postgres),
  // so one statement covers both the full run and a --limit smoke run.
  const limit = opts.limit && opts.limit > 0 ? opts.limit : null;
  return query<BernoulliAnswerRow[]>`
    SELECT ma.user_id AS player_id, mq.question_id, q.type AS format, ma.is_correct AS correct
    FROM match_answers ma
    JOIN matches m          ON m.id = ma.match_id
    JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q        ON q.id = mq.question_id
    JOIN users u            ON u.id = ma.user_id
    WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL
      AND q.type = ANY(${types})
      AND NOT (
        ma.selected_index IS NULL
        AND ma.is_correct = false
        AND ma.points_earned = 0
        AND ma.time_ms = CASE
          WHEN q.type = 'put_in_order'   THEN ${D.putInOrder}::int
          WHEN q.type = 'countdown_list' THEN ${D.countdown}::int
          WHEN q.type = 'clue_chain'     THEN ${D.clues}::int
          ELSE ${D.multipleChoice}::int
        END
      )
    LIMIT ${limit}::int`;
}

/** Clean-window answer times for a set of players (for the speed floor). */
export async function fetchCleanTimesForPlayers(
  query: ReadOnlyRunner,
  playerIds: readonly string[],
): Promise<number[]> {
  if (playerIds.length === 0) return [];
  const rows = await query<{ time_ms: number }[]>`
    SELECT ma.time_ms
    FROM match_answers ma
    JOIN matches m          ON m.id = ma.match_id
    JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q        ON q.id = mq.question_id
    WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND ma.user_id = ANY(${playerIds as string[]})
      AND ma.answered_at >= ${TIMING_CLEAN_WINDOW_START}::timestamptz
      AND ma.time_ms > 0
      AND NOT (
        ma.selected_index IS NULL
        AND ma.is_correct = false
        AND ma.points_earned = 0
        AND ma.time_ms = CASE
          WHEN q.type = 'put_in_order'   THEN ${D.putInOrder}::int
          WHEN q.type = 'countdown_list' THEN ${D.countdown}::int
          WHEN q.type = 'clue_chain'     THEN ${D.clues}::int
          ELSE ${D.multipleChoice}::int
        END
      )`;
  return rows.map((r) => r.time_ms);
}
