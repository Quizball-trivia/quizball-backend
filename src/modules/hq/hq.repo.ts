import { sql } from '../../db/index.js';
import { StandupRequeueRefused } from './hq.errors.js';
import { ttlCache } from './hq.cache.js';
import type { Json } from '../../db/types.js';
import type { TaskStatus } from './hq.schemas.js';

// QuizBall HQ data access (hq schema; see supabase/migrations/20261102120000_hq_schema.sql).
// postgres.js returns timestamptz as Date and bigint as string; the service
// mappers normalise both.

type Ts = Date | string;

export interface MemberRefRow {
  id: string;
  slug: string;
  name: string;
  avatar: string;
  color: string;
  kind: 'human' | 'agent';
}

export interface BuildRow {
  id: string;
  number: string | number;
  title: string;
  kind: string;
  repos: string[];
  status: string;
  spec: string;
  director_spec: string | null;
  director_note: string | null;
  created_at: Date;
  decided_at: Date | null;
  requested_by: string | null;
  job_id: string | null;
  job_number: string | number | null;
  job_stage: string | null;
  job_note: string | null;
  runs_used: number | null;
  run_limit: number | null;
  job_started_at: Date | null;
  job_finished_at: Date | null;
  job_task_id: string | null;
  job_prs: unknown;
  job_red_green: boolean | null;
  job_reviews: number | null;
  job_playtests: number | null;
}

