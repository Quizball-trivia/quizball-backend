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

export interface AgentScheduleRow {
  id: string;
  label: string;
  job_type: string;
  enabled: boolean;
  hour_tbilisi: number;
  params: Json;
  last_run_at: string | null;
  last_job_id: string | null;
  last_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentReviewRow {
  id: string;
  type: string;
  difficulty: string;
  category_id: string;
  prompt: Json;
  created_at: string;
  job_type: string;
  topic: string | null;
  task_id: string;
  verdicts: Json;
  warnings: Json;
  payload: Json;
}

export const agentsRepo = {
  async listJobs(limit = 50, offset = 0): Promise<AgentJobRow[]> {
    // spent_cents is computed live from the sessions (the jobs column is never
    // rolled up), so the Spend shown always reflects actual agent usage.
    return sql<AgentJobRow[]>`
      SELECT j.*, COALESCE(s.spent, 0)::int AS spent_cents
      FROM agents.jobs j
      LEFT JOIN (
        SELECT job_id, SUM(cost_cents) AS spent FROM agents.sessions GROUP BY job_id
      ) s ON s.job_id = j.id
      ORDER BY j.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  },

  async getJob(id: string): Promise<AgentJobRow | undefined> {
    const [row] = await sql<AgentJobRow[]>`
      SELECT j.*, COALESCE((
        SELECT SUM(cost_cents) FROM agents.sessions WHERE job_id = j.id
      ), 0)::int AS spent_cents
      FROM agents.jobs j WHERE j.id = ${id}
    `;
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

  // ── Live activity feed ──
  // Every session running right now, with the job topic + the question stem it's
  // working on (so the UI can show "factcheck · Q#2 'Beckenbauer…' · 42s").
  async liveSessions(): Promise<
    {
      id: string;
      role: string;
      model: string | null;
      started_at: string;
      job_id: string | null;
      task_seq: number | null;
      job_topic: string | null;
      question: string | null;
    }[]
  > {
    return sql`
      SELECT
        s.id, s.role, s.model, s.started_at, s.job_id,
        t.seq AS task_seq,
        (j.params ->> 'topic') AS job_topic,
        COALESCE(
          t.question_draft -> 'prompt' ->> 'en',
          t.question_draft -> 'display_answer' ->> 'en'
        ) AS question
      FROM agents.sessions s
      LEFT JOIN agents.tasks t ON t.id = s.task_id
      LEFT JOIN agents.jobs  j ON j.id = s.job_id
      WHERE s.status = 'running'
      ORDER BY s.started_at ASC
    ` as Promise<
      {
        id: string;
        role: string;
        model: string | null;
        started_at: string;
        job_id: string | null;
        task_seq: number | null;
        job_topic: string | null;
        question: string | null;
      }[]
    >;
  },

  // rollup over a recent window for the activity-feed header (last N hours)
  async recentActivity(sinceIso: string): Promise<{ generated: number; approved: number; rejected: number; failed: number }> {
    const [row] = await sql<{ generated: number; approved: number; rejected: number; failed: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE decision IS NOT NULL OR status IN ('approved','rejected','failed'))::int AS generated,
        COUNT(*) FILTER (WHERE decision = 'approved')::int AS approved,
        COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejected,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM agents.tasks
      WHERE created_at >= ${sinceIso}
    `;
    return row ?? { generated: 0, approved: 0, rejected: 0, failed: 0 };
  },

  // ── Stats rollups (last N days) ──
  // per-day approved/rejected counts (from tasks) + spend (from sessions),
  // computed in two grouped CTEs then full-joined by day — avoids a correlated
  // subquery (which can't reference the outer GROUP BY).
  async dailyStats(days: number): Promise<
    { day: string; approved: number; rejected: number; cost_cents: number }[]
  > {
    return sql`
      WITH task_days AS (
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               COUNT(*) FILTER (WHERE decision = 'approved')::int AS approved,
               COUNT(*) FILTER (WHERE decision = 'rejected')::int AS rejected
        FROM agents.tasks
        WHERE created_at >= (now() - make_interval(days => ${days}))
        GROUP BY 1
      ),
      cost_days AS (
        SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day,
               COALESCE(SUM(cost_cents),0)::int AS cost_cents
        FROM agents.sessions
        WHERE started_at >= (now() - make_interval(days => ${days}))
        GROUP BY 1
      )
      SELECT COALESCE(t.day, c.day) AS day,
             COALESCE(t.approved, 0) AS approved,
             COALESCE(t.rejected, 0) AS rejected,
             COALESCE(c.cost_cents, 0) AS cost_cents
      FROM task_days t
      FULL OUTER JOIN cost_days c ON c.day = t.day
      ORDER BY 1 ASC
    ` as Promise<{ day: string; approved: number; rejected: number; cost_cents: number }[]>;
  },

  // rejection reasons grouped by stage over the window (factcheck/dedupe/…)
  async rejectionReasons(days: number): Promise<{ stage: string; count: number }[]> {
    return sql`
      SELECT COALESCE(stage, 'unknown') AS stage, COUNT(*)::int AS count
      FROM agents.tasks
      WHERE decision = 'rejected' AND created_at >= (now() - make_interval(days => ${days}))
      GROUP BY 1 ORDER BY count DESC
    ` as Promise<{ stage: string; count: number }[]>;
  },

  // avg session duration + cost per role over the window (the "how fast per stage")
  async stageTimings(days: number): Promise<{ role: string; avg_seconds: number; runs: number }[]> {
    return sql`
      SELECT role,
        COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)))), 0)::int AS avg_seconds,
        COUNT(*)::int AS runs
      FROM agents.sessions
      WHERE ended_at IS NOT NULL AND started_at >= (now() - make_interval(days => ${days}))
      GROUP BY role ORDER BY role
    ` as Promise<{ role: string; avg_seconds: number; runs: number }[]>;
  },

  // ── Schedules (agents.schedules) ──
  async listSchedules(): Promise<AgentScheduleRow[]> {
    return sql<AgentScheduleRow[]>`SELECT * FROM agents.schedules ORDER BY id ASC`;
  },

  async getSchedule(id: string): Promise<AgentScheduleRow | undefined> {
    const [row] = await sql<AgentScheduleRow[]>`SELECT * FROM agents.schedules WHERE id = ${id}`;
    return row;
  },

  async updateSchedule(
    id: string,
    params: { enabled?: boolean; hourTbilisi?: number; params?: Json }
  ): Promise<AgentScheduleRow | undefined> {
    const [row] = await sql<AgentScheduleRow[]>`
      UPDATE agents.schedules
      SET enabled = COALESCE(${params.enabled ?? null}, enabled),
          hour_tbilisi = COALESCE(${params.hourTbilisi ?? null}, hour_tbilisi),
          params = COALESCE(${params.params ? sql.json(params.params) : null}, params),
          updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return row;
  },

  // last N jobs produced by a schedule's job_type (the run history for that schedule)
  async scheduleRuns(jobType: string, limit = 30): Promise<AgentJobRow[]> {
    return sql<AgentJobRow[]>`
      SELECT * FROM agents.jobs WHERE type = ${jobType}
      ORDER BY created_at DESC LIMIT ${limit}
    `;
  },

  // Active daily-challenge configs, for mapping a question → the challenges it can
  // feed. Returns challenge_type + its category filter (empty = all categories).
  async activeDailyChallenges(): Promise<{ challenge_type: string; category_ids: string[] }[]> {
    const rows = await sql<{ challenge_type: string; category_ids: string[] | null }[]>`
      SELECT challenge_type, (settings ->> 'categoryIds') IS NOT NULL AS has_cats,
             COALESCE(settings -> 'categoryIds', '[]'::jsonb) AS category_ids
      FROM public.daily_challenge_configs
      WHERE is_active = true
    `;
    return rows.map((r) => ({
      challenge_type: r.challenge_type,
      category_ids: Array.isArray(r.category_ids) ? r.category_ids : [],
    }));
  },

  // ── Review queue ──
  // Draft questions the agents produced (status='draft', joined back to the task
  // that published them for source/verdicts). This is the editor's review inbox.
  async reviewQueue(limit = 200): Promise<AgentReviewRow[]> {
    return sql<AgentReviewRow[]>`
      SELECT
        q.id,
        q.type,
        q.difficulty,
        q.category_id,
        q.prompt,
        q.created_at,
        j.type   AS job_type,
        (j.params ->> 'topic') AS topic,
        t.id     AS task_id,
        t.verdicts,
        t.warnings,
        p.payload
      FROM public.questions q
      JOIN agents.tasks t ON t.published_question_id = q.id
      JOIN agents.jobs  j ON j.id = t.job_id
      LEFT JOIN public.question_payloads p ON p.question_id = q.id
      WHERE q.status = 'draft'
      ORDER BY q.created_at DESC
      LIMIT ${limit}
    `;
  },

  // count of draft agent questions waiting — for the "N waiting" badge/notification
  async reviewQueueCount(): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM public.questions q
      JOIN agents.tasks t ON t.published_question_id = q.id
      WHERE q.status = 'draft'
    `;
    return row?.count ?? 0;
  },

  // approve → publish (goes live); reject → archive. Scoped to draft agent
  // questions so we can't accidentally flip an unrelated question.
  async setQuestionStatus(questionId: string, status: 'published' | 'archived'): Promise<boolean> {
    const rows = await sql`
      UPDATE public.questions SET status = ${status}, updated_at = now()
      WHERE id = ${questionId}
        AND status = 'draft'
        AND id IN (SELECT published_question_id FROM agents.tasks WHERE published_question_id = ${questionId})
      RETURNING id
    `;
    return rows.length > 0;
  },

  // The context needed to regenerate a draft question: its type + category +
  // the originating job's type/topic. Null if it's not an agent draft.
  async questionRegenContext(
    questionId: string
  ): Promise<{ type: string; category_id: string; job_type: string; topic: string | null } | undefined> {
    const [row] = await sql<{ type: string; category_id: string; job_type: string; topic: string | null }[]>`
      SELECT q.type, q.category_id, j.type AS job_type, (j.params ->> 'topic') AS topic
      FROM public.questions q
      JOIN agents.tasks t ON t.published_question_id = q.id
      JOIN agents.jobs  j ON j.id = t.job_id
      WHERE q.id = ${questionId} AND q.status = 'draft'
    `;
    return row;
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
