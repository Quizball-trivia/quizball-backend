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

  // retry a failed task by re-queuing it (writes a control row the VPS consumes)
  async retryTask(taskId: string, createdBy: string | null): Promise<void> {
    await sql`
      INSERT INTO agents.control (action, target_id, created_by)
      VALUES ('retry_task', ${taskId}, ${createdBy})
    `;
  },
};
