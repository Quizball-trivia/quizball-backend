import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';

// Reads/writes the `agents` schema (orchestration state) populated by the
// quizball-agents service. The CMS spawns jobs by INSERTing a job row here;
// the VPS producer polls and processes them.

export interface AgentJobRow {
  id: string;
  type: string;
  status: string;
  params: Json;
  counts: Json;
  requested_by: string | null;
  budget_cents: number | null;
  spent_cents: number;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AgentTaskRow {
  id: string;
  job_id: string;
  seq: number | null;
  status: string;
  stage: string | null;
  question_draft: Json;
  verdicts: Json;
  warnings: Json;
  decision: string | null;
  reject_reason: string | null;
  published_question_id: string | null;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEventRow {
  id: number;
  job_id: string | null;
  task_id: string | null;
  ts: string;
  level: string;
  type: string;
  message: string | null;
  data: Json;
}

export interface AgentPromptRow {
  id: string;
  role: string;
  type: string;
  content: string;
  version: number;
  is_active: boolean;
  note: string | null;
  updated_by: string | null;
  created_at: string;
}

export interface AgentQuestionTypeRow {
  type: string;
  label: string;
  description: string | null;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export const agentsRepo = {
  async listJobs(limit = 50, offset = 0): Promise<AgentJobRow[]> {
    return sql<AgentJobRow[]>`
      SELECT * FROM agents.jobs
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  },

  async getJob(id: string): Promise<AgentJobRow | undefined> {
    const [row] = await sql<AgentJobRow[]>`SELECT * FROM agents.jobs WHERE id = ${id}`;
    return row;
  },

  async createJob(params: {
    type: string;
    params: Json;
    requestedBy: string | null;
    budgetCents: number | null;
  }): Promise<AgentJobRow> {
    const [row] = await sql<AgentJobRow[]>`
      INSERT INTO agents.jobs (type, status, params, requested_by, budget_cents)
      VALUES (${params.type}, 'queued', ${sql.json(params.params)}, ${params.requestedBy}, ${params.budgetCents})
      RETURNING *
    `;
    return row;
  },

  async cancelJob(id: string): Promise<void> {
    await sql`UPDATE agents.jobs SET status = 'cancelled' WHERE id = ${id} AND status IN ('queued','running','dispatched')`;
  },

  async listTasks(jobId: string): Promise<AgentTaskRow[]> {
    return sql<AgentTaskRow[]>`
      SELECT * FROM agents.tasks WHERE job_id = ${jobId} ORDER BY seq ASC NULLS LAST, created_at ASC
    `;
  },

  async listEvents(jobId: string, limit = 200): Promise<AgentEventRow[]> {
    return sql<AgentEventRow[]>`
      SELECT * FROM agents.events WHERE job_id = ${jobId} ORDER BY ts ASC LIMIT ${limit}
    `;
  },

  // live monitor: count sessions currently running, grouped by role
  async runningAgents(): Promise<{ role: string; count: number }[]> {
    return sql<{ role: string; count: number }[]>`
      SELECT role, COUNT(*)::int AS count FROM agents.sessions
      WHERE status = 'running' GROUP BY role
    `;
  },

  // per-role roster stats from sessions (today's runs, pass/fail, avg cost, running now, model)
  async agentStats(): Promise<
    {
      role: string;
      runs_today: number;
      succeeded_today: number;
      failed_today: number;
      running_now: number;
      avg_cost_cents: number;
      last_model: string | null;
      last_run_at: string | null;
    }[]
  > {
    return sql`
      SELECT
        role,
        COUNT(*) FILTER (WHERE started_at >= date_trunc('day', now() at time zone 'utc'))::int AS runs_today,
        COUNT(*) FILTER (WHERE status = 'succeeded' AND started_at >= date_trunc('day', now() at time zone 'utc'))::int AS succeeded_today,
        COUNT(*) FILTER (WHERE status IN ('failed','timeout','killed') AND started_at >= date_trunc('day', now() at time zone 'utc'))::int AS failed_today,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running_now,
        COALESCE(ROUND(AVG(cost_cents) FILTER (WHERE started_at >= date_trunc('day', now() at time zone 'utc'))), 0)::int AS avg_cost_cents,
        (ARRAY_AGG(model ORDER BY started_at DESC))[1] AS last_model,
        MAX(started_at) AS last_run_at
      FROM agents.sessions
      GROUP BY role
    ` as Promise<
      {
        role: string;
        runs_today: number;
        succeeded_today: number;
        failed_today: number;
        running_now: number;
        avg_cost_cents: number;
        last_model: string | null;
        last_run_at: string | null;
      }[]
    >;
  },

  async getBudget(): Promise<{ scope: string; limit_cents: number; spent_cents: number; paused: boolean } | undefined> {
    const [row] = await sql<{ scope: string; limit_cents: number; spent_cents: number; paused: boolean }[]>`
      SELECT scope, limit_cents, spent_cents, paused FROM agents.budgets WHERE scope = 'daily'
    `;
    return row;
  },

  async setBudget(params: { limitCents?: number; paused?: boolean }): Promise<void> {
    await sql`
      UPDATE agents.budgets
      SET limit_cents = COALESCE(${params.limitCents ?? null}, limit_cents),
          paused = COALESCE(${params.paused ?? null}, paused),
          updated_at = now()
      WHERE scope = 'daily'
    `;
  },

  // spend today (sum of session costs since midnight UTC) for the budget widget
  async spentTodayCents(): Promise<number> {
    const [row] = await sql<{ cents: number }[]>`
      SELECT COALESCE(SUM(cost_cents),0)::int AS cents FROM agents.sessions
      WHERE started_at >= date_trunc('day', now() at time zone 'utc')
    `;
    return row?.cents ?? 0;
  },

  // spend since a given instant (sum of session costs) for the rollup windows
  async spentSinceCents(sinceIso: string): Promise<number> {
    const [row] = await sql<{ cents: number }[]>`
      SELECT COALESCE(SUM(cost_cents),0)::int AS cents FROM agents.sessions
      WHERE started_at >= ${sinceIso}
    `;
    return row?.cents ?? 0;
  },

  // retry a failed task by re-queuing it (writes a control row the VPS consumes)
  async retryTask(taskId: string, createdBy: string | null): Promise<void> {
    await sql`
      INSERT INTO agents.control (action, target_id, created_by)
      VALUES ('retry_task', ${taskId}, ${createdBy})
    `;
  },

  // ── Editable sub-agent prompts (agents.prompts) ──

  // the single active prompt per role. When a type is given, the active
  // (role, type) rows; otherwise the (role, '*') defaults.
  async listActivePrompts(type?: string): Promise<AgentPromptRow[]> {
    const t = type ?? '*';
    return sql<AgentPromptRow[]>`
      SELECT * FROM agents.prompts WHERE type = ${t} AND is_active = true ORDER BY role ASC
    `;
  },

  // every version for a (role, type), newest first
  async getPromptHistory(role: string, type = '*'): Promise<AgentPromptRow[]> {
    return sql<AgentPromptRow[]>`
      SELECT * FROM agents.prompts WHERE role = ${role} AND type = ${type} ORDER BY version DESC
    `;
  },

  // deactivate the current active prompt and insert a new active version
  async savePrompt(
    role: string,
    type: string,
    content: string,
    note: string | null,
    userId: string | null
  ): Promise<AgentPromptRow> {
    const [row] = await sql<AgentPromptRow[]>`
      SELECT * FROM agents.save_prompt(${role}, ${type}, ${content}, ${note}, ${userId})
    `;
    return row;
  },

  // revert to a specific version: make it active and deactivate its siblings,
  // keeping the one-active-per-(role,type) invariant
  async activatePromptVersion(promptId: string): Promise<AgentPromptRow | undefined> {
    const [target] = await sql<AgentPromptRow[]>`
      SELECT * FROM agents.prompts WHERE id = ${promptId}
    `;
    if (!target) return undefined;
    await sql`
      UPDATE agents.prompts SET is_active = false
      WHERE role = ${target.role} AND type = ${target.type} AND id <> ${promptId} AND is_active = true
    `;
    const [row] = await sql<AgentPromptRow[]>`
      UPDATE agents.prompts SET is_active = true WHERE id = ${promptId} RETURNING *
    `;
    return row;
  },

  // ── Question types (agents.question_types) ──

  // every configured question type, in display order
  async listQuestionTypes(): Promise<AgentQuestionTypeRow[]> {
    return sql<AgentQuestionTypeRow[]>`
      SELECT * FROM agents.question_types ORDER BY sort_order ASC
    `;
  },

  // COALESCE-style partial update; returns the updated row (or undefined if missing)
  async updateQuestionType(
    type: string,
    params: { enabled?: boolean; description?: string }
  ): Promise<AgentQuestionTypeRow | undefined> {
    const [row] = await sql<AgentQuestionTypeRow[]>`
      UPDATE agents.question_types
      SET enabled = COALESCE(${params.enabled ?? null}, enabled),
          description = COALESCE(${params.description ?? null}, description),
          updated_at = now()
      WHERE type = ${type}
      RETURNING *
    `;
    return row;
  },
};
