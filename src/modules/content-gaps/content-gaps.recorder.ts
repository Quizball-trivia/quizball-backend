/**
 * Content gaps, write-behind. Games call `contentGaps.record(...)` after their own write has committed; nothing here ever
 * runs on a request's critical path or inside a game's transaction.
 *
 * Counts are best-effort observations: a flush that fails (or whose outcome is unknown) is dropped, never retried, and a
 * request the client retries on another replica can be counted twice. Buffers are lost on a crash; shutdown drains for
 * at most 2 s.
 */
import type { TransactionSql } from 'postgres';
import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { chunkRows, GapBuffer, LIMITS, type GapObservation, type GapRow } from './content-gaps.buffer.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;
const FLUSH_MS = 20_000;
const FLUSH_JITTER_MS = 5_000;
/** New texts a single board may hold open or in checking; past it only existing rows keep counting. */
export const OPEN_PER_BOARD = 2_000;
/** Rows the whole table may hold (planner estimate) before new texts stop being admitted anywhere. */
export const TABLE_CEILING = 300_000;
const SHUTDOWN_DRAIN_MS = 2_000;
const STATS_MS = 60_000;
const SAMPLES_PER_LOCALE = LIMITS.samplesPerLocale;

const buffer = new GapBuffer();
let timer: ReturnType<typeof setTimeout> | null = null;
let statsTimer: ReturnType<typeof setInterval> | null = null;
let flushing: Promise<void> | null = null;
let stopped = false;
let flushedRows = 0;
let failedRows = 0;
let quotaRows = 0;
let aborted = false;

function schedule(): void {
  if (timer || stopped) return;
  timer = setTimeout(() => {
    timer = null;
    void flush().finally(schedule);
  }, FLUSH_MS + Math.floor(Math.random() * FLUSH_JITTER_MS));
  timer.unref();
  if (!statsTimer) {
    statsTimer = setInterval(() => {
      const stats = buffer.takeStats();
      if (stats.recorded || stats.dropped || failedRows || quotaRows) {
        logger.info({ ...stats, flushed: flushedRows, failed: failedRows, overQuota: quotaRows }, 'Content gaps recorder');
      }
      flushedRows = 0;
      failedRows = 0;
      quotaRows = 0;
    }, STATS_MS);
    statsTimer.unref();
  }
}

const toRecord = (r: GapRow) => ({
  game: r.game, mode: r.mode, board_key: r.board_key, context_fp: r.context_fp, verdict: r.verdict, norm: r.norm,
  resolved_id: r.resolved_id, candidate_ids: r.candidate_ids, n: r.n,
});
const boardOf = (r: { game: string; board_key: string }) => JSON.stringify([r.game, r.board_key]);
const keyOf = (r: { game: string; board_key: string; context_fp: string; verdict: string; norm: string }) =>
  JSON.stringify([r.game, r.board_key, r.context_fp, r.verdict, r.norm]);

/**
 * One chunk, one short transaction. New texts are admitted per board under that board's advisory lock, up to what is
 * left of OPEN_PER_BOARD (open and checking rows), so concurrent replicas cannot overshoot it; existing rows always
 * count. The table ceiling is a soft guard from the planner's estimate.
 */
