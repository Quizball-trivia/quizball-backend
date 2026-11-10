/**
 * Content gaps retention: open gaps nobody has typed for 60 days and closed ones after 180 days go, a batch at a time,
 * by one replica at a time (transaction advisory lock).
 */
import type { TransactionSql } from 'postgres';
import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;
const EVERY_MS = 60 * 60_000;
const BATCH = 2_000;
const LOCK_KEY = 'content-gaps-sweeper';

let timer: ReturnType<typeof setInterval> | null = null;

export async function sweepContentGaps(): Promise<number> {
  return sql.begin(async (raw) => {
    const tx = exec(raw);
    await tx.unsafe(`SET LOCAL statement_timeout = 5000`);
    await tx.unsafe(`SET LOCAL lock_timeout = 1000`);
    const [lock] = await tx<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS ok`;
    if (!lock?.ok) return 0;
    // Rows a flush holds are skipped (no lock cycle with the recorder); the predicate is re-checked on the locked rows,
    // so a gap typed again while we waited is kept.
    const gone = await tx`
      DELETE FROM content_gaps g
      WHERE g.id IN (
        SELECT id FROM content_gaps
        WHERE (status = 'open' AND last_seen < now() - interval '60 days')
           OR (status IN ('fixed', 'junk', 'correct', 'wontfix') AND updated_at < now() - interval '180 days')
        ORDER BY id
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      )
      AND ((g.status = 'open' AND g.last_seen < now() - interval '60 days')
        OR (g.status IN ('fixed', 'junk', 'correct', 'wontfix') AND g.updated_at < now() - interval '180 days'))
    `;
    return gone.count;
  });
}

let running: Promise<unknown> | null = null;

export function startContentGapsSweeper(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = sweepContentGaps()
      .then((n) => { if (n > 0) logger.info({ deleted: n }, 'Content gaps swept'); })
      .catch((error: unknown) => logger.warn({ err: error }, 'Content gaps sweep failed'))
      .finally(() => { running = null; });
  }, EVERY_MS);
  timer.unref();
}

/** Stops the schedule and waits for a sweep already running (bounded by its own 5 s statement / 1 s lock timeouts). */
export async function stopContentGapsSweeper(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (running) await running;
}
