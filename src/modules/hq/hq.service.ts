import { CronExpressionParser } from 'cron-parser';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  hqRepo,
  type EventRow,
  type MemberRefRow,
  type MemberRow,
  type MemberStatsRow,
  type MessageRow,
  type NewEvent,
  type RunRow,
  type ScheduleRow,
  type SettingsRow,
  type TaskColumn,
  type TaskRow,
} from './hq.repo.js';
import {
  TASK_STATUSES,
  type ApproveTaskBody,
  type CreateMemberBody,
  type CreateMessageBody,
  type CreateScheduleBody,
  type CreateTaskBody,
  type ExternalStats,
  type HqEvent,
  type ListEventsQuery,
  type ListRunsQuery,
  type ListTasksQuery,
  type Member,
  type MemberDetail,
  type MemberRef,
  type Message,
  type Overview,
  type RejectTaskBody,
  type Run,
  type RunDetail,
  type Schedule,
  type Settings,
  type Task,
  type TaskDetail,
  type TaskStatus,
  type UpdateMemberBody,
  type UpdateScheduleBody,
  type UpdateSettingsBody,
  type UpdateTaskBody,
} from './hq.schemas.js';

// QuizBall HQ service: people + AI agents on one task board. The HQ worker
// (quizball-question-agents, pm2 `hq-worker`) executes tasks assigned to HQ
// agents; this layer is what the CMS uses to see and steer that work.

const TERMINAL: TaskStatus[] = ['done', 'cancelled'];
// Where a human may move a task an HQ agent is currently working on. Moving it
// back to todo/backlog would let the worker re-claim it while the first run is
// still going; these end the run instead (the worker's finish then no-ops
// because the claim token is cleared).
const FROM_AGENT_RUN: TaskStatus[] = ['cancelled', 'blocked', 'done'];
// Any human status change or reassignment releases the worker's claim.
const RELEASE_CLAIM = { claimed_by: null, claimed_at: null, claim_token: null } as const;
const LEAD_SLUG_FOR_BRIEFING = 'ops-reporter';

// ── mappers ──
function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
const isoReq = (v: Date | string): string => iso(v) as string;
const num = (v: number | string): number => Number(v);

function toRef(r: MemberRefRow): MemberRef;
function toRef(r: MemberRefRow | null): MemberRef | null;
function toRef(r: MemberRefRow | null): MemberRef | null {
  if (!r) return null;
  return { id: r.id, slug: r.slug, name: r.name, avatar: r.avatar, color: r.color, kind: r.kind };
}

function toMember(r: MemberStatsRow): Member {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    avatar: r.avatar,
    color: r.color,
    kind: r.kind,
    userId: r.user_id,
    title: r.title,
    description: r.description,
    instructions: r.instructions,
    model: r.model,
    tools: r.tools ?? [],
    autonomy: r.autonomy,
    runtime: r.runtime,
    status: r.status,
    maxTurns: r.max_turns,
    lastActiveAt: iso(r.last_active_at),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    stats: {
      openTasks: r.open_tasks ?? 0,
      runsToday: r.runs_today ?? 0,
      costTodayCents: r.cost_today_cents ?? 0,
      currentTask: r.current_task
        ? { id: r.current_task.id, number: num(r.current_task.number), title: r.current_task.title }
        : null,
      lastRun: r.last_run
        ? {
            id: r.last_run.id,
            status: r.last_run.status,
            startedAt: isoReq(r.last_run.startedAt),
            endedAt: iso(r.last_run.endedAt),
          }
        : null,
    },
  };
}

function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    number: num(r.number),
    title: r.title,
    body: r.body,
    status: r.status,
    priority: r.priority,
    assignee: toRef(r.assignee),
    createdBy: toRef(r.created_by),
    parentId: r.parent_id,
    depth: r.depth,
    scheduleId: r.schedule_id,
    result: r.result,
    position: Number(r.position),
    attempts: r.attempts,
    dueAt: iso(r.due_at),
    completedAt: iso(r.completed_at),
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
    messageCount: r.message_count ?? 0,
  };
}

function toMessage(r: MessageRow): Message {
  return {
    id: num(r.id),
    taskId: r.task_id,
    author: toRef(r.author),
    recipient: toRef(r.recipient),
    kind: r.kind,
    body: r.body,
    readAt: iso(r.read_at),
    createdAt: isoReq(r.created_at),
  };
}

