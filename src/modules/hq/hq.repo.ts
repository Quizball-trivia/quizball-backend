import { sql } from '../../db/index.js';
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
  runtime: 'hq' | 'question_agents' | 'bug_triage' | 'none';
  status: 'active' | 'paused' | 'archived';
  max_turns: number;
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
  due_at: Ts | null;
  completed_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
  assignee: MemberRefRow | null;
  created_by: MemberRefRow | null;
  assignee_runtime: string | null;
  assignee_status: string | null;
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
  updated_at: Ts;
  runs_today: number;
  cost_today_cents: number;
}

export interface TodayStatsRow {
  runs: number;
  cost_cents: number;
  failed_runs: number;
  tasks_created: number;
  tasks_done: number;
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
  | 'status';

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
  | 'claim_token';

export type ScheduleColumn = 'name' | 'cron' | 'timezone' | 'task_title' | 'task_body' | 'enabled' | 'next_run_at';

export type SettingsColumn = 'paused' | 'paused_reason' | 'daily_limit_cents' | 'daily_run_limit' | 'max_concurrent_runs';

const MEMBER_COLUMNS = new Set<string>([
  'name', 'title', 'avatar', 'color', 'description', 'instructions', 'model', 'tools', 'autonomy', 'max_turns', 'status',
]);
const TASK_COLUMNS = new Set<string>([
  'title', 'body', 'status', 'priority', 'assignee_id', 'position', 'due_at', 'completed_at', 'claimed_by', 'claimed_at',
  'claim_token',
]);
const SCHEDULE_COLUMNS = new Set<string>(['name', 'cron', 'timezone', 'task_title', 'task_body', 'enabled', 'next_run_at']);
const SETTINGS_COLUMNS = new Set<string>(['paused', 'paused_reason', 'daily_limit_cents', 'daily_run_limit', 'max_concurrent_runs']);

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

  async insertAgent(params: {
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
  }): Promise<MemberRow | undefined> {
    const [row] = await sql<MemberRow[]>`
      INSERT INTO hq.members (slug, kind, name, title, avatar, color, description, instructions,
                              model, tools, autonomy, runtime, status, max_turns)
      VALUES (${params.slug}, 'agent', ${params.name}, ${params.title}, ${params.avatar}, ${params.color},
              ${params.description}, ${params.instructions}, ${params.model}, ${params.tools}::text[],
              ${params.autonomy}, 'hq', ${params.status}, ${params.maxTurns})
      ON CONFLICT (slug) DO NOTHING
      RETURNING *
    `;
    return row;
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
    q?: string;
    limit: number;
  }): Promise<TaskRow[]> {
    const filters = [];
    if (params.statuses && params.statuses.length > 0) filters.push(sql`t.status IN ${sql(params.statuses)}`);
    if (params.assigneeId) filters.push(sql`t.assignee_id = ${params.assigneeId}`);
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
      WHERE t.status = 'done' AND t.completed_at >= now() - make_interval(hours => ${hours})
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
      ${taskSelect()} WHERE a.slug = ${slug} AND t.status = 'done'
      ORDER BY t.completed_at DESC NULLS LAST LIMIT 1
    `;
    return row;
  },

  async countsByStatus(): Promise<{ status: string; count: number }[]> {
    return sql<{ status: string; count: number }[]>`
      SELECT status, count(*)::int AS count FROM hq.tasks GROUP BY status
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
  }): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hq.tasks (title, body, status, priority, assignee_id, created_by_id, parent_id, depth, schedule_id, due_at)
      VALUES (${params.title}, ${params.body}, ${params.status}, ${params.priority}, ${params.assigneeId},
              ${params.createdById}, ${params.parentId}, ${params.depth}, ${params.scheduleId}, ${params.dueAt})
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
    extras: { message?: NewMessage; event?: NewEvent } = {}
  ): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
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
        AND (msg.read_at IS NULL OR msg.created_at >= now() - interval '7 days')
      ORDER BY (msg.read_at IS NULL) DESC, msg.created_at DESC, msg.id DESC
      LIMIT 300
    `;
  },

  async countUnread(memberId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM hq.messages WHERE recipient_id = ${memberId} AND read_at IS NULL
    `;
    return row?.n ?? 0;
  },

  async markRead(memberId: string, ids?: number[]): Promise<void> {
    await sql`
      UPDATE hq.messages SET read_at = now()
      WHERE recipient_id = ${memberId} AND read_at IS NULL
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

  async deleteSchedule(id: string): Promise<boolean> {
    const rows = await sql`DELETE FROM hq.schedules WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  },

  /**
   * Manual "run now": creates the schedule's task, stamps last_run_at /
   * last_task_id and logs the event in one transaction. next_run_at is left
   * alone — the regular cadence is unaffected. Returns the new task id.
   */
  async runScheduleNow(params: {
    scheduleId: string;
    createdById: string;
    event: (task: { id: string; number: number | string }) => NewEvent;
  }): Promise<string | null> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [task] = await tx<{ id: string; number: string }[]>`
        INSERT INTO hq.tasks (title, body, status, priority, assignee_id, created_by_id, schedule_id)
        SELECT s.task_title, s.task_body, 'todo', 2, s.member_id, ${params.createdById}, s.id
        FROM hq.schedules s WHERE s.id = ${params.scheduleId}
        RETURNING id, number
      `;
      if (!task) return null;
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
      return task.id;
    }) as Promise<string | null>;
  },

  // ── settings ──
  async getSettings(): Promise<SettingsRow> {
    const [row] = await sql<SettingsRow[]>`
      SELECT s.paused, s.paused_reason, s.daily_limit_cents, s.daily_run_limit, s.max_concurrent_runs, s.updated_at,
        (u.usage->>'runs')::int AS runs_today,
        (u.usage->>'cost_cents')::int AS cost_today_cents
      FROM hq.settings s, (SELECT hq.today_usage() AS usage) u
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
