import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { sql, withStatementTimeout } from '../db/index.js';
import { achievementsService } from '../modules/achievements/index.js';
import { progressionService } from '../modules/progression/progression.service.js';
import { objectivesService } from '../modules/objectives/index.js';
import { SocketDbTaskLimiter, SocketDbTaskOverloadedError } from './socket-db-task-limiter.js';

// Completed games already have durable scores. Keep their reward hydration off
// the foreground budget: six parallel achievement lookups themselves fan out
// into more queries, before XP/objectives or another match even start.
// Two workers; queued work waits up to 30 minutes. Whatever does not finish (queue full, a failed step, a restart) stays
// `pending` in party_reward_jobs and party-reward-reconciler.ts retries it.
export const partyCompletionDbTaskLimiter = new SocketDbTaskLimiter(2, 1_024, 30 * 60_000);

export const PARTY_REWARD_MAX_ATTEMPTS = 8;
const LEASE = '10 minutes';
/** Server-side bound on each job statement (SET LOCAL in its own transaction): a stuck lock must not hold a DB slot. */
const JOB_STATEMENT_MS = 5_000;
const jobSql = <T>(run: (q: typeof sql) => Promise<T>): Promise<T> =>
  withStatementTimeout((tx) => run(tx as unknown as typeof sql), JOB_STATEMENT_MS);
/** First retry after 5 min, doubling to a 4 h cap: 8 attempts span about 13 h. */
export const partyRewardRetryDelayMinutes = (attempts: number): number => Math.min(5 * 2 ** Math.max(0, attempts - 1), 240);

/** The live completion runs at once; the reconciler only takes a job left pending past this grace. */
export async function enqueuePartyRewardJob(matchId: string, userIds: readonly string[]): Promise<void> {
  await jobSql((q) => q`
    INSERT INTO party_reward_jobs (match_id, user_ids, next_attempt_at)
    VALUES (${matchId}, ${[...new Set(userIds)]}::uuid[], now() + interval '2 minutes')
    ON CONFLICT (match_id) DO NOTHING
  `);
}

type Claim = { attempts: number; token: string; occurredAt: Date };

class LeaseLostError extends Error {}

/**
 * One worker per match at a time, on any replica. The retry time and attempt cap are checked here, atomically, not only
 * when the due list was read: a worker holding a stale list must not run a job that just backed off. Only the live
 * completion's first attempt may skip the initial grace. A crashed worker's lease simply runs out.
 */
async function claim(matchId: string): Promise<Claim | null> {
  const [row] = await jobSql((q) => q<Array<{ attempts: number; token: string; occurred_at: Date }>>`
    UPDATE party_reward_jobs j
    SET claimed_until = now() + ${LEASE}::interval, claim_token = gen_random_uuid(), attempts = j.attempts + 1, updated_at = now()
    FROM matches m
    WHERE j.match_id = ${matchId} AND m.id = j.match_id AND j.status = 'pending'
      AND (j.claimed_until IS NULL OR j.claimed_until < now())
      AND j.attempts < ${PARTY_REWARD_MAX_ATTEMPTS}
      AND (j.attempts = 0 OR j.next_attempt_at <= now())
    RETURNING j.attempts, j.claim_token AS token, COALESCE(m.ended_at, j.created_at) AS occurred_at
  `);
  return row ? { attempts: row.attempts, token: row.token, occurredAt: new Date(row.occurred_at) } : null;
}

/** Extends the lease between steps; a worker that lost it (expired and re-claimed) stops instead of racing on. */
async function renew(matchId: string, token: string): Promise<void> {
  const rows = await jobSql((q) => q`
    UPDATE party_reward_jobs SET claimed_until = now() + ${LEASE}::interval
    WHERE match_id = ${matchId} AND claim_token = ${token} AND status = 'pending'
    RETURNING 1
  `);
  if (rows.length === 0) throw new LeaseLostError('lease lost');
}

