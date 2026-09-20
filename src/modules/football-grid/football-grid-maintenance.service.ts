import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../../realtime/locks.js';

const INTERVAL_MS = 24 * 60 * 60 * 1_000;
const STARTUP_MIN_DELAY_MS = 60_000;
const STARTUP_JITTER_MS = 60_000;
const LOCK_KEY = 'lock:football_grid:retention';
const LOCK_TTL_MS = 60_000;
const BATCH_SIZE = 1_000;
let startupTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

async function deleteBatch(statement: string): Promise<number> {
  return sql.begin(async (tx) => {
    const deleted = await tx.unsafe<Array<{ deleted: number }>>(statement, [BATCH_SIZE]);
    return deleted.length;
  });
}

async function drain(statement: string): Promise<void> {
  while (await deleteBatch(statement) === BATCH_SIZE) {
    // Every batch commits independently so row locks are released promptly.
  }
}

async function run(): Promise<void> {
  const lock = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!lock.acquired || !lock.token) return;
  const heartbeat = startLockHeartbeat(LOCK_KEY, lock.token, LOCK_TTL_MS);
  try {
    // Reports retain their audit trail for one year. Once they expire, older
    // free-text attempts can be pruned without violating the RESTRICT FK.
    await drain(
      `WITH doomed AS (
         SELECT id FROM football_grid_missing_answer_reports
          WHERE COALESCE(reviewed_at, created_at) < now() - interval '365 days'
          ORDER BY COALESCE(reviewed_at, created_at), id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM football_grid_missing_answer_reports r
        USING doomed
        WHERE r.id = doomed.id
       RETURNING 1 AS deleted`,
    );
    await drain(
      `WITH doomed AS (
         SELECT a.id FROM football_grid_attempts a
          WHERE a.resolved_at < now() - interval '90 days'
            AND NOT EXISTS (
              SELECT 1 FROM football_grid_missing_answer_reports r
               WHERE r.attempt_id = a.id
            )
          ORDER BY a.resolved_at, a.id
          LIMIT $1
          FOR UPDATE OF a SKIP LOCKED
       )
       DELETE FROM football_grid_attempts a
        USING doomed
        WHERE a.id = doomed.id
       RETURNING 1 AS deleted`,
    );
    await drain(
      `WITH doomed AS (
         SELECT i.id FROM football_grid_command_inbox i
          WHERE COALESCE(i.completed_at, i.admitted_at) < now() - interval '90 days'
            AND NOT EXISTS (
              SELECT 1 FROM football_grid_attempts a WHERE a.inbox_id = i.id
            )
          ORDER BY COALESCE(i.completed_at, i.admitted_at), i.id
          LIMIT $1
          FOR UPDATE OF i SKIP LOCKED
       )
       DELETE FROM football_grid_command_inbox i
        USING doomed
        WHERE i.id = doomed.id
       RETURNING 1 AS deleted`,
    );
    await drain(
      `WITH doomed AS (
         SELECT match_id, user_id
           FROM football_grid_reward_risk_observations
          WHERE observed_at < now() - interval '90 days'
          ORDER BY observed_at, match_id, user_id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       DELETE FROM football_grid_reward_risk_observations o
        USING doomed
        WHERE o.match_id = doomed.match_id AND o.user_id = doomed.user_id
       RETURNING 1 AS deleted`,
    );
  } finally {
    heartbeat.stop();
    await releaseLock(LOCK_KEY, lock.token).catch(() => false);
  }
}

function tick(): void {
  void run().catch((error) => {
    logger.warn({ error }, 'Football Grid retention maintenance failed');
  });
}

export const footballGridMaintenanceService = {
  start(): void {
    if (startupTimer || intervalTimer) return;
    const startupDelayMs = STARTUP_MIN_DELAY_MS + Math.floor(Math.random() * STARTUP_JITTER_MS);
    startupTimer = setTimeout(() => {
      startupTimer = null;
      tick();
    }, startupDelayMs);
    startupTimer.unref?.();
    intervalTimer = setInterval(tick, INTERVAL_MS);
    intervalTimer.unref?.();
  },
  run,
};
