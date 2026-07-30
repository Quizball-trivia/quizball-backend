/**
 * Read-only calibration queries. All are pure SELECTs run through the read-only
 * DB runner. Exclusions mirror src/modules/bots/calibration/*.
 *
 * S1 scoping (finding #1): the Bernoulli fit dataset is restricted to matches
 * that ended BEFORE the S1 reset batch was created, AND to players who hold a
 * PLACED archived S1 profile in that batch. This keeps S2 answers and unplaced
 * players out of the fit, the anchor, and the top cohort.
 */

import type { ReadOnlyRunner } from './readonly-db.js';
import { BERNOULLI_TYPES } from '../../src/modules/bots/calibration/constants.js';

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
      ORDER BY season_number DESC NULLS LAST, completed_at DESC NULLS LAST LIMIT 1`;
    return rows[0] ?? null;
  }
  const rows = await query<BatchRow[]>`
    SELECT id, season_number, completed_at FROM ranked_reset_batches
    ORDER BY season_number DESC NULLS LAST, completed_at DESC NULLS LAST LIMIT 1`;
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
  correct: boolean;
}

/**
 * Number of players fetched per query batch. A single query streaming every
 * placed player's answers can produce a multi-million-row result that the
 * transaction pooler kills mid-stream; batching keeps each statement's result
 * bounded and each runs in its own short READ ONLY transaction, which poolers
 * tolerate. 50 is a safe default against the Supabase transaction pooler.
 */
const PLAYER_FETCH_BATCH = 50;

/**
 * Season-1 Bernoulli answers for latent-skill fitting. Restricted to:
 *  - matches ended strictly before `s1Boundary` (Season-1 play only);
 *  - the placed S1 player set (`placedPlayerIds`);
 *  - Bernoulli kinds (mcq_single / true_false / input_text);
 *  - genuine answers (selected_index IS NOT NULL excludes backfills exactly);
 *  - completed non-dev ranked matches, non-AI/seed/deleted users.
 *
 * Fetched in PLAYER_FETCH_BATCH-sized player batches (see the constant) so a
 * huge streamed result cannot be killed by the pooler. `limit` caps the total
 * rows (smoke runs) and short-circuits once reached.
 */
/** Transient network faults (pooler resets) between batches are recoverable:
 * each batch is an independent READ ONLY transaction, so a plain retry cannot
 * duplicate or lose rows. */
export async function withBatchRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      if (!/ECONNRESET|CONNECTION_CLOSED|ETIMEDOUT|EPIPE/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchS1BernoulliAnswers(
  query: ReadOnlyRunner,
  opts: { s1Boundary: string; placedPlayerIds: readonly string[]; limit?: number },
): Promise<BernoulliAnswerRow[]> {
  if (opts.placedPlayerIds.length === 0) return [];
  const types = BERNOULLI_TYPES as unknown as string[];
  const cap = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;

  const out: BernoulliAnswerRow[] = [];
  for (let i = 0; i < opts.placedPlayerIds.length && out.length < cap; i += PLAYER_FETCH_BATCH) {
    const batch = opts.placedPlayerIds.slice(i, i + PLAYER_FETCH_BATCH) as string[];
    const batchCap = Number.isFinite(cap) ? cap - out.length : null;
    const rows = await withBatchRetry(() => query<BernoulliAnswerRow[]>`
      SELECT ma.user_id AS player_id, mq.question_id, ma.is_correct AS correct
      FROM match_answers ma
      JOIN matches m          ON m.id = ma.match_id
      JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
      JOIN questions q        ON q.id = mq.question_id
      JOIN users u            ON u.id = ma.user_id
      WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
        AND m.ended_at IS NOT NULL AND m.ended_at < ${opts.s1Boundary}::timestamptz
        AND ma.user_id = ANY(${batch})
        AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL
        AND q.type = ANY(${types})
        AND ma.selected_index IS NOT NULL
      LIMIT ${batchCap}::int`);
    out.push(...rows);
  }
  return Number.isFinite(cap) ? out.slice(0, cap) : out;
}

export interface DifficultyAccuracyRow {
  difficulty: string | null;
  answers_count: number;
  correct_count: number;
}

/**
 * Accuracy by question difficulty over the same excluded Bernoulli set (all
 * eligible players, not just placed — this is a population diagnostic). Uses the
 * selected_index IS NOT NULL backfill exclusion and the ranked/completed/non-dev
 * filters. Difficulty comes from questions.difficulty.
 */
export async function fetchAccuracyByDifficulty(query: ReadOnlyRunner): Promise<DifficultyAccuracyRow[]> {
  const types = BERNOULLI_TYPES as unknown as string[];
  return query<DifficultyAccuracyRow[]>`
    SELECT q.difficulty AS difficulty,
           count(*)::int AS answers_count,
           count(*) FILTER (WHERE ma.is_correct)::int AS correct_count
    FROM match_answers ma
    JOIN matches m          ON m.id = ma.match_id
    JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q        ON q.id = mq.question_id
    JOIN users u            ON u.id = ma.user_id
    WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL
      AND q.type = ANY(${types})
      AND ma.selected_index IS NOT NULL
    GROUP BY q.difficulty
    ORDER BY q.difficulty`;
}

/** Clean-window S1 answer times for a set of players (for the speed floor). */
export async function fetchS1CleanTimesForPlayers(
  query: ReadOnlyRunner,
  opts: { s1Boundary: string; playerIds: readonly string[]; cleanWindowStart: string },
): Promise<number[]> {
  if (opts.playerIds.length === 0) return [];
  const types = BERNOULLI_TYPES as unknown as string[];
  const rows = await query<{ time_ms: number }[]>`
    SELECT ma.time_ms
    FROM match_answers ma
    JOIN matches m          ON m.id = ma.match_id
    JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q        ON q.id = mq.question_id
    WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND m.ended_at IS NOT NULL AND m.ended_at < ${opts.s1Boundary}::timestamptz
      AND ma.user_id = ANY(${opts.playerIds as string[]})
      AND q.type = ANY(${types})
      AND ma.selected_index IS NOT NULL
      AND ma.answered_at >= ${opts.cleanWindowStart}::timestamptz
      AND ma.time_ms > 0`;
  return rows.map((r) => r.time_ms);
}
