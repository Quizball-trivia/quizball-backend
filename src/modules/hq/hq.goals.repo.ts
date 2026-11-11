import { sql } from '../../db/index.js';
import type { NewEvent } from './hq.repo.js';

// hq.goals + the analytics reads goal progress needs
// (see supabase/migrations/20261103090000_hq_standup_goals.sql).

type Ts = Date | string;

export interface GoalRow {
  id: string;
  horizon: 'north_star' | 'week' | 'day';
  title: string;
  description: string;
  metric: 'new_users' | 'active_players' | 'daily_active_players' | 'matches' | 'd7_retention' | 'avg_rating' | null;
  target: string | number | null; // numeric → string from postgres.js
  manual_progress: number | null;
  period_start: string; // cast to text in every select
  period_end: string;
  status: 'active' | 'achieved' | 'dropped';
  department: string | null;
  position: number;
  created_by_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export type GoalColumn =
  | 'horizon'
  | 'title'
  | 'description'
  | 'metric'
  | 'target'
  | 'manual_progress'
  | 'period_start'
  | 'period_end'
  | 'status'
  | 'department'
  | 'position';

const GOAL_COLUMNS = new Set<string>([
  'horizon', 'title', 'description', 'metric', 'target', 'manual_progress', 'period_start', 'period_end',
  'status', 'department', 'position',
]);

const goalSelect = () => sql`
  SELECT g.id, g.horizon, g.title, g.description, g.metric, g.target, g.manual_progress,
         g.period_start::text AS period_start, g.period_end::text AS period_end,
         g.status, g.department, g.position, g.created_by_id, g.created_at, g.updated_at
  FROM hq.goals g`;

export interface RetentionCohortRow {
  cohort_start: string;
  size: number;
  d1: number | string | null;
  d7: number | string | null;
  d30: number | string | null;
}

/** Postgres unique_violation (one active North Star). */
export const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

export const hqGoalsRepo = {
  /**
   * Active-only lists keep the board order (horizon, then position) and are
   * capped at `limit`. Anything that includes history is paged newest first
   * (period_end, created_at, id) with `before` = the last goal id of the
   * previous page. Returns up to limit + 1 rows so callers can tell if more exist.
   */
  async listGoals(params: { statuses: string[]; horizon?: string; limit: number; before?: string }): Promise<GoalRow[]> {
    const filters = [sql`g.status IN ${sql(params.statuses)}`];
    if (params.horizon) filters.push(sql`g.horizon = ${params.horizon}`);
    const activeOnly = params.statuses.every((s) => s === 'active');
    if (!activeOnly && params.before) {
      filters.push(sql`(g.period_end, g.created_at, g.id) < (
        SELECT c.period_end, c.created_at, c.id FROM hq.goals c WHERE c.id = ${params.before})`);
    }
    const where = sql`WHERE ${filters.flatMap((f, i) => (i === 0 ? [f] : [sql` AND `, f]))}`;
    return activeOnly
      ? sql<GoalRow[]>`
          ${goalSelect()} ${where}
          ORDER BY CASE g.horizon WHEN 'north_star' THEN 0 WHEN 'week' THEN 1 ELSE 2 END,
                   g.period_start DESC, g.position ASC, g.created_at ASC
          LIMIT ${params.limit + 1}`
      : sql<GoalRow[]>`
          ${goalSelect()} ${where}
          ORDER BY g.period_end DESC, g.created_at DESC, g.id DESC
          LIMIT ${params.limit + 1}`;
  },

  async goalExists(id: string): Promise<boolean> {
    const [row] = await sql<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM hq.goals WHERE id = ${id}) AS ok`;
    return row?.ok ?? false;
  },

  async getGoal(id: string): Promise<GoalRow | undefined> {
    const [row] = await sql<GoalRow[]>`${goalSelect()} WHERE g.id = ${id}`;
    return row;
  },

  async insertGoal(params: {
    horizon: string;
    title: string;
    description: string;
    metric: string | null;
    target: number | null;
    manualProgress: number | null;
    periodStart: string;
    periodEnd: string;
    status: string;
    department: string | null;
    position: number | null;
    createdById: string | null;
    event: (goalId: string) => NewEvent;
  }): Promise<string> {
    return sql.begin(async (t) => {
      const tx = t as unknown as typeof sql;
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO hq.goals (horizon, title, description, metric, target, manual_progress, period_start, period_end,
                              status, department, position, created_by_id)
        VALUES (${params.horizon}, ${params.title}, ${params.description}, ${params.metric}, ${params.target},
                ${params.manualProgress}, ${params.periodStart}::date, ${params.periodEnd}::date, ${params.status},
                ${params.department}, COALESCE(${params.position}::float8, extract(epoch FROM now())),
                ${params.createdById})
        RETURNING id
      `;
      const e = params.event(row.id);
      await tx`
        INSERT INTO hq.events (type, level, member_id, message, data)
        VALUES (${e.type}, ${e.level ?? 'info'}, ${e.memberId ?? null}, ${e.message}, ${tx.json((e.data ?? {}) as never)})
      `;
      return row.id;
    }) as Promise<string>;
  },

  async updateGoal(id: string, patch: Partial<Record<GoalColumn, unknown>>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([k, v]) => GOAL_COLUMNS.has(k) && v !== undefined);
    if (entries.length === 0) return true;
    const sets = entries.map(([column, value], i) => {
      const v = column === 'period_start' || column === 'period_end' ? sql`${value as string}::date` : sql`${value as never}`;
      return i === 0 ? sql`${sql(column)} = ${v}` : sql`, ${sql(column)} = ${v}`;
    });
    const rows = await sql`UPDATE hq.goals SET ${sets}, updated_at = now() WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  async deleteGoal(id: string): Promise<boolean> {
    const rows = await sql`DELETE FROM hq.goals WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  // ── analytics reads for progress ──
  async newUsersBetween(from: string, to: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM public.users
       WHERE NOT is_ai AND NOT is_seed AND NOT is_guest AND NOT is_deleted
         AND created_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi')
         AND created_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
    `;
    return row?.n ?? 0;
  },

  /**
   * Distinct identities (registered + guest) active on Tbilisi days [from, to],
   * from the rollup — null when the window starts before what the rollup
   * covers (the count would be partial).
   */
  async activeIdentitiesBetween(from: string, to: string): Promise<number | null> {
    const [row] = await sql<{ n: number | null }[]>`SELECT hq.active_identities_between(${from}::date, ${to}::date) AS n`;
    return row?.n ?? null;
  },

  async retentionCohorts(weeks: number): Promise<RetentionCohortRow[]> {
    const [row] = await sql<{ r: RetentionCohortRow[] }[]>`SELECT hq.retention_cohorts(${weeks}) AS r`;
    return row?.r ?? [];
  },

  async analyticsSnapshot(days: number): Promise<AnalyticsSnapshotRow> {
    const [row] = await sql<{ a: AnalyticsSnapshotRow }[]>`SELECT hq.analytics_snapshot(${days}) AS a`;
    return row.a;
  },
};

export interface AnalyticsSnapshotRow {
  generated_at: string;
  timezone: string;
  days: number;
  total_registered_users: number;
  series: { date: string; new_users: number; active_players: number; active_all?: number; matches: number }[];
  /** Registered players only. */
  actives: { dau: number; wau: number; mau: number };
  /** Registered + guests (admin-stats identities), from 20261103180000. */
  actives_all?: { dau: number; wau: number; mau: number };
  modes: { mode: string; matches: number }[];
  modes_by_day: { date: string; mode: string; matches: number }[];
  countries: { country: string; players: number; registered: number }[];
}

export const hqGoalsAnalyticsRepo = {
  /** Average rating and low (≤2) ratings over Tbilisi days [from, to], by updated_at. */
  async ratingSummary(from: string, to: string): Promise<{ avg: number | null; low: number }> {
    const [row] = await sql<{ avg: string | number | null; low: number }[]>`
      SELECT round(avg(rating), 2) AS avg, count(*) FILTER (WHERE rating <= 2)::int AS low
        FROM public.game_feedback
       WHERE updated_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi')
         AND updated_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
    `;
    return { avg: row?.avg === null || row?.avg === undefined ? null : Number(row.avg), low: row?.low ?? 0 };
  },

  /** Average feedback rating (by updated_at, like hq.recent_feedback) over Tbilisi days [from, to]. */
  async avgRatingBetween(from: string, to: string): Promise<number | null> {
    const [row] = await sql<{ avg: string | number | null }[]>`
      SELECT round(avg(rating), 2) AS avg FROM public.game_feedback
       WHERE updated_at >= (${from}::date::timestamp AT TIME ZONE 'Asia/Tbilisi')
         AND updated_at < ((${to}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
    `;
    return row?.avg === null || row?.avg === undefined ? null : Number(row.avg);
  },
};