export interface MemberRow {
  id: string;
  slug: string;
  kind: 'human' | 'agent';
  user_id: string | null;
  name: string;
  title: string;
  avatar: string;
  color: string;
  description: string;
  instructions: string;
  model: string | null;
  tools: string[];
  autonomy: 'autonomous' | 'approval';
  runtime: 'hq' | 'question_agents' | 'bug_triage' | 'quiz_pages' | 'none';
  status: 'active' | 'paused' | 'archived';
  department: string;
  max_turns: number;
  tier: 'read' | 'act';
  is_founder: boolean;
  can_request_builds: boolean;
  role: 'agent' | 'director' | 'advisor';
  effort: string | null;
  daily_run_limit: number | null;
  max_run_cents: number | null;
  last_active_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface MemberStatsRow extends MemberRow {
  open_tasks: number;
  runs_today: number;
  cost_today_cents: number;
  current_task: { id: string; number: number | string; title: string } | null;
  last_run: { id: string; status: string; startedAt: string; endedAt: string | null } | null;
}

export interface TaskRow {
  id: string;
  number: number | string;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  assignee_id: string | null;
  created_by_id: string | null;
  parent_id: string | null;
  depth: number;
  schedule_id: string | null;
  result: string | null;
  position: number;
  attempts: number;
  claimed_by: string | null;
  claimed_at: Ts | null;
  claim_token: string | null;
  kind: 'task' | 'standup' | 'proposal' | 'chat' | 'brief';
  goal_id: string | null;
  proposal: Json | null;
  founder_approved_at: Ts | null;
  director_decision: 'approved' | 'declined' | 'escalated' | null;
  director_note: string | null;
  decided_at: Ts | null;
  escalated_at: Ts | null;
  review_state: 'accepted' | 'reopened' | 'superseded' | null;
  review_note: string | null;
  reviewed_at: Ts | null;
  reopen_count: number;
  due_at: Ts | null;
  completed_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
  assignee: MemberRefRow | null;
  created_by: MemberRefRow | null;
  assignee_runtime: string | null;
  assignee_status: string | null;
  assignee_department: string | null;
  message_count: number;
}

export interface MessageRow {
  id: number | string;
  task_id: string | null;
  author: MemberRefRow | null;
  recipient: MemberRefRow | null;
  kind: 'comment' | 'handoff' | 'system' | 'result';
  body: string;
  read_at: Ts | null;
  created_at: Ts;
}

export interface RunRow {
  id: string;
  member: MemberRefRow;
  task_id: string | null;
  task_number: number | string | null;
  task_title: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  worker: string | null;
  model: string | null;
  sdk_session_id: string | null;
  turns: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_cents: number;
  summary: string | null;
  error: string | null;
  log?: Json;
  started_at: Ts;
  ended_at: Ts | null;
}

export interface ScheduleRow {
  id: string;
  member_id: string;
  member: MemberRefRow;
  name: string;
  cron: string;
  timezone: string;
  task_title: string;
  task_body: string;
  task_kind: 'task' | 'standup';
  enabled: boolean;
  next_run_at: Ts | null;
  last_run_at: Ts | null;
  last_task_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface EventRow {
  id: number | string;
  ts: Ts;
  type: string;
  level: 'info' | 'warn' | 'error';
  member: MemberRefRow | null;
  task_id: string | null;
  task_number: number | string | null;
  run_id: string | null;
  message: string;
  data: Json;
}

export interface SettingsRow {
  paused: boolean;
  paused_reason: string | null;
  daily_limit_cents: number;
  daily_run_limit: number;
  max_concurrent_runs: number;
  plan_soft_pct: number;
  plan_hard_pct: number;
  updated_at: Ts;
  runs_today: number;
  cost_today_cents: number;
  /** hq.provider_status for Claude (null before the first reading). */
  plan_state: string | null;
  plan_until: Ts | null;
  plan_windows: Record<string, { status?: string; utilization?: number | null; resets_at?: string | null; seen_at?: string }> | null;
}

export interface TodayStatsRow {
  runs: number;
  cost_cents: number;
  failed_runs: number;
  tasks_created: number;
  tasks_done: number;
}

export interface NewAgent {
    slug: string;
    name: string;
    title: string;
    avatar: string;
    color: string;
    description: string;
    instructions: string;
    model: string | null;
    tools: string[];
    autonomy: string;
    maxTurns: number;
    status: string;
    department: string;
    tier: 'read' | 'act';
    effort: string | null;
    dailyRunLimit: number | null;
    maxRunCents: number | null;
}

export interface StandupRow {
  id: string;
  member_id: string;
  standup_date: string | Date;
  headline: string;
  yesterday: string;
  today: string;
  blockers: string;
  task_id: string | null;
  run_id: string | null;
  created_at: Ts;
  updated_at: Ts;
}

export interface DepartmentCountsRow {
  department: string;
  open: number;
  todo: number;
  in_progress: number;
  needs_approval: number;
  blocked: number;
  done_today: number;
}

export interface PulseRow {
  metrics: {
    generated_at: string;
    timezone: string;
    days: number;
    total_registered_users: number;
    new_users_by_day: Record<string, number>;
    matches_by_day: Record<string, number>;
    active_players_by_day: Record<string, number>;
  };
  feedback: {
    count_7d: number;
    avg_rating_7d: number | string | null;
    low_ratings_7d: number;
    count_prev_7d: number;
    avg_rating_prev_7d: number | string | null;
  };
}

export interface NewEvent {
  type: string;
  level?: 'info' | 'warn' | 'error';
  memberId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export type MemberColumn =
  | 'name'
  | 'title'
  | 'avatar'
  | 'color'
  | 'description'
  | 'instructions'
  | 'model'
  | 'tools'
  | 'autonomy'
  | 'max_turns'
  | 'status'
  | 'tier'
  | 'effort'
  | 'daily_run_limit'
  | 'max_run_cents'
  | 'department';

export type TaskColumn =
  | 'title'
  | 'body'
  | 'status'
  | 'priority'
  | 'assignee_id'
  | 'position'
  | 'due_at'
  | 'completed_at'
  | 'claimed_by'
  | 'claimed_at'
  | 'claim_token'
  | 'attempts'
  | 'goal_id'
  | 'founder_approved_at'
  | 'escalated_at'
  | 'review_state'
  | 'reviewed_at'
  | 'proposal';

export type ScheduleColumn = 'name' | 'cron' | 'timezone' | 'task_title' | 'task_body' | 'enabled' | 'next_run_at';

export type SettingsColumn = 'paused' | 'paused_reason' | 'daily_limit_cents' | 'daily_run_limit' | 'max_concurrent_runs' | 'plan_soft_pct' | 'plan_hard_pct';

const MEMBER_COLUMNS = new Set<string>([
  'name', 'title', 'avatar', 'color', 'description', 'instructions', 'model', 'tools', 'autonomy', 'max_turns', 'status',
  'department', 'tier', 'effort', 'daily_run_limit', 'max_run_cents',
]);
const TASK_COLUMNS = new Set<string>([
  'title', 'body', 'status', 'priority', 'assignee_id', 'position', 'due_at', 'completed_at', 'claimed_by', 'claimed_at',
  'claim_token', 'attempts', 'goal_id', 'proposal', 'founder_approved_at', 'escalated_at', 'review_state', 'reviewed_at',
]);
const SCHEDULE_COLUMNS = new Set<string>(['name', 'cron', 'timezone', 'task_title', 'task_body', 'enabled', 'next_run_at']);
const SETTINGS_COLUMNS = new Set<string>(['paused', 'paused_reason', 'daily_limit_cents', 'daily_run_limit', 'max_concurrent_runs', 'plan_soft_pct', 'plan_hard_pct']);

const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'needs_approval', 'blocked'];

// Start of "today" in Georgia time, as a timestamptz.
const todayStart = () => sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi')`;

const memberRef = (alias: string) => sql`
  CASE WHEN ${sql(alias)}.id IS NULL THEN NULL ELSE json_build_object(
    'id', ${sql(alias)}.id, 'slug', ${sql(alias)}.slug, 'name', ${sql(alias)}.name,
    'avatar', ${sql(alias)}.avatar, 'color', ${sql(alias)}.color, 'kind', ${sql(alias)}.kind
  ) END`;

type Db = typeof sql;

// `SET a = $1, b = $2` from a whitelisted column patch.
function setClause(patch: Record<string, unknown>, allowed: Set<string>, db: Db = sql) {
  const entries = Object.entries(patch).filter(([k, v]) => allowed.has(k) && v !== undefined);
  return entries.map(([column, value], i) =>
    i === 0 ? db`${db(column)} = ${value as never}` : db`, ${db(column)} = ${value as never}`
  );
}

/**
 * Optimistic guard for task writes: the update only applies while the row
 * still has the status (one of) and assignee the caller read. `assigneeId`
 * undefined = don't check it.
 */
export interface TaskGuard {
  statuses: string[];
  assigneeId?: string | null;
}

function guardClause(guard: TaskGuard, db: Db) {
  return db`AND status IN ${db(guard.statuses)} ${
    guard.assigneeId === undefined ? db`` : db`AND assignee_id IS NOT DISTINCT FROM ${guard.assigneeId}::uuid`
  }`;
}

export interface NewMessage {
  taskId: string | null;
  authorId: string | null;
  recipientId: string | null;
  kind: 'comment' | 'handoff' | 'system' | 'result';
  body: string;
}

const memberStatsSelect = () => sql`
  SELECT m.*,
    (SELECT count(*)::int FROM hq.tasks t
      WHERE t.assignee_id = m.id AND t.status IN ${sql(OPEN_STATUSES)}) AS open_tasks,
    (SELECT count(*)::int FROM hq.runs r
      WHERE r.member_id = m.id AND r.started_at >= ${todayStart()}) AS runs_today,
    (SELECT COALESCE(sum(r.cost_cents), 0)::int FROM hq.runs r
      WHERE r.member_id = m.id AND r.started_at >= ${todayStart()}) AS cost_today_cents,
    (SELECT json_build_object('id', t.id, 'number', t.number, 'title', t.title) FROM hq.tasks t
      WHERE t.assignee_id = m.id AND t.status = 'in_progress'
      ORDER BY t.claimed_at DESC NULLS LAST LIMIT 1) AS current_task,
    (SELECT json_build_object('id', r.id, 'status', r.status, 'startedAt', r.started_at, 'endedAt', r.ended_at)
      FROM hq.runs r WHERE r.member_id = m.id ORDER BY r.started_at DESC LIMIT 1) AS last_run
  FROM hq.members m`;

const taskSelect = () => sql`
  SELECT t.*,
    ${memberRef('a')} AS assignee,
    ${memberRef('c')} AS created_by,
    a.runtime AS assignee_runtime,
    a.status AS assignee_status,
    a.department AS assignee_department,
    (SELECT count(*)::int FROM hq.messages mm WHERE mm.task_id = t.id) AS message_count
  FROM hq.tasks t
  LEFT JOIN hq.members a ON a.id = t.assignee_id
  LEFT JOIN hq.members c ON c.id = t.created_by_id`;

const messageSelect = () => sql`
  SELECT msg.id, msg.task_id, msg.kind, msg.body, msg.read_at, msg.created_at,
    ${memberRef('au')} AS author,
    ${memberRef('re')} AS recipient
  FROM hq.messages msg
  LEFT JOIN hq.members au ON au.id = msg.author_id
  LEFT JOIN hq.members re ON re.id = msg.recipient_id`;

const runSelect = (withLog: boolean) => sql`
  SELECT r.id, r.task_id, r.status, r.worker, r.model, r.sdk_session_id, r.turns, r.tokens_in,
    r.tokens_out, r.cost_cents, r.summary, r.error, r.started_at, r.ended_at,
    ${withLog ? sql`r.log,` : sql``}
    ${memberRef('m')} AS member,
    t.number AS task_number, t.title AS task_title
  FROM hq.runs r
  JOIN hq.members m ON m.id = r.member_id
  LEFT JOIN hq.tasks t ON t.id = r.task_id`;

const scheduleSelect = () => sql`
  SELECT s.*, ${memberRef('m')} AS member
  FROM hq.schedules s
  JOIN hq.members m ON m.id = s.member_id`;

async function insertAgentRow(params: NewAgent, db: Db): Promise<MemberRow | undefined> {
  const [row] = await db<MemberRow[]>`
    INSERT INTO hq.members (slug, kind, name, title, avatar, color, description, instructions,
                            model, tools, autonomy, runtime, status, max_turns, department,
                            tier, effort, daily_run_limit, max_run_cents)
    VALUES (${params.slug}, 'agent', ${params.name}, ${params.title}, ${params.avatar}, ${params.color},
            ${params.description}, ${params.instructions}, ${params.model}, ${params.tools}::text[],
            ${params.autonomy}, 'hq', ${params.status}, ${params.maxTurns}, ${params.department},
            ${params.tier}, ${params.effort}, ${params.dailyRunLimit}, ${params.maxRunCents})
    ON CONFLICT (slug) DO NOTHING
    RETURNING *
  `;
  return row;
}

/** Idempotent even under concurrency: one standup schedule per member (hq_schedules_one_standup_per_member). */
async function ensureStandupScheduleRow(memberId: string, db: Db): Promise<void> {
  await db`
    INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind)
    SELECT ${memberId}, 'Daily standup', '0 8 * * *', 'Asia/Tbilisi', 'Daily standup',
           'Morning standup: report yesterday / today / blockers and propose up to 3 ideas that move the goals.',
           'standup'
    -- Isolated agents (content fixer / verifier) work alone and never do standups.
    WHERE NOT EXISTS (SELECT 1 FROM hq.members m WHERE m.id = ${memberId} AND 'isolated' = ANY(m.tools))
    ON CONFLICT (member_id) WHERE task_kind = 'standup' DO NOTHING
  `;
}

export const pulseCache = ttlCache<number, PulseRow>(60_000);

export const hqRepo = {
  // ── members ──
  async listMembers(includeArchived: boolean): Promise<MemberStatsRow[]> {
    return sql<MemberStatsRow[]>`
      ${memberStatsSelect()}
      ${includeArchived ? sql`` : sql`WHERE m.status <> 'archived'`}
      ORDER BY CASE WHEN m.kind = 'agent' THEN 0 ELSE 1 END, m.name ASC
    `;
  },

  async getMemberWithStats(id: string): Promise<MemberStatsRow | undefined> {
    const [row] = await sql<MemberStatsRow[]>`${memberStatsSelect()} WHERE m.id = ${id}`;
    return row;
  },

  async getMember(id: string): Promise<MemberRow | undefined> {
    const [row] = await sql<MemberRow[]>`SELECT * FROM hq.members WHERE id = ${id}`;
    return row;
  },

  async getMemberByUserId(userId: string): Promise<MemberRow | undefined> {
    const [row] = await sql<MemberRow[]>`SELECT * FROM hq.members WHERE user_id = ${userId}`;
    return row;
  },

  async getMemberBySlug(slug: string): Promise<MemberRow | undefined> {
    const [row] = await sql<MemberRow[]>`SELECT * FROM hq.members WHERE slug = ${slug}`;
    return row;
  },

  async insertAgent(params: NewAgent, db: Db = sql): Promise<MemberRow | undefined> {
    return insertAgentRow(params, db);
  },

  async updateMember(id: string, patch: Partial<Record<MemberColumn, unknown>>): Promise<MemberRow | undefined> {
    const sets = setClause(patch, MEMBER_COLUMNS);
    if (sets.length === 0) return this.getMember(id);
    const [row] = await sql<MemberRow[]>`
      UPDATE hq.members SET ${sets}, updated_at = now() WHERE id = ${id} RETURNING *
    `;
    return row;
  },

  // Creates the hq.members row for a CMS user (idempotent) and returns it.
  async ensureHumanForUser(userId: string): Promise<MemberRow | undefined> {
    await sql`
      INSERT INTO hq.members (slug, kind, user_id, name, title, avatar, color, runtime)
      SELECT 'u-' || substr(replace(u.id::text, '-', ''), 1, 12), 'human', u.id,
             COALESCE(NULLIF(left(btrim(u.nickname), 80), ''), NULLIF(left(split_part(COALESCE(u.email, ''), '@', 1), 80), ''), 'Admin'),
             'Team', '🧑', 'slate', 'none'
      FROM public.users u WHERE u.id = ${userId}
      ON CONFLICT DO NOTHING
    `;
    return this.getMemberByUserId(userId);
  },

  async syncHumans(): Promise<void> {
    await sql`
      INSERT INTO hq.members (slug, kind, user_id, name, title, avatar, color, runtime)
      SELECT 'u-' || substr(replace(u.id::text, '-', ''), 1, 12), 'human', u.id,
             COALESCE(NULLIF(left(btrim(u.nickname), 80), ''), NULLIF(left(split_part(COALESCE(u.email, ''), '@', 1), 80), ''), 'Admin'),
             'Team', '🧑', 'slate', 'none'
      FROM public.users u
      WHERE u.role = 'admin' AND NOT u.is_deleted
      ON CONFLICT DO NOTHING
    `;
  },

  async listHumansWithStats(): Promise<MemberStatsRow[]> {
    return sql<MemberStatsRow[]>`
      ${memberStatsSelect()} WHERE m.kind = 'human' AND m.status <> 'archived' ORDER BY m.name ASC
    `;
  },

  // ── tasks ──
  async listTasks(params: {
    statuses?: string[];
    assigneeId?: string;
    department?: string;
    kinds?: string[];
    goalId?: string;
    q?: string;
    limit: number;
  }): Promise<TaskRow[]> {
    const filters = [];
    if (params.statuses && params.statuses.length > 0) filters.push(sql`t.status IN ${sql(params.statuses)}`);
    if (params.kinds && params.kinds.length > 0) filters.push(sql`t.kind IN ${sql(params.kinds)}`);
    if (params.goalId) filters.push(sql`t.goal_id = ${params.goalId}`);
    if (params.assigneeId) filters.push(sql`t.assignee_id = ${params.assigneeId}`);
    if (params.department) filters.push(sql`a.department = ${params.department}`);
    if (params.q) {
      const like = `%${params.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const num = /^(?:hq-)?(\d{1,15})$/i.exec(params.q)?.[1];
      filters.push(
        num
          ? sql`(t.title ILIKE ${like} OR t.body ILIKE ${like} OR t.number = ${num}::bigint)`
          : sql`(t.title ILIKE ${like} OR t.body ILIKE ${like})`
      );
    }
    const where = filters.length
      ? sql`WHERE ${filters.flatMap((f, i) => (i === 0 ? [f] : [sql` AND `, f]))}`
      : sql``;
    return sql<TaskRow[]>`
      ${taskSelect()} ${where}
      ORDER BY (t.status IN ('done', 'cancelled')) ASC,
               CASE WHEN t.status IN ('done', 'cancelled') THEN t.completed_at END DESC NULLS LAST,
               t.priority ASC, t.position ASC, t.created_at DESC
      LIMIT ${params.limit}
    `;
  },

  async getTask(id: string): Promise<TaskRow | undefined> {
    const [row] = await sql<TaskRow[]>`${taskSelect()} WHERE t.id = ${id}`;
    return row;
  },

  async listChildren(parentId: string): Promise<TaskRow[]> {
    return sql<TaskRow[]>`${taskSelect()} WHERE t.parent_id = ${parentId} ORDER BY t.created_at ASC`;
  },

  async listRecentlyDone(hours: number, limit: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.status = 'done' AND t.kind <> 'standup'
        AND t.completed_at >= now() - make_interval(hours => ${hours})
      ORDER BY t.completed_at DESC LIMIT ${limit}
    `;
  },

  async listMemberTasks(memberId: string, open: boolean, limit: number): Promise<TaskRow[]> {
    return open
      ? sql<TaskRow[]>`
          ${taskSelect()} WHERE t.assignee_id = ${memberId} AND t.status IN ${sql(OPEN_STATUSES)}
          ORDER BY t.priority ASC, t.position ASC LIMIT ${limit}`
      : sql<TaskRow[]>`
          ${taskSelect()} WHERE t.assignee_id = ${memberId} AND t.status IN ('done', 'cancelled')
          ORDER BY t.completed_at DESC NULLS LAST LIMIT ${limit}`;
  },

  async latestDoneTaskFor(slug: string): Promise<TaskRow | undefined> {
    const [row] = await sql<TaskRow[]>`
      ${taskSelect()} WHERE a.slug = ${slug} AND t.status = 'done' AND t.kind <> 'standup'
      ORDER BY t.completed_at DESC NULLS LAST LIMIT 1
    `;
    return row;
  },

  /** Per-department task counts, keyed by the assignee's department. */
  async departmentCounts(): Promise<DepartmentCountsRow[]> {
    return sql<DepartmentCountsRow[]>`
      SELECT a.department,
        count(*) FILTER (WHERE t.status IN ${sql(OPEN_STATUSES)})::int AS open,
        count(*) FILTER (WHERE t.status = 'todo')::int AS todo,
        count(*) FILTER (WHERE t.status = 'in_progress')::int AS in_progress,
        count(*) FILTER (WHERE t.status = 'needs_approval')::int AS needs_approval,
        count(*) FILTER (WHERE t.status = 'blocked')::int AS blocked,
        count(*) FILTER (WHERE t.status = 'done' AND t.completed_at >= ${todayStart()})::int AS done_today
      FROM hq.tasks t
      JOIN hq.members a ON a.id = t.assignee_id
      WHERE t.kind <> 'standup'
      GROUP BY a.department
    `;
  },

  /** The newest finished task per department. */
  async lastResultPerDepartment(): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.id IN (
        SELECT DISTINCT ON (m.department) d.id
          FROM hq.tasks d
          JOIN hq.members m ON m.id = d.assignee_id
         WHERE d.status = 'done' AND d.kind <> 'standup'
         ORDER BY m.department, d.completed_at DESC NULLS LAST, d.id
      )
    `;
  },

  // ── standup ──
  async listProposals(limit: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()} WHERE t.status = 'proposed' ORDER BY (t.escalated_at IS NULL), t.created_at DESC LIMIT ${limit}
    `;
  },

  async listStandups(date: string): Promise<StandupRow[]> {
    return sql<StandupRow[]>`SELECT * FROM hq.standups WHERE standup_date = ${date}::date`;
  },

  /** In-progress task per assignee (any kind — a running standup counts). */
  async listWorking(): Promise<{ assignee_id: string; id: string; number: number | string; title: string }[]> {
    return sql<{ assignee_id: string; id: string; number: number | string; title: string }[]>`
      SELECT DISTINCT ON (t.assignee_id) t.assignee_id, t.id, t.number, t.title
        FROM hq.tasks t
       WHERE t.status = 'in_progress' AND t.assignee_id IS NOT NULL
       ORDER BY t.assignee_id, t.claimed_at DESC NULLS LAST
    `;
  },

  /** Up to `perMember` non-standup tasks each assignee finished on Tbilisi `day`. */
  async listFinishedOn(day: string, perMember: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.id IN (
        SELECT id FROM (
          SELECT d.id, row_number() OVER (PARTITION BY d.assignee_id ORDER BY d.completed_at DESC) AS rn
            FROM hq.tasks d
           WHERE d.status = 'done' AND d.kind <> 'standup' AND d.assignee_id IS NOT NULL
             AND d.completed_at >= (${day}::date::timestamp AT TIME ZONE 'Asia/Tbilisi')
             AND d.completed_at < ((${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
        ) ranked WHERE rn <= ${perMember}
      )
      ORDER BY t.completed_at DESC
    `;
  },

  /**
   * Creates today's standup task for every active HQ agent that has neither a
   * standup task created today nor a standup entry for today. Serialised with
   * an advisory lock so double-clicks can't duplicate. Returns how many.
   */
  async createStandupTasks(date: string, createdById: string | null): Promise<number> {
    // hq.create_standup_tasks takes the 'hq.standup_run' lock and runs the
    // shared guard (hq.prepare_standup) per agent — same as the schedule paths.
    const [row] = await sql<{ n: number }[]>`SELECT hq.create_standup_tasks(${date}::date, ${createdById}) AS n`;
    return row?.n ?? 0;
  },

  /**
   * Cached 60 s per replica: the overview tiles and the standup both read it,
   * open tabs poll, and each call is a ~0.3 s aggregate plus a rollup refresh.
   */
  pulse(days: number): Promise<PulseRow> {
    return pulseCache.get(days, async () => {
      const [row] = await sql<{ pulse: PulseRow }[]>`SELECT hq.pulse(${days}) AS pulse`;
      return row.pulse;
    });
  },

  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    return sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM hq.tasks WHERE kind NOT IN ('standup', 'chat') GROUP BY status
    `;
  },

  async insertTask(params: {
    title: string;
    body: string;
    status: string;
    priority: number;
    assigneeId: string | null;
    createdById: string | null;
    parentId: string | null;
    depth: number;
    scheduleId: string | null;
    dueAt: string | null;
    goalId?: string | null;
    /** A person created it: counts as their approval for an 'act' agent. */
    founderApproved?: boolean;
  }): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hq.tasks (title, body, status, priority, assignee_id, created_by_id, parent_id, depth, schedule_id, due_at, goal_id,
                            founder_approved_at)
      VALUES (${params.title}, ${params.body}, ${params.status}, ${params.priority}, ${params.assigneeId},
              ${params.createdById}, ${params.parentId}, ${params.depth}, ${params.scheduleId}, ${params.dueAt},
              ${params.goalId ?? null}, ${params.founderApproved ? sql`now()` : null})
      RETURNING id
    `;
    return row.id;
  },

  /**
   * Partial update. With a `guard`, only applies while the task still has the
   * status/assignee the caller read (guards against racing the worker's claim
   * and concurrent edits); returns false when nothing was updated.
   */
  async updateTask(id: string, patch: Partial<Record<TaskColumn, unknown>>, guard?: TaskGuard): Promise<boolean> {
    const sets = setClause(patch, TASK_COLUMNS);
    if (sets.length === 0) return true;
    const rows = await sql`
      UPDATE hq.tasks SET ${sets}, updated_at = now()
      WHERE id = ${id} ${guard ? guardClause(guard, sql) : sql``}
      RETURNING id
    `;
    return rows.length > 0;
  },

  /**
   * Conditional status transition + optional message + event, atomically.
   * Returns false (and writes nothing) when the task no longer matches `guard`.
   */
  async transitionTask(
    id: string,
    patch: Partial<Record<TaskColumn, unknown>>,
    guard: TaskGuard,
    extras: { message?: NewMessage; event?: NewEvent; standupRequeue?: { date: string } } = {}
  ): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      if (extras.standupRequeue) {
        // Same lock as every standup-creating path (hq.prepare_standup callers),
        // taken before any task row: a standup may only go back to the queue if
        // it is today's and the agent has no other live standup.
        await tx`SELECT pg_advisory_xact_lock(hashtext('hq.standup_run'))`;
        const [check] = await tx<{ today: boolean; other_live: boolean }[]>`
          SELECT (t.created_at >= (${extras.standupRequeue.date}::date::timestamp AT TIME ZONE 'Asia/Tbilisi')
                  AND t.created_at < ((${extras.standupRequeue.date}::date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')) AS today,
                 EXISTS (SELECT 1 FROM hq.tasks o
                          WHERE o.assignee_id = t.assignee_id AND o.kind = 'standup' AND o.id <> t.id
                            AND o.status IN ('todo', 'in_progress')) AS other_live
            FROM hq.tasks t WHERE t.id = ${id}
        `;
        if (check && (!check.today || check.other_live)) throw new StandupRequeueRefused();
      }
      const sets = setClause(patch, TASK_COLUMNS, tx);
      const rows = await tx`
        UPDATE hq.tasks SET ${sets}, updated_at = now()
        WHERE id = ${id} ${guardClause(guard, tx)}
        RETURNING id
      `;
      if (rows.length === 0) return false;
      if (extras.message) {
        const m = extras.message;
        await tx`
          INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
          VALUES (${m.taskId}, ${m.authorId}, ${m.recipientId}, ${m.kind}, ${m.body})
        `;
      }
      if (extras.event) {
        const e = extras.event;
        await tx`
          INSERT INTO hq.events (type, level, member_id, task_id, run_id, message, data)
          VALUES (${e.type}, ${e.level ?? 'info'}, ${e.memberId ?? null}, ${e.taskId ?? null},
                  ${e.runId ?? null}, ${e.message}, ${tx.json((e.data ?? {}) as Json)})
        `;
      }
      return true;
    }) as Promise<boolean>;
  },

  // ── messages ──
  async listTaskMessages(taskId: string): Promise<MessageRow[]> {
    return sql<MessageRow[]>`${messageSelect()} WHERE msg.task_id = ${taskId} ORDER BY msg.created_at ASC, msg.id ASC`;
  },

  async insertMessage(params: NewMessage): Promise<MessageRow> {
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
      VALUES (${params.taskId}, ${params.authorId}, ${params.recipientId}, ${params.kind}, ${params.body})
      RETURNING id
    `;
    const [row] = await sql<MessageRow[]>`${messageSelect()} WHERE msg.id = ${inserted.id}`;
    return row;
  },

  // Unread first, so read history can never push an unread message out of
  // the window. Reading messages moves them behind the unread ones, so a
  // backlog larger than the cap drains page by page as the user reads.
  async listInbox(memberId: string): Promise<MessageRow[]> {
    return sql<MessageRow[]>`
      ${messageSelect()}
      WHERE msg.recipient_id = ${memberId}
        AND msg.channel IS NULL
        AND (msg.read_at IS NULL OR msg.created_at >= now() - interval '7 days')
      ORDER BY (msg.read_at IS NULL) DESC, msg.created_at DESC, msg.id DESC
      LIMIT 300
    `;
  },

  async countUnread(memberId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM hq.messages WHERE recipient_id = ${memberId} AND read_at IS NULL AND channel IS NULL
    `;
    return row?.n ?? 0;
  },

  async markRead(memberId: string, ids?: number[]): Promise<void> {
    await sql`
      UPDATE hq.messages SET read_at = now()
      WHERE recipient_id = ${memberId} AND read_at IS NULL AND channel IS NULL
      ${ids ? sql`AND id IN ${sql(ids)}` : sql``}
    `;
  },

  // ── runs ──
  async listRuns(params: { memberId?: string; taskId?: string; limit: number }): Promise<RunRow[]> {
    const filters = [];
    if (params.memberId) filters.push(sql`r.member_id = ${params.memberId}`);
    if (params.taskId) filters.push(sql`r.task_id = ${params.taskId}`);
    const where = filters.length
      ? sql`WHERE ${filters.flatMap((f, i) => (i === 0 ? [f] : [sql` AND `, f]))}`
      : sql``;
    return sql<RunRow[]>`${runSelect(false)} ${where} ORDER BY r.started_at DESC LIMIT ${params.limit}`;
  },

  async getRun(id: string): Promise<RunRow | undefined> {
    const [row] = await sql<RunRow[]>`${runSelect(true)} WHERE r.id = ${id}`;
    return row;
  },

  async listRunningRuns(): Promise<RunRow[]> {
    return sql<RunRow[]>`${runSelect(false)} WHERE r.status = 'running' ORDER BY r.started_at ASC`;
  },

  async todayStats(): Promise<TodayStatsRow> {
    // runs/cost come from hq.today_usage() — the same Tbilisi-day window the
    // worker enforces its caps with.
    const [row] = await sql<TodayStatsRow[]>`
      SELECT
        (u.usage->>'runs')::int AS runs,
        (u.usage->>'cost_cents')::int AS cost_cents,
        (SELECT count(*)::int FROM hq.runs
          WHERE started_at >= ${todayStart()} AND status IN ('failed', 'timeout')) AS failed_runs,
        (SELECT count(*)::int FROM hq.tasks WHERE created_at >= ${todayStart()}) AS tasks_created,
        (SELECT count(*)::int FROM hq.tasks
          WHERE status = 'done' AND completed_at >= ${todayStart()}) AS tasks_done
      FROM (SELECT hq.today_usage() AS usage) u
    `;
    return row;
  },

  // ── events ──
  async listEvents(params: { limit: number; beforeId?: number; memberId?: string }): Promise<EventRow[]> {
    const filters = [];
    if (params.beforeId) filters.push(sql`e.id < ${params.beforeId}`);
    if (params.memberId) filters.push(sql`e.member_id = ${params.memberId}`);
    const where = filters.length
      ? sql`WHERE ${filters.flatMap((f, i) => (i === 0 ? [f] : [sql` AND `, f]))}`
      : sql``;
    return sql<EventRow[]>`
      SELECT e.id, e.ts, e.type, e.level, e.task_id, e.run_id, e.message, e.data,
        ${memberRef('m')} AS member,
        t.number AS task_number
      FROM hq.events e
      LEFT JOIN hq.members m ON m.id = e.member_id
      LEFT JOIN hq.tasks t ON t.id = e.task_id
      ${where}
      ORDER BY e.id DESC
      LIMIT ${params.limit}
    `;
  },

  async insertEvent(e: NewEvent): Promise<void> {
    await sql`
      INSERT INTO hq.events (type, level, member_id, task_id, run_id, message, data)
      VALUES (${e.type}, ${e.level ?? 'info'}, ${e.memberId ?? null}, ${e.taskId ?? null},
              ${e.runId ?? null}, ${e.message}, ${sql.json((e.data ?? {}) as Json)})
    `;
  },

  // ── schedules ──
  async listSchedules(memberId?: string): Promise<ScheduleRow[]> {
    return sql<ScheduleRow[]>`
      ${scheduleSelect()} ${memberId ? sql`WHERE s.member_id = ${memberId}` : sql``}
      ORDER BY m.name ASC, s.name ASC
    `;
  },

  async getSchedule(id: string): Promise<ScheduleRow | undefined> {
    const [row] = await sql<ScheduleRow[]>`${scheduleSelect()} WHERE s.id = ${id}`;
    return row;
  },

  async insertSchedule(params: {
    memberId: string;
    name: string;
    cron: string;
    timezone: string;
    taskTitle: string;
    taskBody: string;
    enabled: boolean;
  }): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, enabled)
      VALUES (${params.memberId}, ${params.name}, ${params.cron}, ${params.timezone},
              ${params.taskTitle}, ${params.taskBody}, ${params.enabled})
      RETURNING id
    `;
    return row.id;
  },

  async updateSchedule(id: string, patch: Partial<Record<ScheduleColumn, unknown>>): Promise<boolean> {
    const sets = setClause(patch, SCHEDULE_COLUMNS);
    if (sets.length === 0) return true;
    const rows = await sql`UPDATE hq.schedules SET ${sets}, updated_at = now() WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  /** The 08:00 "Daily standup" schedule for an HQ agent (no-op if it has one). */
  async ensureStandupSchedule(memberId: string, db: Db = sql): Promise<void> {
    return ensureStandupScheduleRow(memberId, db);
  },

  /** Creates an HQ agent and its standup schedule atomically (undefined on slug conflict). */
  async insertAgentWithStandup(params: NewAgent): Promise<MemberRow | undefined> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const row = await insertAgentRow(params, tx);
      if (row && row.status === 'active') await ensureStandupScheduleRow(row.id, tx);
      return row;
    }) as Promise<MemberRow | undefined>;
  },

  async deleteSchedule(id: string): Promise<boolean> {
    const rows = await sql`DELETE FROM hq.schedules WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  /**
   * Manual "run now": creates the schedule's task (with the schedule's kind),
   * stamps last_run_at / last_task_id and logs the event in one transaction.
   * next_run_at is left alone — the regular cadence is unaffected. A standup
   * schedule whose agent already has today's standup creates nothing
   * (same guard + advisory lock as hq.fire_schedule and /standup/run).
   */
  async runScheduleNow(params: {
    scheduleId: string;
    createdById: string;
    date: string;
    event: (task: { id: string; number: number | string }) => NewEvent;
  }): Promise<{ taskId: string } | { duplicate: true } | null> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      // Lock order = hq.fire_schedule: standup advisory lock first, then the
      // schedule row (FOR UPDATE — it is stamped below, and an upfront
      // exclusive lock avoids SHARE→UPDATE upgrade deadlocks between two
      // concurrent run-nows). task_kind is peeked without a lock to decide.
      const [peek] = await tx<{ task_kind: string }[]>`
        SELECT task_kind FROM hq.schedules WHERE id = ${params.scheduleId}
      `;
      if (!peek) return null;
      if (peek.task_kind === 'standup') {
        await tx`SELECT pg_advisory_xact_lock(hashtext('hq.standup_run'))`;
      }
      const [schedule] = await tx<{ id: string; member_id: string; task_kind: string }[]>`
        SELECT id, member_id, task_kind FROM hq.schedules WHERE id = ${params.scheduleId} FOR UPDATE
      `;
      if (!schedule) return null; // deleted meanwhile
      if (schedule.task_kind === 'standup') {
        if (peek.task_kind !== 'standup') {
          // task_kind isn't editable via the API; mirrors fire_schedule's rare path.
          await tx`SELECT pg_advisory_xact_lock(hashtext('hq.standup_run'))`;
        }
        // Shared guard: supersedes stale standups, respects an in-progress one.
        const [{ ok }] = await tx<{ ok: boolean }[]>`
          SELECT hq.prepare_standup(${schedule.member_id}, ${params.date}::date) AS ok
        `;
        if (!ok) return { duplicate: true as const };
      }
      const [task] = await tx<{ id: string; number: string }[]>`
        INSERT INTO hq.tasks (title, body, status, kind, priority, assignee_id, created_by_id, schedule_id)
        SELECT s.task_title, s.task_body, 'todo', s.task_kind, 2, s.member_id, ${params.createdById}, s.id
        FROM hq.schedules s WHERE s.id = ${params.scheduleId}
        RETURNING id, number
      `;
      if (!task) return null; // schedule vanished (defensive; the FOR UPDATE above prevents it)
      await tx`
        UPDATE hq.schedules SET last_run_at = now(), last_task_id = ${task.id}, updated_at = now()
        WHERE id = ${params.scheduleId}
      `;
      const e = params.event(task);
      await tx`
        INSERT INTO hq.events (type, level, member_id, task_id, run_id, message, data)
        VALUES (${e.type}, ${e.level ?? 'info'}, ${e.memberId ?? null}, ${task.id},
                ${e.runId ?? null}, ${e.message}, ${tx.json((e.data ?? {}) as Json)})
      `;
      return { taskId: task.id };
    }) as Promise<{ taskId: string } | { duplicate: true } | null>;
  },

  // ── director ──
  async getDirector(): Promise<MemberStatsRow | undefined> {
    const [row] = await sql<MemberStatsRow[]>`
      ${memberStatsSelect()} WHERE m.role = 'director' AND m.status <> 'archived' LIMIT 1
    `;
    return row;
  },

  /** What every agent is doing right now (for the Director page). */
  async listRunningNow(limit: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.status = 'in_progress' AND t.kind <> 'chat'
      ORDER BY t.claimed_at DESC NULLS LAST
      LIMIT ${limit}
    `;
  },

  /** Today's plan: items the director put up today (Tbilisi day), any status. */
  async listTodayPlan(directorId: string): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.created_by_id = ${directorId} AND t.kind = 'proposal' AND t.proposal ->> 'plan_day' IS NOT NULL
        AND t.created_at >= ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'
      ORDER BY t.number
    `;
  },

  /** Work finished today (Tbilisi day) that no longer waits on anyone; a build's code reviews are part of the build. */
  async listDoneToday(limit: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.status = 'done' AND t.kind IN ('task', 'proposal') AND t.escalated_at IS NULL
        AND NOT (COALESCE(t.ref, '{}'::jsonb) ? 'build_job' AND COALESCE(t.ref ->> 'review', '') = 'true')
        AND t.completed_at >= ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi'
      ORDER BY t.completed_at DESC
      LIMIT ${limit}
    `;
  },

  async latestBrief(directorId: string): Promise<TaskRow | undefined> {
    const [row] = await sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.assignee_id = ${directorId} AND t.kind = 'brief' AND t.status = 'done' AND t.result IS NOT NULL
      ORDER BY t.completed_at DESC NULLS LAST LIMIT 1
    `;
    return row;
  },

  /** What waits for a person: what the director sent up (finished work only until it is reviewed), results to
   *  approve, safety stops (blocked after failed runs), and blocked work the director may not move (a person's,
   *  an agent that changes things, or another runtime such as quiz pages). The rest of blocked work is his. */
  async listNeedsYou(limit: number): Promise<TaskRow[]> {
    return sql<TaskRow[]>`
      ${taskSelect()}
      WHERE t.kind <> 'chat'
        AND ((t.escalated_at IS NOT NULL AND t.status <> 'cancelled' AND (t.status <> 'done' OR t.review_state IS NULL))
             OR t.status = 'needs_approval'
             OR (t.status = 'blocked' AND (
                   NOT EXISTS (SELECT 1 FROM hq.members a
                                WHERE a.id = t.assignee_id AND a.kind = 'agent' AND a.runtime = 'hq' AND a.tier = 'read')
                   OR EXISTS (
                     SELECT 1 FROM (SELECT r.status FROM hq.runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC LIMIT 1) last_run
                      WHERE last_run.status IN ('failed', 'timeout')))))
      ORDER BY COALESCE(t.escalated_at, t.updated_at) DESC
      LIMIT ${limit}
    `;
  },

  async listDirectorDecisions(directorId: string, limit: number): Promise<EventRow[]> {
    return sql<EventRow[]>`
      SELECT e.id, e.ts, e.type, e.level, e.task_id, e.run_id, e.message, e.data,
        ${memberRef('m')} AS member,
        t.number AS task_number
      FROM hq.events e
      LEFT JOIN hq.members m ON m.id = e.member_id
      LEFT JOIN hq.tasks t ON t.id = e.task_id
      WHERE e.member_id = ${directorId}
        AND e.type IN ('director_approved', 'director_declined', 'director_escalated', 'director_accepted', 'director_reopened', 'director_cancelled', 'director_updated')
      ORDER BY e.id DESC LIMIT ${limit}
    `;
  },

  async chatState(directorId: string, humanId: string): Promise<{ queued: boolean; running: boolean }> {
    const [row] = await sql<{ queued: boolean; running: boolean }[]>`
      SELECT bool_or(status = 'todo') AS queued, bool_or(status = 'in_progress') AS running
        FROM hq.tasks
       WHERE kind = 'chat' AND assignee_id = ${directorId} AND created_by_id = ${humanId}
         AND status IN ('todo', 'in_progress')
    `;
    return { queued: !!row?.queued, running: !!row?.running };
  },

  async listChat(directorId: string, humanId: string, beforeId: number | undefined, limit: number): Promise<MessageRow[]> {
    return sql<MessageRow[]>`
      ${messageSelect()}
      WHERE msg.channel = 'director'
        AND ((msg.author_id = ${humanId} AND msg.recipient_id = ${directorId})
             OR (msg.author_id = ${directorId} AND msg.recipient_id = ${humanId}))
        ${beforeId ? sql`AND msg.id < ${beforeId}` : sql``}
      ORDER BY msg.id DESC
      LIMIT ${limit}
    `;
  },

  async submitBuild(humanId: string, b: { title: string; spec: string; kind: string; repos: string[] }): Promise<{ id: string }> {
    const [row] = await sql<{ id: string }[]>`SELECT id FROM hq.submit_build_request(${humanId}, ${b.title}, ${b.spec}, ${b.kind}, ${b.repos})`;
    return row;
  },

  async listBuilds(limit: number): Promise<BuildRow[]> {
    return sql<BuildRow[]>`
      SELECT r.id, r.number, r.title, r.kind, r.repos, r.status, r.spec, r.director_spec, r.director_note, r.created_at,
             r.decided_at, m.name AS requested_by,
             j.id AS job_id, j.number AS job_number, j.stage AS job_stage, j.note AS job_note, j.runs_used, j.run_limit,
             j.started_at AS job_started_at, j.finished_at AS job_finished_at, j.task_id AS job_task_id,
             j.evidence -> 'prs' AS job_prs,
             COALESCE(j.checkpoint -> 'red_green', '{}'::jsonb) <> '{}'::jsonb AS job_red_green,
             CASE WHEN jsonb_typeof(j.checkpoint -> 'reviews') = 'array' THEN jsonb_array_length(j.checkpoint -> 'reviews') ELSE 0 END AS job_reviews,
             CASE WHEN jsonb_typeof(j.checkpoint -> 'playtests') = 'number' THEN (j.checkpoint ->> 'playtests')::numeric::int ELSE 0 END AS job_playtests
        FROM hq.build_requests r
        LEFT JOIN hq.members m ON m.id = r.requested_by
        LEFT JOIN hq.build_jobs j ON j.request_id = r.id
       ORDER BY r.created_at DESC LIMIT ${limit}`;
  },

  async cancelBuildRequest(actorId: string, requestId: string, note: string): Promise<string> {
    const [row] = await sql<{ result: string }[]>`SELECT hq.cancel_build_request(${actorId}, ${requestId}, ${note}) AS result`;
    return row.result;
  },

  async sendChat(humanId: string, body: string): Promise<{ message_id: number | string; task_id: string }> {
    const [row] = await sql<{ message_id: number | string; task_id: string }[]>`
      SELECT * FROM hq.director_chat_send(${humanId}, ${body})
    `;
    return row;
  },

  async markChatRead(directorId: string, humanId: string): Promise<void> {
    await sql`
      UPDATE hq.messages SET read_at = now()
       WHERE channel = 'director' AND recipient_id = ${humanId} AND author_id = ${directorId} AND read_at IS NULL
    `;
  },

  async getSettings(): Promise<SettingsRow> {
    const [row] = await sql<SettingsRow[]>`
      SELECT s.paused, s.paused_reason, s.daily_limit_cents, s.daily_run_limit, s.max_concurrent_runs,
        s.plan_soft_pct, s.plan_hard_pct, s.updated_at,
        (u.usage->>'runs')::int AS runs_today,
        (u.usage->>'cost_cents')::int AS cost_today_cents,
        ps.state AS plan_state, ps.until AS plan_until, ps.windows AS plan_windows
      FROM hq.settings s
      CROSS JOIN (SELECT hq.today_usage() AS usage) u
      LEFT JOIN hq.provider_status ps ON ps.provider = 'claude'
      WHERE s.id = true
    `;
    return row;
  },

  async updateSettings(patch: Partial<Record<SettingsColumn, unknown>>, userId: string | null): Promise<void> {
    const sets = setClause(patch, SETTINGS_COLUMNS);
    if (sets.length === 0) return;
    await sql`
      UPDATE hq.settings SET ${sets}, updated_by = ${userId}, updated_at = now() WHERE id = true
    `;
  },

  // ── external pipelines (schemas may be absent; callers catch) ──
  async questionAgentStats(): Promise<{ jobs: number; accepted: number; rejected: number; failed: number }> {
    const [row] = await sql<{ jobs: number; accepted: number; rejected: number; failed: number }[]>`
      SELECT
        (SELECT count(*)::int FROM agents.jobs WHERE created_at >= now() - interval '7 days') AS jobs,
        count(*) FILTER (WHERE decision = 'approved')::int AS accepted,
        count(*) FILTER (WHERE decision = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM agents.tasks
      WHERE created_at >= now() - interval '7 days'
    `;
    return row;
  },

  /** The quiz-page agent's last 7 days, from its build list and commit ledger. */
  async quizPageStats(): Promise<{ published: number; refreshed: number; queued: number; held: number }> {
    const [row] = await sql<{ published: number; refreshed: number; queued: number; held: number }[]>`
      SELECT
        (SELECT count(*)::int FROM campaign_quiz_agent_commits WHERE action = 'create' AND created_at >= now() - interval '7 days') AS published,
        (SELECT count(*)::int FROM campaign_quiz_agent_commits WHERE action = 'refresh' AND created_at >= now() - interval '7 days') AS refreshed,
        (SELECT count(*)::int FROM campaign_quiz_backlog WHERE status IN ('queued', 'building')) AS queued,
        (SELECT count(*)::int FROM campaign_quiz_backlog WHERE status = 'held') AS held
    `;
    return row;
  },

  async bugTriageStats(): Promise<{ reports: number; prs: number; needs_info: number }> {
    const [row] = await sql<{ reports: number; prs: number; needs_info: number }[]>`
      SELECT count(*)::int AS reports,
             count(*) FILTER (WHERE pr_url IS NOT NULL)::int AS prs,
             count(*) FILTER (WHERE status ILIKE '%info%')::int AS needs_info
      FROM bug_triage.reports
      WHERE received_at >= now() - interval '7 days'
    `;
    return row;
  },
};