function toRun(r: RunRow): Run {
  const startedAt = isoReq(r.started_at);
  const endedAt = iso(r.ended_at);
  return {
    id: r.id,
    member: toRef(r.member),
    taskId: r.task_id,
    taskNumber: r.task_number === null ? null : num(r.task_number),
    taskTitle: r.task_title,
    status: r.status,
    model: r.model,
    turns: r.turns,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costCents: r.cost_cents ?? 0,
    summary: r.summary,
    error: r.error,
    startedAt,
    endedAt,
    durationSeconds: endedAt ? Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000)) : null,
  };
}

function toRunDetail(r: RunRow): RunDetail {
  return {
    ...toRun(r),
    log: Array.isArray(r.log) ? (r.log as RunDetail['log']) : [],
    sdkSessionId: r.sdk_session_id,
  };
}

function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    member: toRef(r.member),
    name: r.name,
    cron: r.cron,
    timezone: r.timezone,
    taskTitle: r.task_title,
    taskBody: r.task_body,
    enabled: r.enabled,
    nextRunAt: iso(r.next_run_at),
    lastRunAt: iso(r.last_run_at),
    lastTaskId: r.last_task_id,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

function toEvent(r: EventRow): HqEvent {
  return {
    id: num(r.id),
    ts: isoReq(r.ts),
    type: r.type,
    level: r.level,
    member: toRef(r.member),
    taskId: r.task_id,
    taskNumber: r.task_number === null ? null : num(r.task_number),
    runId: r.run_id,
    message: r.message,
    data: r.data ?? {},
  };
}

function toSettings(r: SettingsRow): Settings {
  return {
    paused: r.paused,
    pausedReason: r.paused_reason,
    dailyLimitCents: r.daily_limit_cents,
    dailyRunLimit: r.daily_run_limit,
    maxConcurrentRuns: r.max_concurrent_runs,
    updatedAt: isoReq(r.updated_at),
    today: { runs: r.runs_today ?? 0, costCents: r.cost_today_cents ?? 0 },
  };
}

// ── validation helpers ──
export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new ValidationError(`Unknown timezone "${timezone}"`, { field: 'timezone' });
  }
}

/** 5-field cron only (minute hour day-of-month month day-of-week). */
export function assertValidCron(cron: string, timezone: string): void {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValidationError('Cron must have exactly 5 fields: minute hour day-of-month month day-of-week', {
      field: 'cron',
    });
  }
  try {
    CronExpressionParser.parse(fields.join(' '), { tz: timezone }).next();
  } catch (err) {
    throw new ValidationError(`Invalid cron "${cron}": ${err instanceof Error ? err.message : String(err)}`, {
      field: 'cron',
    });
  }
}

const isHqAgent = (m: Pick<MemberRow, 'kind' | 'runtime'> | undefined | null) =>
  !!m && m.kind === 'agent' && m.runtime === 'hq';

async function logEvent(e: NewEvent): Promise<void> {
  try {
    await hqRepo.insertEvent(e);
  } catch (err) {
    // The feed is best-effort; never fail the user's action because of it.
    logger.warn({ err, type: e.type }, 'hq: failed to write event');
  }
}

async function requireTask(id: string): Promise<TaskRow> {
  const row = await hqRepo.getTask(id);
  if (!row) throw new NotFoundError('Task not found');
  return row;
}

async function loadTask(id: string): Promise<Task> {
  return toTask(await requireTask(id));
}

async function requireAssignableMember(id: string): Promise<MemberRow> {
  const m = await hqRepo.getMember(id);
  if (!m) throw new NotFoundError('Assignee not found');
  if (m.status === 'archived') throw new BadRequestError('Cannot assign work to an archived member');
  return m;
}

const label = (t: Pick<TaskRow, 'number' | 'title'>) => `HQ-${num(t.number)} "${t.title}"`;

/** Schedules only make sense for agents the HQ worker runs. */
function assertSchedulableMember(m: MemberRow | undefined): asserts m is MemberRow {
  if (!m || m.kind !== 'agent' || m.runtime !== 'hq' || m.status === 'archived') {
    throw new ValidationError('Schedules can only run HQ agents', { field: 'memberId' });
  }
}