/** Fenced by the claim token: a worker whose lease ran out cannot clear its replacement's lease or overwrite its status. */
async function finish(matchId: string, claimed: Claim, failures: string[]): Promise<void> {
  const { attempts, token } = claimed;
  if (failures.length === 0) {
    const rows = await jobSql((q) => q`
      UPDATE party_reward_jobs SET status = 'done', claimed_until = NULL, last_error = NULL, updated_at = now()
      WHERE match_id = ${matchId} AND claim_token = ${token} AND status = 'pending'
      RETURNING 1
    `);
    if (rows.length === 0) logger.warn({ matchId, attempts }, 'Party reward job finished after losing its lease; left to the current owner');
    return;
  }
  const exhausted = attempts >= PARTY_REWARD_MAX_ATTEMPTS;
  const lastError = failures.join('; ').slice(0, 2_000);
  const rows = await jobSql((q) => q`
    UPDATE party_reward_jobs
    SET status = ${exhausted ? 'failed' : 'pending'}, claimed_until = NULL, last_error = ${lastError}, updated_at = now(),
        next_attempt_at = now() + make_interval(mins => ${partyRewardRetryDelayMinutes(attempts)})
    WHERE match_id = ${matchId} AND claim_token = ${token} AND status = 'pending'
    RETURNING 1
  `);
  const log = { matchId, attempts, failures };
  if (rows.length === 0) logger.warn(log, 'Party reward job failed after losing its lease; left to the current owner');
  else if (exhausted) logger.error(log, 'Party rewards gave up after the last retry');
  else logger.warn(log, 'Party rewards incomplete; will retry');
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Every step is idempotent per match (XP and objectives by match key, achievements by user) and dated by the match's
 * completion, not the retry, so redoing all of them never credits a match twice.
 */
async function rewardMatch(matchId: string, userIds: readonly string[], claimed: Claim): Promise<string[]> {
  const { occurredAt, token } = claimed;
  const failures: string[] = [];
  for (const userId of new Set(userIds)) {
    await achievementsService.evaluateForMatch(matchId, [userId], 'friendly_party_quiz', { occurredAt }).catch((error) => {
      failures.push(`achievements ${userId}: ${message(error)}`);
    });
  }
  if (config.OBJECTIVES_ENABLED) {
    await renew(matchId, token);
    await objectivesService.evaluateForMatch(matchId, occurredAt).catch((error) => { failures.push(`objectives: ${message(error)}`); });
  }
  await renew(matchId, token);
  await progressionService.awardCompletedMatchXp(matchId, occurredAt).catch((error) => { failures.push(`xp: ${message(error)}`); });
  return failures;
}

export async function runPartyCompletionWork(
  matchId: string,
  userIds: readonly string[],
  refresh: () => Promise<void>,
  { enqueue = true }: { enqueue?: boolean } = {},
): Promise<void> {
  if (enqueue) {
    // Without the row the reconciler's backfill still finds this match (completed, no XP, no job), so a failed insert
    // only delays it.
    await enqueuePartyRewardJob(matchId, userIds).catch((error) => {
      logger.warn({ error: message(error), matchId }, 'Party reward job insert failed; the reconciler backfills it');
    });
  }
  await partyCompletionDbTaskLimiter.run(async () => {
    try {
      const claimed = await claim(matchId);
      if (claimed) await finish(matchId, claimed, await rewardMatch(matchId, userIds, claimed));
    } catch (error) {
      if (error instanceof LeaseLostError) {
        logger.warn({ matchId }, 'Party reward worker lost its lease mid-run and stopped; the current owner continues');
      } else {
        // The job stays pending (its lease expires); the result refresh below still runs.
        logger.warn({ error: message(error), matchId }, 'Party reward job bookkeeping failed; the reconciler retries it');
      }
    }
    await refresh();
  }).catch((error) => {
    if (error instanceof SocketDbTaskOverloadedError) {
      logger.error({ matchId, userIds: [...userIds], reason: error.reason }, 'Party rewards deferred: completion queue overloaded (the reconciler runs them)');
      return;
    }
    throw error;
  });
}
