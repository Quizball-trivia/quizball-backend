import type { Sql } from 'postgres';
import { ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql as defaultSql } from '../../db/index.js';
import { releaseDay } from '../buscaminas/buscaminas.days.js';
import { DAILY_GAMES, GAMES, type BatchPlan, type DailyGame } from './day-batches.games.js';

export type DayBatchStatus = 'pending' | 'seeded' | 'rejected' | 'failed';

export interface DayBatchSummary {
  id: string;
  jobId: string;
  game: DailyGame;
  firstDay: string;
  lastDay: string;
  dayCount: number;
  status: DayBatchStatus;
  validation: Record<string, unknown>;
  plan: BatchPlan | null;
  error: string | null;
  rejectReason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface DayBatchDetail extends DayBatchSummary {
  days: unknown[];
  /** What appending it now would do, or why it would be refused (pending batches only). */
  dryRun: { plan: BatchPlan } | { error: string } | null;
}

export interface GameBuffer {
  game: DailyGame;
  lastDay: string | null;
  /** Released days from today on (today included). */
  daysLeft: number;
  pendingBatchId: string | null;
  activeJobId: string | null;
  /** Validated batches wait for a person instead of being appended automatically. */
  holdForReview: boolean;
}

interface BatchRow {
  id: string;
  job_id: string;
  game: DailyGame;
  first_day: string;
  last_day: string;
  day_count: number;
  status: DayBatchStatus;
  validation: Record<string, unknown>;
  plan: BatchPlan | null;
  error: string | null;
  reject_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

const SUMMARY_COLUMNS = `id, job_id, game, first_day::text, last_day::text, jsonb_array_length(days) AS day_count, status, validation, plan,
  error, reject_reason, decided_by, decided_at::text, created_at::text`;

const toSummary = (r: BatchRow): DayBatchSummary => ({
  id: r.id, jobId: r.job_id, game: r.game, firstDay: r.first_day, lastDay: r.last_day, dayCount: r.day_count, status: r.status,
  validation: r.validation ?? {}, plan: r.plan, error: r.error, rejectReason: r.reject_reason, decidedBy: r.decided_by,
  decidedAt: r.decided_at, createdAt: r.created_at,
});

const ACTIVE_JOB = ['queued', 'running', 'dispatched'];
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Transaction budgets: the production role kills a transaction idle for 15 s. */
async function budgets(tx: Sql): Promise<void> {
  await tx`SET LOCAL lock_timeout = '5s'`;
  await tx`SET LOCAL statement_timeout = '60s'`;
  await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
}

export function createDayBatchesService(deps: { sql: Sql; now: () => Date }) {
  const { sql } = deps;

  async function load(tx: Sql, id: string, lock: boolean): Promise<BatchRow & { days: unknown[] }> {
    const rows = lock
      ? await tx<Array<BatchRow & { days: unknown[] }>>`SELECT ${tx.unsafe(SUMMARY_COLUMNS)}, days FROM agents.day_batches WHERE id = ${id} FOR UPDATE`
      : await tx<Array<BatchRow & { days: unknown[] }>>`SELECT ${tx.unsafe(SUMMARY_COLUMNS)}, days FROM agents.day_batches WHERE id = ${id}`;
    if (!rows[0]) throw new NotFoundError('Day batch not found');
    return rows[0];
  }

  return {
    async list(filter: { game?: DailyGame; status?: DayBatchStatus; limit: number }): Promise<DayBatchSummary[]> {
      const rows = await sql<BatchRow[]>`
        SELECT ${sql.unsafe(SUMMARY_COLUMNS)} FROM agents.day_batches
        WHERE (${filter.game ?? null}::text IS NULL OR game = ${filter.game ?? null})
          AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
        ORDER BY created_at DESC LIMIT ${filter.limit}
      `;
      return rows.map(toSummary);
    },

    async get(id: string): Promise<DayBatchDetail> {
      const row = await load(sql, id, false);
      let dryRun: DayBatchDetail['dryRun'] = null;
      if (row.status === 'pending') {
        try {
          // a dry run writes nothing; it runs the same checks the approval will, against the table as it is now
          dryRun = { plan: await sql.begin(async (transaction) => {
            const tx = transaction as unknown as Sql;
            await budgets(tx);
            return GAMES[row.game].seed(tx, row.days, true);
          }) as BatchPlan };
        } catch (error) {
          dryRun = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      return { ...toSummary(row), days: row.days, dryRun };
    },

    async buffers(): Promise<GameBuffer[]> {
      const today = releaseDay(deps.now());
      const pending = await sql<Array<{ game: DailyGame; id: string }>>`SELECT game, id FROM agents.day_batches WHERE status = 'pending'`;
      const active = await sql<Array<{ game: DailyGame; id: string }>>`
        SELECT params->>'game' AS game, id FROM agents.jobs WHERE type = 'daily_days' AND status = ANY(${ACTIVE_JOB})
      `;
      const held = new Set((await sql<Array<{ game: DailyGame }>>`SELECT game FROM agents.daily_game_settings WHERE hold_for_review`).map((r) => r.game));
      return Promise.all(DAILY_GAMES.map(async (game) => {
        const stored = await sql<Array<{ day: string }>>`SELECT day::text AS day FROM ${sql(GAMES[game].table)}`;
        const lastDay = GAMES[game].lastDay(stored.map((r) => r.day));
        return {
          game,
          lastDay,
          daysLeft: lastDay === null || lastDay < today ? 0 : daysBetween(today, lastDay) + 1,
          pendingBatchId: pending.find((p) => p.game === game)?.id ?? null,
          activeJobId: active.find((a) => a.game === game)?.id ?? null,
          holdForReview: held.has(game),
        };
      }));
    },

    /**
     * Appends the batch's days and marks it seeded in ONE transaction: the batch row is locked first, so a double click
     * or a retry after a lost response waits, then finds it seeded and gets the stored result back.
     */
    async approve(id: string, userId: string | null): Promise<DayBatchSummary> {
      return sql.begin(async (transaction) => {
        const tx = transaction as unknown as Sql;
        await budgets(tx);
        const row = await load(tx, id, true);
        if (row.status === 'seeded') return toSummary(row);
        if (row.status !== 'pending') throw new ConflictError(`Day batch is ${row.status}`);
        if (row.validation?.ok !== true) throw new ConflictError('Day batch did not pass validation; reject it instead');
        const game = GAMES[row.game];
        // the game's content lock first (the seed takes it again; it is re-entrant), so the calendar cannot change
        // between this check and the append
        await tx`SELECT pg_advisory_xact_lock(hashtext(${game.contentLock}))`;
        const validatedOn = (row.validation as { calendar?: { fingerprint?: unknown } }).calendar?.fingerprint;
        if (typeof validatedOn !== 'string') throw new ConflictError('Day batch has no record of the calendar it was validated on; reject it and build again');
        if (validatedOn !== (await game.fingerprint(tx))) {
          throw new ConflictError('The stored days changed after this batch was validated; reject it and build again');
        }
        const plan = await game.seed(tx, row.days, false);
        const [updated] = await tx<BatchRow[]>`
          UPDATE agents.day_batches
          SET status = 'seeded', plan = ${tx.json(plan as never)}, decided_by = ${userId}, decided_at = now(), updated_at = now()
          WHERE id = ${id}
          RETURNING ${tx.unsafe(SUMMARY_COLUMNS)}
        `;
        return toSummary(updated);
      }) as Promise<DayBatchSummary>;
    },

    async reject(id: string, userId: string | null, reason: string): Promise<DayBatchSummary> {
      return sql.begin(async (transaction) => {
        const tx = transaction as unknown as Sql;
        await budgets(tx);
        const row = await load(tx, id, true);
        if (row.status === 'rejected') return toSummary(row);
        if (row.status !== 'pending') throw new ConflictError(`Day batch is ${row.status}`);
        const [updated] = await tx<BatchRow[]>`
          UPDATE agents.day_batches
          SET status = 'rejected', reject_reason = ${reason}, decided_by = ${userId}, decided_at = now(), updated_at = now()
          WHERE id = ${id}
          RETURNING ${tx.unsafe(SUMMARY_COLUMNS)}
        `;
        return toSummary(updated);
      }) as Promise<DayBatchSummary>;
    },

    async setHold(game: DailyGame, hold: boolean, userId: string | null): Promise<void> {
      await sql`
        INSERT INTO agents.daily_game_settings (game, hold_for_review, updated_by, updated_at) VALUES (${game}, ${hold}, ${userId}, now())
        ON CONFLICT (game) DO UPDATE SET hold_for_review = EXCLUDED.hold_for_review, updated_by = EXCLUDED.updated_by, updated_at = now()
      `;
    },

    /**
     * Appends every validated pending batch of a game not on hold, exactly as an approval would (same lock, same checks).
     * A batch the append refuses (the calendar changed since validation, its dates were taken) is marked failed with the
     * reason, so the next build starts fresh; a transient error leaves it pending for the next pass.
     */
    async autoApprove(): Promise<{ seeded: string[]; failed: string[] }> {
      const due = await sql<Array<{ id: string }>>`
        SELECT b.id FROM agents.day_batches b
        LEFT JOIN agents.daily_game_settings s ON s.game = b.game
        WHERE b.status = 'pending' AND (b.validation->>'ok') = 'true' AND NOT coalesce(s.hold_for_review, false)
        ORDER BY b.created_at
      `;
      const seeded: string[] = [];
      const failed: string[] = [];
      for (const { id } of due) {
        try {
          await this.approve(id, null);
          seeded.push(id);
        } catch (error) {
          // a database error (it carries a SQLSTATE: lock timeout, deadlock, connection) is retried on the next pass;
          // anything else is the seed refusing the content, which no retry would change
          const sqlState = !(error instanceof ConflictError) && typeof (error as { code?: unknown })?.code === 'string';
          if (sqlState) {
            logger.warn({ err: error, batchId: id }, 'Day batch auto-approval hit a database error; retrying next pass');
            continue;
          }
          await sql`
            UPDATE agents.day_batches SET status = 'failed', error = ${`not added automatically: ${(error instanceof Error ? error.message : String(error))}`.slice(0, 500)}, updated_at = now()
            WHERE id = ${id} AND status = 'pending'
          `;
          failed.push(id);
        }
      }
      return { seeded, failed };
    },

    /** Queues a build of the next `days` days; refused while the game has a pending batch or a build in progress. */
    async spawn(game: DailyGame, days: number, userId: string | null): Promise<{ jobId: string }> {
      return sql.begin(async (transaction) => {
        const tx = transaction as unknown as Sql;
        await budgets(tx);
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`day-batches:${game}`}))`;
        const [pending] = await tx<Array<{ id: string }>>`SELECT id FROM agents.day_batches WHERE game = ${game} AND status = 'pending'`;
        if (pending) throw new ConflictError('A batch for this game is waiting for review');
        const [active] = await tx<Array<{ id: string }>>`
          SELECT id FROM agents.jobs WHERE type = 'daily_days' AND params->>'game' = ${game} AND status = ANY(${ACTIVE_JOB})
        `;
        if (active) throw new ConflictError('A build for this game is already running');
        const [job] = await tx<Array<{ id: string }>>`
          INSERT INTO agents.jobs (type, status, params, requested_by)
          VALUES ('daily_days', 'queued', ${tx.json({ type: 'daily_days', game, days } as never)}, ${userId})
          RETURNING id
        `;
        return { jobId: job.id };
      }) as Promise<{ jobId: string }>;
    },
  };
}

export type DayBatchesService = ReturnType<typeof createDayBatchesService>;
export const dayBatchesService = createDayBatchesService({ sql: defaultSql as unknown as Sql, now: () => new Date() });

// Appends validated batches of games not on hold, every minute on every replica (the approval locks the batch row and
// is idempotent, so replicas never double-append).
let autoApproveTimer: NodeJS.Timeout | null = null;
let autoApproveRunning: Promise<void> | null = null;

export function startDayBatchAutoApprover(intervalMs = 60_000): void {
  if (autoApproveTimer) return;
  const pass = () => {
    if (autoApproveRunning) return;
    autoApproveRunning = dayBatchesService.autoApprove()
      .then(({ seeded, failed }) => {
        if (seeded.length || failed.length) logger.info({ seeded, failed }, 'Day batches handled automatically');
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'Day batch auto-approval pass failed'))
      .finally(() => {
        autoApproveRunning = null;
      });
  };
  autoApproveTimer = setInterval(pass, intervalMs);
  autoApproveTimer.unref?.();
  pass();
}

export async function stopDayBatchAutoApprover(): Promise<void> {
  if (autoApproveTimer) clearInterval(autoApproveTimer);
  autoApproveTimer = null;
  await autoApproveRunning;
}
