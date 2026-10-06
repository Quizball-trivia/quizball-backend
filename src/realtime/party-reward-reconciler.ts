import { logger } from '../core/logger.js';
import { sql, withStatementTimeout } from '../db/index.js';
import { PARTY_REWARD_MAX_ATTEMPTS, runPartyCompletionWork } from './party-completion-work.js';

export interface DuePartyRewardJob { matchId: string; userIds: string[] }

const SWEEP_INTERVAL_MS = 5 * 60_000;
/** A completed Party match with no job row gets one if it ended within this many hours (the result screen relies on it). */
export const PARTY_REWARD_BACKFILL_HOURS = 72;
/** Server-side bound on each sweep statement: a blocked one fails this sweep (the next one retries) instead of hanging. */
const SWEEP_STATEMENT_MS = 15_000;
const sweepSql = <T>(run: (q: typeof sql) => Promise<T>): Promise<T> =>
  withStatementTimeout((tx) => run(tx as unknown as typeof sql), SWEEP_STATEMENT_MS);
const BATCH = 25;

/**
 * Completed Party Quiz matches with no job row (the completion's insert failed, the process died first, or the match
 * ended before jobs existed): give them one. Keyed on the job, not on XP: XP can exist without the other steps (a
 * replay awards it on its own), and every step is idempotent and dated by the match's end, so re-running a match that
 * was in fact fully rewarded awards nothing. Returns how many it added.
 */
export async function backfillPartyRewardJobs(): Promise<number> {
  const rows = await sweepSql((q) => q`
    INSERT INTO party_reward_jobs (match_id, user_ids, next_attempt_at)
    SELECT m.id, array_agg(mp.user_id ORDER BY mp.seat), now()
    FROM matches m
    JOIN match_players mp ON mp.match_id = m.id
    WHERE m.game_variant = 'friendly_party_quiz' AND m.status = 'completed' AND NOT COALESCE(m.is_dev, false)
      -- started_at bound: uses matches_started_at_idx (ended_at has no index; without it this scans every match, ~1 s
      -- on prod 2026-10-06 vs ~7 ms with it). A Party match lasts minutes, so 73 h covers anything ended in 72 h.
      AND m.started_at >= now() - make_interval(hours => ${PARTY_REWARD_BACKFILL_HOURS + 1})
      AND m.ended_at BETWEEN now() - make_interval(hours => ${PARTY_REWARD_BACKFILL_HOURS}) AND now() - interval '3 minutes'
      AND NOT EXISTS (SELECT 1 FROM party_reward_jobs j WHERE j.match_id = m.id)
      AND EXISTS (
        SELECT 1 FROM match_players e JOIN users u ON u.id = e.user_id
        WHERE e.match_id = m.id AND NOT u.is_guest AND (NOT u.is_ai OR u.ai_kind = 'persistent')
      )
    GROUP BY m.id
    ON CONFLICT (match_id) DO NOTHING
    RETURNING match_id
  `);
  return rows.length;
}

/**
 * Pending jobs whose retry time has come and that no worker holds, soonest first. A failing job moves its own
 * next_attempt_at back (exponential backoff), so it cannot keep a newer healthy job out of the batch.
 */
export async function findDuePartyRewardJobs(limit = BATCH): Promise<DuePartyRewardJob[]> {
  const rows = await sweepSql((q) => q<Array<{ match_id: string; user_ids: string[] }>>`
    SELECT match_id, user_ids FROM party_reward_jobs
    WHERE status = 'pending' AND next_attempt_at <= now() AND (claimed_until IS NULL OR claimed_until < now())
      AND attempts < ${PARTY_REWARD_MAX_ATTEMPTS}
    ORDER BY next_attempt_at, match_id
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ matchId: row.match_id, userIds: row.user_ids }));
}

/** A worker that died during the last allowed attempt leaves the job pending with no attempts left: close it out. */
async function failExhaustedJobs(): Promise<void> {
  const rows = await sweepSql((q) => q<Array<{ match_id: string; last_error: string | null }>>`
    UPDATE party_reward_jobs
    SET status = 'failed', claimed_until = NULL, updated_at = now(),
        last_error = concat_ws('; ', last_error, 'worker lost during the last attempt')
    WHERE status = 'pending' AND attempts >= ${PARTY_REWARD_MAX_ATTEMPTS} AND (claimed_until IS NULL OR claimed_until < now())
    RETURNING match_id, last_error
  `);
  for (const row of rows) logger.error({ matchId: row.match_id, lastError: row.last_error }, 'Party rewards gave up after the last retry');
}

async function pruneDoneJobs(): Promise<void> {
  await sweepSql((q) => q`
    DELETE FROM party_reward_jobs WHERE match_id IN (
      SELECT match_id FROM party_reward_jobs WHERE status = 'done' AND updated_at < now() - interval '14 days' LIMIT 500
    )
  `);
}

export async function reconcilePartyRewards(
  { findDue = () => findDuePartyRewardJobs(), backfill = backfillPartyRewardJobs }:
  { findDue?: () => Promise<DuePartyRewardJob[]>; backfill?: () => Promise<number> } = {},
): Promise<number> {
  await failExhaustedJobs();
  const added = await backfill();
  const due = await findDue();
  for (const job of due) {
    await runPartyCompletionWork(job.matchId, job.userIds, async () => {}, { enqueue: false });
  }
  await pruneDoneJobs();
  if (added > 0 || due.length > 0) logger.info({ backfilled: added, attempted: due.length }, 'Party reward jobs swept');
  return due.length;
}

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

export function startPartyRewardReconciler(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = reconcilePartyRewards()
      .catch((error) => logger.error({ error }, 'Party reward reconciliation failed'))
      .finally(() => { inFlight = null; });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export async function stopPartyRewardReconciler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await inFlight;
}