export const hqService = {
  /** The hq.members row for the signed-in CMS user (created on first use). */
  async actingMember(userId: string | null | undefined): Promise<MemberRow> {
    if (!userId) throw new AuthenticationError('Authentication required');
    const existing = await hqRepo.getMemberByUserId(userId);
    if (existing) return existing;
    const created = await hqRepo.ensureHumanForUser(userId);
    if (!created) throw new NotFoundError('User not found');
    return created;
  },

  // ── overview ──
  async overview(userId: string | null | undefined): Promise<Overview> {
    const me = await this.actingMember(userId);
    const [settings, today, counts, needsApproval, blocked, inProgress, recent, running, team, briefing, unread] =
      await Promise.all([
        hqRepo.getSettings(),
        hqRepo.todayStats(),
        hqRepo.countsByStatus(),
        hqRepo.listTasks({ statuses: ['needs_approval'], limit: 50 }),
        hqRepo.listTasks({ statuses: ['blocked'], limit: 50 }),
        hqRepo.listTasks({ statuses: ['in_progress'], limit: 50 }),
        hqRepo.listRecentlyDone(24, 10),
        hqRepo.listRunningRuns(),
        hqRepo.listMembers(false),
        hqRepo.latestDoneTaskFor(LEAD_SLUG_FOR_BRIEFING),
        hqRepo.countUnread(me.id),
      ]);
    const countsByStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const c of counts) {
      if ((TASK_STATUSES as readonly string[]).includes(c.status)) countsByStatus[c.status as TaskStatus] = c.count;
    }
    return {
      settings: toSettings(settings),
      today: {
        runs: today.runs,
        costCents: today.cost_cents,
        tasksCreated: today.tasks_created,
        tasksDone: today.tasks_done,
        failedRuns: today.failed_runs,
      },
      countsByStatus,
      needsApproval: needsApproval.map(toTask),
      blocked: blocked.map(toTask),
      inProgress: inProgress.map(toTask),
      recentResults: recent.map(toTask),
      runningRuns: running.map(toRun),
      team: team.map(toMember),
      latestBriefing: briefing ? toTask(briefing) : null,
      inboxUnread: unread,
    };
  },

  // ── members ──
  async listMembers(includeArchived: boolean): Promise<{ items: Member[] }> {
    return { items: (await hqRepo.listMembers(includeArchived)).map(toMember) };
  },

  async getMember(id: string): Promise<MemberDetail> {
    const row = await hqRepo.getMemberWithStats(id);
    if (!row) throw new NotFoundError('Member not found');
    const [runs, open, recent, schedules, external] = await Promise.all([
      hqRepo.listRuns({ memberId: id, limit: 20 }),
      hqRepo.listMemberTasks(id, true, 50),
      hqRepo.listMemberTasks(id, false, 20),
      hqRepo.listSchedules(id),
      this.externalStats(row.runtime),
    ]);
    return {
      ...toMember(row),
      recentRuns: runs.map(toRun),
      openTasks: open.map(toTask),
      recentTasks: recent.map(toTask),
      schedules: schedules.map(toSchedule),
      external,
    };
  },

  async externalStats(runtime: MemberRow['runtime']): Promise<ExternalStats | null> {
    try {
      if (runtime === 'question_agents') {
        const s = await hqRepo.questionAgentStats();
        return { kind: 'question_agents', jobs7d: s.jobs, accepted7d: s.accepted, rejected7d: s.rejected, failed7d: s.failed };
      }
      if (runtime === 'bug_triage') {
        const s = await hqRepo.bugTriageStats();
        return { kind: 'bug_triage', reports7d: s.reports, prsOpened7d: s.prs, needsInfo7d: s.needs_info };
      }
    } catch (err) {
      // The other pipelines' schemas don't exist in every environment.
      logger.debug({ err, runtime }, 'hq: external stats unavailable');
    }
    return null;
  },

  async createMember(body: CreateMemberBody, userId: string | null | undefined): Promise<Member> {
    const me = await this.actingMember(userId);
    const row = await hqRepo.insertAgent({
      slug: body.slug,
      name: body.name,
      title: body.title ?? '',
      avatar: body.avatar ?? '🤖',
      color: body.color ?? 'slate',
      description: body.description ?? '',
      instructions: body.instructions,
      model: body.model ?? null,
      tools: body.tools ?? [],
      autonomy: body.autonomy ?? 'autonomous',
      maxTurns: body.maxTurns ?? 25,
      status: body.status ?? 'active',
    });
    if (!row) throw new ConflictError(`A member with slug "${body.slug}" already exists`);
    await logEvent({
      type: 'member_updated',
      memberId: me.id,
      message: `${me.name} hired ${row.name}`,
      data: { action: 'created', targetMemberId: row.id },
    });
    const full = await hqRepo.getMemberWithStats(row.id);
    return toMember(full!);
  },

  async updateMember(id: string, body: UpdateMemberBody, userId: string | null | undefined): Promise<Member> {
    const me = await this.actingMember(userId);
    const existing = await hqRepo.getMember(id);
    if (!existing) throw new NotFoundError('Member not found');
    const updated = await hqRepo.updateMember(id, {
      name: body.name,
      title: body.title,
      avatar: body.avatar,
      color: body.color,
      description: body.description,
      instructions: body.instructions,
      model: body.model,
      tools: body.tools,
      autonomy: body.autonomy,
      max_turns: body.maxTurns,
      status: body.status,
    });
    if (!updated) throw new NotFoundError('Member not found');
    const changed = Object.keys(body);
    let message = `${me.name} updated ${updated.name} (${changed.join(', ')})`;
    if (body.status && body.status !== existing.status) {
      message =
        body.status === 'paused'
          ? `${me.name} paused ${updated.name}`
          : body.status === 'archived'
            ? `${me.name} archived ${updated.name}`
            : `${me.name} reactivated ${updated.name}`;
    }
    await logEvent({ type: 'member_updated', memberId: me.id, message, data: { targetMemberId: id, fields: changed } });
    const full = await hqRepo.getMemberWithStats(id);
    return toMember(full!);
  },

  async syncHumans(): Promise<{ items: Member[] }> {
    await hqRepo.syncHumans();
    return { items: (await hqRepo.listHumansWithStats()).map(toMember) };
  },

  // ── tasks ──
  async listTasks(q: ListTasksQuery): Promise<{ items: Task[] }> {
    const rows = await hqRepo.listTasks({ statuses: q.status, assigneeId: q.assigneeId, q: q.q, limit: q.limit });
    return { items: rows.map(toTask) };
  },

  async getTask(id: string): Promise<TaskDetail> {
    const row = await requireTask(id);
    const [messages, runs, children, parent] = await Promise.all([
      hqRepo.listTaskMessages(id),
      hqRepo.listRuns({ taskId: id, limit: 50 }),
      hqRepo.listChildren(id),
      row.parent_id ? hqRepo.getTask(row.parent_id) : Promise.resolve(undefined),
    ]);
    return {
      ...toTask(row),
      messages: messages.map(toMessage),
      runs: runs.map(toRun),
      children: children.map(toTask),
      parent: parent ? toTask(parent) : null,
    };
  },

  async createTask(body: CreateTaskBody, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const assignee = body.assigneeId ? await requireAssignableMember(body.assigneeId) : null;
    let depth = 0;
    if (body.parentId) {
      const parent = await hqRepo.getTask(body.parentId);
      if (!parent) throw new NotFoundError('Parent task not found');
      depth = Math.min(parent.depth + 1, 20);
    }
    const id = await hqRepo.insertTask({
      title: body.title,
      body: body.body ?? '',
      status: body.status ?? 'todo',
      priority: body.priority ?? 2,
      assigneeId: assignee?.id ?? null,
      createdById: me.id,
      parentId: body.parentId ?? null,
      depth,
      scheduleId: null,
      dueAt: body.dueAt ?? null,
    });
    const task = await requireTask(id);
    await logEvent({
      type: 'task_created',
      memberId: me.id,
      taskId: id,
      message: assignee
        ? `${me.name} created ${label(task)} for ${assignee.name}`
        : `${me.name} created ${label(task)}`,
      data: { assigneeId: assignee?.id ?? null, status: task.status, priority: task.priority },
    });
    return toTask(task);
  },

  async updateTask(id: string, body: UpdateTaskBody, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const task = await requireTask(id);

    let newAssignee: MemberRow | null | undefined; // undefined = unchanged
    if (body.assigneeId !== undefined) {
      newAssignee = body.assigneeId === null ? null : await requireAssignableMember(body.assigneeId);
    }
    const effectiveAssignee =
      newAssignee !== undefined
        ? newAssignee
        : task.assignee_id
          ? { kind: task.assignee?.kind ?? 'human', runtime: (task.assignee_runtime ?? 'none') as MemberRow['runtime'] }
          : null;

    const currentAssignee = task.assignee_id
      ? { kind: task.assignee?.kind ?? 'human', runtime: (task.assignee_runtime ?? 'none') as MemberRow['runtime'] }
      : null;
    const reassigned = newAssignee !== undefined && (newAssignee?.id ?? null) !== task.assignee_id;
    const statusChanged = body.status !== undefined && body.status !== task.status;

    if (task.status === 'in_progress') {
      // Reassigning work that's mid-flight needs an explicit new status.
      if (reassigned && !statusChanged) {
        throw new ConflictError('This task is in progress — choose a new status (e.g. To do) when reassigning it');
      }
      if (statusChanged && isHqAgent(currentAssignee) && !FROM_AGENT_RUN.includes(body.status!)) {
        throw new ConflictError('The agent is still working on this; cancel it or wait');
      }
    }
    if (body.status === 'in_progress' && task.status !== 'in_progress' && isHqAgent(effectiveAssignee)) {
      throw new ConflictError('Only the HQ worker can start a task assigned to an agent — use "Run now" instead');
    }

    const patch: Partial<Record<TaskColumn, unknown>> = {
      title: body.title,
      body: body.body,
      priority: body.priority,
      position: body.position,
      due_at: body.dueAt,
    };
    if (newAssignee !== undefined) patch.assignee_id = newAssignee?.id ?? null;

    if (statusChanged) {
      const next = body.status!;
      patch.status = next;
      patch.completed_at = TERMINAL.includes(next) ? new Date() : null;
    }
    if (statusChanged || reassigned) Object.assign(patch, RELEASE_CLAIM);

    // Guard against racing the worker: only apply if the status we read is
    // still current.
    const ok = await hqRepo.updateTask(id, patch, { statuses: [task.status], assigneeId: task.assignee_id });
    if (!ok) throw new ConflictError('Task changed while you were editing it — refresh and try again');

    const fresh = await requireTask(id);
    const parts: string[] = [];
    if (statusChanged) parts.push(`moved ${label(fresh)} to ${body.status}`);
    if (reassigned) {
      parts.push(newAssignee ? `assigned ${label(fresh)} to ${newAssignee.name}` : `unassigned ${label(fresh)}`);
    }
    if (parts.length === 0) parts.push(`edited ${label(fresh)}`);
    await logEvent({
      type: statusChanged ? 'task_status' : 'task_updated',
      memberId: me.id,
      taskId: id,
      message: `${me.name} ${parts.join(' and ')}`,
      data: { fields: Object.keys(body), from: task.status, to: fresh.status },
    });
    return toTask(fresh);
  },

  async approveTask(id: string, body: ApproveTaskBody, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const task = await requireTask(id);
    if (task.status !== 'needs_approval') {
      throw new ConflictError(`Only tasks waiting for approval can be approved (this one is ${task.status})`);
    }
    const ok = await hqRepo.transitionTask(
      id,
      { status: 'done', completed_at: new Date(), ...RELEASE_CLAIM },
      { statuses: ['needs_approval'], assigneeId: task.assignee_id },
      {
        message: body.note
          ? { taskId: id, authorId: me.id, recipientId: task.assignee_id, kind: 'comment', body: body.note }
          : undefined,
        event: {
          type: 'task_status',
          memberId: me.id,
          taskId: id,
          message: `${me.name} approved ${label(task)}`,
          data: { from: 'needs_approval', to: 'done', action: 'approve' },
        },
      }
    );
    if (!ok) throw new ConflictError('Task changed while you were reviewing it — refresh and try again');
    return loadTask(id);
  },

  async rejectTask(id: string, body: RejectTaskBody, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const task = await requireTask(id);
    const from: TaskStatus[] = ['needs_approval', 'done', 'blocked'];
    if (!from.includes(task.status)) {
      throw new ConflictError(`Only tasks that are waiting for approval, done or blocked can be sent back (this one is ${task.status})`);
    }
    const ok = await hqRepo.transitionTask(
      id,
      { status: 'todo', completed_at: null, ...RELEASE_CLAIM },
      { statuses: from, assigneeId: task.assignee_id },
      {
        message: { taskId: id, authorId: me.id, recipientId: task.assignee_id, kind: 'comment', body: body.note },
        event: {
          type: 'task_status',
          memberId: me.id,
          taskId: id,
          message: `${me.name} sent ${label(task)} back${task.assignee ? ` to ${task.assignee.name}` : ''}`,
          data: { from: task.status, to: 'todo', action: 'reject' },
        },
      }
    );
    if (!ok) throw new ConflictError('Task changed while you were reviewing it — refresh and try again');
    return loadTask(id);
  },

  async runTask(id: string, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const task = await requireTask(id);
    if (!task.assignee_id || task.assignee?.kind !== 'agent' || task.assignee_runtime !== 'hq') {
      throw new BadRequestError('Assign this task to an HQ agent before running it');
    }
    if (task.assignee_status !== 'active') {
      throw new BadRequestError(`${task.assignee.name} is ${task.assignee_status} — reactivate it to run tasks`);
    }
    if (task.status === 'in_progress') throw new ConflictError('This task is already running');
    const from = TASK_STATUSES.filter((s) => s !== 'in_progress');
    const ok = await hqRepo.transitionTask(
      id,
      { status: 'todo', completed_at: null, ...RELEASE_CLAIM },
      // the assignee check matters here: a concurrent reassignment must not
      // leave a human's task queued for the worker
      { statuses: [...from], assigneeId: task.assignee_id },
      {
        event: {
          type: 'task_status',
          memberId: me.id,
          taskId: id,
          message: `${me.name} queued ${label(task)} for ${task.assignee.name}`,
          data: { from: task.status, to: 'todo', action: 'run' },
        },
      }
    );
    if (!ok) throw new ConflictError('This task is already running');
    return loadTask(id);
  },

  async postMessage(taskId: string, body: CreateMessageBody, userId: string | null | undefined): Promise<Message> {
    const me = await this.actingMember(userId);
    const task = await requireTask(taskId);
    let recipient: MemberRow | null = null;
    if (body.recipientId) {
      recipient = (await hqRepo.getMember(body.recipientId)) ?? null;
      if (!recipient) throw new NotFoundError('Recipient not found');
    }
    const row = await hqRepo.insertMessage({
      taskId,
      authorId: me.id,
      recipientId: recipient?.id ?? null,
      kind: 'comment',
      body: body.body,
    });
    await logEvent({
      type: 'message',
      memberId: me.id,
      taskId,
      message: recipient
        ? `${me.name} messaged ${recipient.name} on ${label(task)}`
        : `${me.name} commented on ${label(task)}`,
      data: { messageId: num(row.id), recipientId: recipient?.id ?? null },
    });
    return toMessage(row);
  },

  // ── runs / events ──
  async listRuns(q: ListRunsQuery): Promise<{ items: Run[] }> {
    return { items: (await hqRepo.listRuns(q)).map(toRun) };
  },

  async getRun(id: string): Promise<RunDetail> {
    const row = await hqRepo.getRun(id);
    if (!row) throw new NotFoundError('Run not found');
    return toRunDetail(row);
  },

  async listEvents(q: ListEventsQuery): Promise<{ items: HqEvent[] }> {
    return { items: (await hqRepo.listEvents(q)).map(toEvent) };
  },

  // ── schedules ──
  async listSchedules(): Promise<{ items: Schedule[] }> {
    return { items: (await hqRepo.listSchedules()).map(toSchedule) };
  },

  async createSchedule(body: CreateScheduleBody, userId: string | null | undefined): Promise<Schedule> {
    const me = await this.actingMember(userId);
    const member = await hqRepo.getMember(body.memberId);
    assertSchedulableMember(member);
    const timezone = body.timezone ?? 'Asia/Tbilisi';
    assertValidTimezone(timezone);
    assertValidCron(body.cron, timezone);
    const id = await hqRepo.insertSchedule({
      memberId: member.id,
      name: body.name,
      cron: body.cron.trim().split(/\s+/).join(' '),
      timezone,
      taskTitle: body.taskTitle,
      taskBody: body.taskBody ?? '',
      enabled: body.enabled ?? true,
    });
    await logEvent({
      type: 'schedule_created',
      memberId: me.id,
      message: `${me.name} scheduled "${body.name}" for ${member.name} (${body.cron})`,
      data: { scheduleId: id, targetMemberId: member.id },
    });
    const row = await hqRepo.getSchedule(id);
    return toSchedule(row!);
  },

  async updateSchedule(id: string, body: UpdateScheduleBody, userId: string | null | undefined): Promise<Schedule> {
    const me = await this.actingMember(userId);
    const existing = await hqRepo.getSchedule(id);
    if (!existing) throw new NotFoundError('Schedule not found');
    const timezone = body.timezone ?? existing.timezone;
    const cron = body.cron !== undefined ? body.cron.trim().split(/\s+/).join(' ') : existing.cron;
    const timingChanged = body.cron !== undefined || body.timezone !== undefined;
    if (body.timezone !== undefined) assertValidTimezone(timezone);
    if (timingChanged) assertValidCron(cron, timezone);
    const ok = await hqRepo.updateSchedule(id, {
      name: body.name,
      cron: body.cron !== undefined ? cron : undefined,
      timezone: body.timezone,
      task_title: body.taskTitle,
      task_body: body.taskBody,
      enabled: body.enabled,
      ...(timingChanged ? { next_run_at: null } : {}),
    });
    if (!ok) throw new NotFoundError('Schedule not found');
    await logEvent({
      type: 'schedule_updated',
      memberId: me.id,
      message:
        body.enabled === false
          ? `${me.name} turned off "${existing.name}"`
          : body.enabled === true && !existing.enabled
            ? `${me.name} turned on "${existing.name}"`
            : `${me.name} edited schedule "${existing.name}"`,
      data: { scheduleId: id, fields: Object.keys(body) },
    });
    const row = await hqRepo.getSchedule(id);
    return toSchedule(row!);
  },

  async deleteSchedule(id: string, userId: string | null | undefined): Promise<void> {
    const me = await this.actingMember(userId);
    const existing = await hqRepo.getSchedule(id);
    if (!existing) throw new NotFoundError('Schedule not found');
    await hqRepo.deleteSchedule(id);
    await logEvent({
      type: 'schedule_deleted',
      memberId: me.id,
      message: `${me.name} deleted schedule "${existing.name}"`,
      data: { scheduleId: id },
    });
  },

  async runScheduleNow(id: string, userId: string | null | undefined): Promise<Task> {
    const me = await this.actingMember(userId);
    const schedule = await hqRepo.getSchedule(id);
    if (!schedule) throw new NotFoundError('Schedule not found');
    const assignee = await hqRepo.getMember(schedule.member_id);
    assertSchedulableMember(assignee);
    const taskId = await hqRepo.runScheduleNow({
      scheduleId: schedule.id,
      createdById: me.id,
      event: (t) => ({
        type: 'schedule_fired',
        memberId: me.id,
        message: `${me.name} ran "${schedule.name}" now → HQ-${num(t.number)} "${schedule.task_title}" for ${assignee.name}`,
        data: { scheduleId: schedule.id, manual: true },
      }),
    });
    if (!taskId) throw new NotFoundError('Schedule not found');
    return loadTask(taskId);
  },

  // ── settings ──
  async getSettings(): Promise<Settings> {
    return toSettings(await hqRepo.getSettings());
  },

  async updateSettings(body: UpdateSettingsBody, userId: string | null | undefined): Promise<Settings> {
    const me = await this.actingMember(userId);
    const before = await hqRepo.getSettings();
    await hqRepo.updateSettings(
      {
        paused: body.paused,
        paused_reason: body.paused === false ? null : body.pausedReason,
        daily_limit_cents: body.dailyLimitCents,
        daily_run_limit: body.dailyRunLimit,
        max_concurrent_runs: body.maxConcurrentRuns,
      },
      userId ?? null
    );
    const after = await hqRepo.getSettings();
    let message = `${me.name} updated HQ limits`;
    if (body.paused === true && !before.paused) {
      message = `${me.name} paused all HQ agents${body.pausedReason ? ` — ${body.pausedReason}` : ''}`;
    } else if (body.paused === false && before.paused) {
      message = `${me.name} resumed HQ agents`;
    }
    await logEvent({
      type: 'settings',
      level: body.paused === true && !before.paused ? 'warn' : 'info',
      memberId: me.id,
      message,
      data: { fields: Object.keys(body) },
    });
    return toSettings(after);
  },

  // ── inbox ──
  async inbox(userId: string | null | undefined): Promise<{ items: Message[] }> {
    const me = await this.actingMember(userId);
    return { items: (await hqRepo.listInbox(me.id)).map(toMessage) };
  },

  async markInboxRead(ids: number[] | undefined, userId: string | null | undefined): Promise<void> {
    const me = await this.actingMember(userId);
    await hqRepo.markRead(me.id, ids);
  },
};