async function writeChunk(rows: GapRow[]): Promise<number> {
  let refused = 0;
  await sql.begin(async (raw) => {
    const tx = exec(raw);
    await tx.unsafe(`SET LOCAL statement_timeout = 3000`);
    await tx.unsafe(`SET LOCAL lock_timeout = 500`);
    const boards = [...new Set(rows.map(boardOf))].sort().map((k) => JSON.parse(k) as [string, string]);
    const boardSet = tx.json(boards.map(([game, board_key]) => ({ game, board_key })) as never);
    await tx`
      SELECT count(pg_advisory_xact_lock(hashtext(b.game), hashtext(b.board_key)))
      FROM (SELECT * FROM jsonb_to_recordset(${boardSet}) AS t(game text, board_key text) ORDER BY game, board_key) b
    `;
    const [size] = await tx<Array<{ rows: string }>>`SELECT GREATEST(reltuples, 0)::bigint AS rows FROM pg_class WHERE oid = 'public.content_gaps'::regclass`;
    const tableFull = Number(size?.rows ?? 0) >= TABLE_CEILING;
    const used = await tx<Array<{ game: string; board_key: string; n: number }>>`
      SELECT b.game, b.board_key,
             (SELECT count(*)::int FROM (
               SELECT 1 FROM content_gaps g WHERE g.game = b.game AND g.board_key = b.board_key AND g.status IN ('open', 'checking') LIMIT ${OPEN_PER_BOARD}
             ) x) AS n
      FROM jsonb_to_recordset(${boardSet}) AS b(game text, board_key text)
    `;
    const left = new Map(used.map((u) => [boardOf(u), tableFull ? 0 : OPEN_PER_BOARD - u.n]));
    const existing = new Set((await tx<Array<{ game: string; board_key: string; context_fp: string; verdict: string; norm: string }>>`
      SELECT g.game, g.board_key, g.context_fp, g.verdict, g.norm
      FROM jsonb_to_recordset(${tx.json(rows.map(toRecord) as never)})
        AS t(game text, board_key text, context_fp text, verdict text, norm text)
      JOIN content_gaps g ON g.game = t.game AND g.board_key = t.board_key AND g.context_fp = t.context_fp AND g.verdict = t.verdict AND g.norm = t.norm
      ORDER BY g.id
      -- Locked so retention cannot delete a key between this check and the upsert (it would come back as a new open row).
      FOR UPDATE OF g
    `).map(keyOf));
    const admitted = rows.filter((r) => {
      if (existing.has(keyOf(r))) return true;
      const room = left.get(boardOf(r)) ?? 0;
      if (room <= 0) { refused += 1; return false; }
      left.set(boardOf(r), room - 1);
      return true;
    });
    if (admitted.length === 0) return;
    await tx`
      INSERT INTO content_gaps AS g (game, mode, board_key, context_fp, verdict, norm, resolved_id, candidate_ids, count)
      SELECT t.game, t.mode, t.board_key, t.context_fp, t.verdict, t.norm, t.resolved_id,
             CASE WHEN t.candidate_ids IS NULL THEN NULL ELSE ARRAY(SELECT jsonb_array_elements_text(t.candidate_ids)) END, t.n
      FROM jsonb_to_recordset(${tx.json(admitted.map(toRecord) as never)})
        AS t(game text, mode text, board_key text, context_fp text, verdict text, norm text, resolved_id text, candidate_ids jsonb, n int)
      ON CONFLICT (game, board_key, context_fp, verdict, norm) DO UPDATE SET
        count = g.count + EXCLUDED.count,
        last_seen = now(),
        updated_at = now(),
        resolved_id = COALESCE(EXCLUDED.resolved_id, g.resolved_id),
        candidate_ids = COALESCE(EXCLUDED.candidate_ids, g.candidate_ids)
    `;
    const samples = admitted.flatMap((r) => Object.entries(r.samples).flatMap(([locale, typings]) => typings.map((typed) => ({
      game: r.game, board_key: r.board_key, context_fp: r.context_fp, verdict: r.verdict, norm: r.norm, locale, typed,
    }))));
    if (samples.length === 0) return;
    await tx`
      INSERT INTO content_gap_samples (gap_id, locale, typed)
      SELECT q.gap_id, q.locale, q.typed
      FROM (
        SELECT g.id AS gap_id, s.locale, s.typed,
               row_number() OVER (PARTITION BY g.id, s.locale ORDER BY s.typed) AS rn,
               (SELECT count(*) FROM content_gap_samples x WHERE x.gap_id = g.id AND x.locale = s.locale) AS have
        FROM jsonb_to_recordset(${tx.json(samples as never)})
          AS s(game text, board_key text, context_fp text, verdict text, norm text, locale text, typed text)
        JOIN content_gaps g ON g.game = s.game AND g.board_key = s.board_key AND g.context_fp = s.context_fp AND g.verdict = s.verdict AND g.norm = s.norm
        WHERE NOT EXISTS (SELECT 1 FROM content_gap_samples x WHERE x.gap_id = g.id AND x.locale = s.locale AND x.typed = s.typed)
      ) q
      -- The gap rows were locked by the upsert above, so a concurrent flush of the same gap waits and then sees these.
      WHERE q.have + q.rn <= ${SAMPLES_PER_LOCALE}
      ON CONFLICT DO NOTHING
    `;
  });
  return refused;
}

async function runFlush(): Promise<void> {
  const rows = buffer.drain();
  for (const chunk of chunkRows(rows)) {
    if (aborted) {
      failedRows += chunk.length;
      continue;
    }
    try {
      quotaRows += await writeChunk(chunk);
      flushedRows += chunk.length;
    } catch (error) {
      failedRows += chunk.length;
      logger.warn({ err: error, rows: chunk.length }, 'Content gaps flush failed; batch dropped');
    }
  }
}

/** Single flight: a flush already running is awaited, not doubled. */
export function flush(): Promise<void> {
  flushing ??= runFlush().finally(() => { flushing = null; });
  return flushing;
}

export const contentGaps = {
  /** Never throws and never waits: a bad or overflowing observation is simply not kept. */
  record(observation: GapObservation): void {
    if (stopped) return;
    try {
      buffer.add(observation);
      schedule();
    } catch (error) {
      logger.warn({ err: error }, 'Content gaps record failed');
    }
  },
  recordAll(observations: readonly GapObservation[]): void {
    for (const o of observations) contentGaps.record(o);
  },
};

/**
 * Shutdown, after the HTTP server has stopped taking requests and before the DB pool closes: stop taking observations,
 * let a running flush finish, drain what is left, and stop issuing chunks once SHUTDOWN_DRAIN_MS has passed (a chunk
 * already sent is bounded by its own 3 s statement timeout).
 */
export async function stopContentGapsRecorder(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  if (statsTimer) clearInterval(statsTimer);
  timer = null;
  statsTimer = null;
  const drain = (async () => {
    await flushing?.catch(() => undefined);
    await flush();
  })();
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref())]);
  aborted = true;
  await drain.catch(() => undefined);
}

/** Tests only. */
export const __test = { buffer, flush, writeChunk, reset: () => { stopped = false; aborted = false; buffer.drain(); buffer.takeStats(); } };
