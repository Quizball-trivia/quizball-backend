import { sql } from '../../db/index.js';

// Read side of the new HQ harness (`harness` schema, migration
// 20261125120000_harness_core.sql) for the CMS Content tab. The harness worker
// (quizball-question-agents, pm2 app harness-worker) does all the writing
// except the owner controls below.

export interface HarnessSettingsRow {
  paused: boolean;
  paused_reason: string | null;
  max_concurrent_runs: number;
  daily_run_limit: number;
  updated_at: Date | string;
}

export const harnessRepo = {
  async settings(): Promise<HarnessSettingsRow> {
    const [row] = await sql<HarnessSettingsRow[]>`SELECT paused, paused_reason, max_concurrent_runs, daily_run_limit, updated_at FROM harness.settings WHERE id`;
    return row;
  },

  async updateSettings(patch: { paused?: boolean; paused_reason?: string | null; max_concurrent_runs?: number; daily_run_limit?: number }): Promise<HarnessSettingsRow> {
    const [row] = await sql<HarnessSettingsRow[]>`
      UPDATE harness.settings SET
        paused = coalesce(${patch.paused ?? null}::boolean, paused),
        paused_reason = CASE WHEN ${patch.paused_reason !== undefined} THEN ${patch.paused_reason ?? null} ELSE paused_reason END,
        max_concurrent_runs = coalesce(${patch.max_concurrent_runs ?? null}::integer, max_concurrent_runs),
        daily_run_limit = coalesce(${patch.daily_run_limit ?? null}::integer, daily_run_limit),
        updated_at = now()
      WHERE id
      RETURNING paused, paused_reason, max_concurrent_runs, daily_run_limit, updated_at`;
    return row;
  },

  async accounts() {
    // secret_ref is only the name of an environment variable on the worker, never the secret.
    return sql<
      Array<{ id: string; provider: string; label: string; secret_ref: string; status: string; reserved_for_people: boolean; soft_pct: number; state: string; blocked_until: Date | null; windows: unknown; last_error: string | null }>
    >`SELECT id, provider, label, secret_ref, status, reserved_for_people, soft_pct, state, blocked_until, windows, last_error FROM harness.accounts ORDER BY reserved_for_people, id`;
  },

  async agents() {
    return sql<
      Array<{ slug: string; name: string; team: string; description: string; provider: string; model: string; effort: string | null; primary_account: string; fallback_accounts: string[]; status: string; runs_today: string; cost_cents_today: string | null; last_run_at: Date | null }>
    >`
      SELECT a.slug, a.name, a.team, a.description, a.provider, a.model, a.effort, a.primary_account, a.fallback_accounts, a.status,
             count(r.id) FILTER (WHERE r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi') AS runs_today,
             sum(r.cost_cents) FILTER (WHERE r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi') AS cost_cents_today,
             (SELECT max(lr.started_at) FROM harness.runs lr WHERE lr.agent_slug = a.slug) AS last_run_at
        FROM harness.agents a
        LEFT JOIN harness.runs r ON r.agent_slug = a.slug AND r.started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'
       GROUP BY a.slug
       ORDER BY a.team, a.slug`;
  },

  async classicHealth(cap: number) {
    return sql<Array<{ category_id: string; slug: string; views_30d: string; pool: string; in_pipeline: string; needed: string; shortage: string }>>`
      SELECT * FROM harness.classic_health(${cap})`;
  },

  async classicCap(): Promise<number> {
    const [row] = await sql<Array<{ cap: number | null }>>`
      SELECT (body -> 'ranked' ->> 'view_cap_30d')::integer AS cap FROM harness.contracts WHERE mode = 'classic' AND active`;
    return row?.cap ?? 100;
  },

  async stageCounts() {
    return sql<Array<{ mode: string; stage: string; n: string }>>`SELECT mode, stage, count(*) AS n FROM harness.items GROUP BY 1, 2 ORDER BY 1, 2`;
  },

  async jobCounts() {
    return sql<Array<{ kind: string; status: string; n: string }>>`
      SELECT kind, status, count(*) AS n FROM harness.jobs
       WHERE status IN ('queued', 'running') OR finished_at > now() - interval '24 hours'
       GROUP BY 1, 2 ORDER BY 1, 2`;
  },

  async recentRuns(limit = 25) {
    return sql<Array<{ id: string; agent_slug: string; account_id: string | null; model: string; status: string; tokens_in: number; tokens_out: number; cost_cents: number; error: string | null; started_at: Date; ended_at: Date | null }>>`
      SELECT id, agent_slug, account_id, model, status, tokens_in, tokens_out, cost_cents, error, started_at, ended_at
        FROM harness.runs ORDER BY started_at DESC LIMIT ${limit}`;
  },

  async recentEvents(limit = 40) {
    return sql<Array<{ id: string; type: string; level: string; message: string; item_id: string | null; created_at: Date }>>`
      SELECT id, type, level, message, item_id, created_at FROM harness.events ORDER BY id DESC LIMIT ${limit}`;
  },

  async policies() {
    return sql<Array<{ key: string; value: unknown; note: string; updated_at: Date }>>`SELECT key, value, note, updated_at FROM harness.policies ORDER BY key`;
  },

  async setPolicy(key: string, value: unknown): Promise<boolean> {
    const rows = await sql`UPDATE harness.policies SET value = ${sql.json(value as never)}, updated_at = now() WHERE key = ${key} RETURNING key`;
    return rows.length === 1;
  },

  async todayTotals() {
    const [row] = await sql<Array<{ runs: string; cost_cents: string | null; failed: string }>>`
      SELECT count(*) AS runs, sum(cost_cents) AS cost_cents, count(*) FILTER (WHERE status IN ('failed', 'timeout')) AS failed
        FROM harness.runs
       WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi'`;
    return row;
  },
};
