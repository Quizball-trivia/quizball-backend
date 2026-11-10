import { z } from 'zod';

// QuizBall HQ — admin API for the shared people + agents task board.
// Contract: CMS `src/types/hq.ts` mirrors the response shapes below.

export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'needs_approval',
  'blocked',
  'done',
  'cancelled',
  // An agent's idea waiting for the CEO; never claimed until accepted (→ todo).
  'proposed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses a human may set through PATCH (proposals go through accept/decline). */
export const HUMAN_TASK_STATUSES = TASK_STATUSES.filter((s) => s !== 'proposed') as [
  Exclude<TaskStatus, 'proposed'>,
  ...Exclude<TaskStatus, 'proposed'>[],
];

export const TASK_KINDS = ['task', 'standup', 'proposal', 'chat', 'brief'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** Boards and lists hide standup reports unless asked for explicitly. */
export const DEFAULT_TASK_KINDS: TaskKind[] = ['task', 'proposal'];

export const GOAL_HORIZONS = ['north_star', 'week', 'day'] as const;
export type GoalHorizon = (typeof GOAL_HORIZONS)[number];
export const GOAL_METRICS = ['new_users', 'active_players', 'matches', 'd7_retention', 'avg_rating'] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const GOAL_STATUSES = ['active', 'achieved', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const PROPOSAL_EFFORTS = ['s', 'm', 'l'] as const;

export const TOOL_GROUPS = ['web', 'metrics', 'feedback', 'answer_gaps', 'content_fixer', 'content_verify', 'isolated'] as const;

// Fixed company structure. Keep in sync with the CHECK constraint in
// supabase/migrations/20261102180000_hq_departments.sql and the CMS copy.
export const DEPARTMENTS = [
  { key: 'leadership', name: 'Leadership', emoji: '🧭' },
  { key: 'growth', name: 'Growth', emoji: '📈' },
  { key: 'content', name: 'Content', emoji: '✍️' },
  { key: 'competitions', name: 'Competitions', emoji: '🏆' },
  { key: 'engineering', name: 'Engineering', emoji: '🛠️' },
  { key: 'partners', name: 'Partners', emoji: '🤝' },
] as const;
export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key) as [DepartmentKey, ...DepartmentKey[]];
export type DepartmentKey = (typeof DEPARTMENTS)[number]['key'];
export const MEMBER_STATUSES = ['active', 'paused', 'archived'] as const;
export const AUTONOMY_LEVELS = ['autonomous', 'approval'] as const;

const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'slug must be lowercase letters, digits and dashes (2–41 chars)');
const boolish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

// ── Params ──
export const idParamSchema = z.object({ id: uuid });
export type IdParam = z.infer<typeof idParamSchema>;

// ── Members ──
export const listMembersQuerySchema = z.object({
  includeArchived: boolish.optional().default(false),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;

const memberEditable = {
  name: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80),
  avatar: z.string().trim().min(1).max(16),
  color: z.string().trim().min(1).max(24),
  description: z.string().max(2000),
  instructions: z.string().max(20000),
  model: z.string().trim().min(1).max(100).nullable(),
  tools: z.array(z.enum(TOOL_GROUPS)).max(TOOL_GROUPS.length),
  autonomy: z.enum(AUTONOMY_LEVELS),
  maxTurns: z.number().int().min(1).max(100),
  status: z.enum(MEMBER_STATUSES),
  department: z.enum(DEPARTMENT_KEYS),
  /** 'act' agents change things (code, posts, money): only a person can start their work. */
  tier: z.enum(['read', 'act']),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  dailyRunLimit: z.number().int().min(1).max(500).nullable(),
  maxRunCents: z.number().int().min(10).max(10000).nullable(),
};

export const createMemberBodySchema = z.object({
  slug,
  name: memberEditable.name,
  title: memberEditable.title.optional(),
  avatar: memberEditable.avatar.optional(),
  color: memberEditable.color.optional(),
  description: memberEditable.description.optional(),
  instructions: z.string().trim().min(1).max(20000),
  model: memberEditable.model.optional(),
  tools: memberEditable.tools.optional(),
  autonomy: memberEditable.autonomy.optional(),
  maxTurns: memberEditable.maxTurns.optional(),
  tier: memberEditable.tier.optional(),
  effort: memberEditable.effort.optional(),
  dailyRunLimit: memberEditable.dailyRunLimit.optional(),
  maxRunCents: memberEditable.maxRunCents.optional(),
  status: memberEditable.status.optional(),
  department: memberEditable.department.optional(),
});
export type CreateMemberBody = z.infer<typeof createMemberBodySchema>;

export const updateMemberBodySchema = z
  .object({
    name: memberEditable.name.optional(),
    title: memberEditable.title.optional(),
    avatar: memberEditable.avatar.optional(),
    color: memberEditable.color.optional(),
    description: memberEditable.description.optional(),
    instructions: memberEditable.instructions.optional(),
    model: memberEditable.model.optional(),
    tools: memberEditable.tools.optional(),
    autonomy: memberEditable.autonomy.optional(),
    maxTurns: memberEditable.maxTurns.optional(),
    status: memberEditable.status.optional(),
    department: memberEditable.department.optional(),
    tier: memberEditable.tier.optional(),
    effort: memberEditable.effort.optional(),
    dailyRunLimit: memberEditable.dailyRunLimit.optional(),
    maxRunCents: memberEditable.maxRunCents.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>;

// ── Tasks ──
export const listTasksQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(TASK_STATUSES)).optional()),
  assigneeId: uuid.optional(),
  // Matches the assignee's department (unassigned tasks have none).
  department: z.enum(DEPARTMENT_KEYS).optional(),
  // Comma-separated kinds; default task,proposal (standup reports hidden).
  kind: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(TASK_KINDS)).optional()),
  goalId: uuid.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const createTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20000).optional(),
  assigneeId: uuid.nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  status: z.enum(['backlog', 'todo']).optional(),
  parentId: uuid.nullable().optional(),
  goalId: uuid.nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const updateTaskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20000).optional(),
    // 'proposed' is not settable by humans (422).
    status: z.enum(HUMAN_TASK_STATUSES).optional(),
    priority: z.number().int().min(0).max(3).optional(),
    assigneeId: uuid.nullable().optional(),
    goalId: uuid.nullable().optional(),
    position: z.number().finite().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;

const proposalSchema = z.object({
  why: z.string().trim().max(2000),
  plan: z.string().trim().max(5000),
  expectedImpact: z.string().trim().max(1000),
  effort: z.enum(PROPOSAL_EFFORTS),
});
export type ProposalDetails = z.infer<typeof proposalSchema>;

export const acceptProposalBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20000).optional(),
    // Merged over the stored proposal.
    proposal: proposalSchema.partial().optional(),
  })
  .default({});
export type AcceptProposalBody = z.infer<typeof acceptProposalBodySchema>;

export const declineProposalBodySchema = z.object({ note: z.string().trim().min(1).max(5000).optional() }).default({});
export type DeclineProposalBody = z.infer<typeof declineProposalBodySchema>;

// ── Goals ──
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(
  (v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
  'invalid date'
);

export const listGoalsQuerySchema = z.object({
  // Default: active goals only.
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : ['active']))
    .pipe(z.array(z.enum(GOAL_STATUSES)).min(1)),
  horizon: z.enum(GOAL_HORIZONS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Cursor for history pages (any non-active status): the `nextCursor` of the previous page.
  before: uuid.optional(),
});
export type ListGoalsQuery = z.infer<typeof listGoalsQuerySchema>;

const goalFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
  metric: z.enum(GOAL_METRICS).nullable(),
  target: z.number().positive().max(1e9).nullable(),
  manualProgress: z.number().int().min(0).max(100).nullable(),
  periodStart: isoDate,
  periodEnd: isoDate,
  status: z.enum(GOAL_STATUSES),
  department: z.enum(DEPARTMENT_KEYS).nullable(),
  position: z.number().finite(),
};

export const createGoalBodySchema = z
  .object({
    horizon: z.enum(GOAL_HORIZONS),
    title: goalFields.title,
    description: goalFields.description.optional(),
    metric: goalFields.metric.optional(),
    target: goalFields.target.optional(),
    manualProgress: goalFields.manualProgress.optional(),
    // Default by horizon: day = today, week = this Mon–Sun, north_star = today → +90 days.
    periodStart: goalFields.periodStart.optional(),
    periodEnd: goalFields.periodEnd.optional(),
    status: goalFields.status.optional(),
    department: goalFields.department.optional(),
    position: goalFields.position.optional(),
  })
  .refine((b) => !b.metric || (b.target !== undefined && b.target !== null), {
    message: 'a metric goal needs a target',
    path: ['target'],
  });
export type CreateGoalBody = z.infer<typeof createGoalBodySchema>;

export const updateGoalBodySchema = z
  .object({
    horizon: z.enum(GOAL_HORIZONS).optional(),
    title: goalFields.title.optional(),
    description: goalFields.description.optional(),
    metric: goalFields.metric.optional(),
    target: goalFields.target.optional(),
    manualProgress: goalFields.manualProgress.optional(),
    periodStart: goalFields.periodStart.optional(),
    periodEnd: goalFields.periodEnd.optional(),
    status: goalFields.status.optional(),
    department: goalFields.department.optional(),
    position: goalFields.position.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateGoalBody = z.infer<typeof updateGoalBodySchema>;

// ── Standup / analytics ──
export const standupQuerySchema = z.object({ date: isoDate.optional() });
export type StandupQuery = z.infer<typeof standupQuerySchema>;

export const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export const approveTaskBodySchema = z.object({ note: z.string().trim().max(5000).optional() }).default({});
export type ApproveTaskBody = z.infer<typeof approveTaskBodySchema>;

export const rejectTaskBodySchema = z.object({ note: z.string().trim().min(1).max(5000) });
export type RejectTaskBody = z.infer<typeof rejectTaskBodySchema>;

export const createMessageBodySchema = z.object({
  body: z.string().trim().min(1).max(20000),
  recipientId: uuid.nullable().optional(),
});
export type CreateMessageBody = z.infer<typeof createMessageBodySchema>;

// ── Runs / events ──
export const listRunsQuerySchema = z.object({
  memberId: uuid.optional(),
  taskId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

export const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
  memberId: uuid.optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

// ── Schedules ──
export const createScheduleBodySchema = z.object({
  memberId: uuid,
  name: z.string().trim().min(1).max(120),
  cron: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64).optional(),
  taskTitle: z.string().trim().min(1).max(200),
  taskBody: z.string().max(20000).optional(),
  enabled: z.boolean().optional(),
});
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>;

export const updateScheduleBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    taskTitle: z.string().trim().min(1).max(200).optional(),
    taskBody: z.string().max(20000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;

// ── Pulse ──
export const pulseQuerySchema = z.object({
  // ≥ 8 so the 7-day average (the 7 full days before today) is always in range.
  days: z.coerce.number().int().min(8).max(90).default(14),
});
export type PulseQuery = z.infer<typeof pulseQuerySchema>;

// ── Settings / inbox ──
export const updateSettingsBodySchema = z
  .object({
    paused: z.boolean().optional(),
    pausedReason: z.string().trim().max(500).nullable().optional(),
    dailyLimitCents: z.number().int().min(0).max(1_000_000).optional(),
    dailyRunLimit: z.number().int().min(0).max(10_000).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
    planSoftPct: z.number().int().min(1).max(100).optional(),
    planHardPct: z.number().int().min(1).max(100).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' })
  .refine((b) => b.planSoftPct === undefined || b.planHardPct === undefined || b.planSoftPct <= b.planHardPct, {
    message: 'the urgent-only share must not be above the stop share',
    path: ['planSoftPct'],
  });
export type UpdateSettingsBody = z.infer<typeof updateSettingsBodySchema>;

export const markInboxReadBodySchema = z
  .object({ ids: z.array(z.number().int().positive()).max(500).optional() })
  .default({});
export type MarkInboxReadBody = z.infer<typeof markInboxReadBodySchema>;

// ── Response shapes (camelCase) ──
export interface MemberRef {
  id: string;
  slug: string;
  name: string;
  avatar: string;
  color: string;
  kind: 'human' | 'agent';
}

export interface Member extends MemberRef {
  userId: string | null;
  title: string;
  description: string;
  instructions: string;
  model: string | null;
  tools: string[];
  autonomy: 'autonomous' | 'approval';
  runtime: 'hq' | 'question_agents' | 'bug_triage' | 'none';
  status: 'active' | 'paused' | 'archived';
  department: DepartmentKey;
  maxTurns: number;
  tier: 'read' | 'act';
  role: 'agent' | 'director' | 'advisor';
  effort: string | null;
  dailyRunLimit: number | null;
  maxRunCents: number | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
  stats: {
    openTasks: number;
    runsToday: number;
    costTodayCents: number;
    currentTask: { id: string; number: number; title: string } | null;
    lastRun: { id: string; status: string; startedAt: string; endedAt: string | null } | null;
  };
}

export interface Task {
  id: string;
  number: number;
  title: string;
  body: string;
  status: TaskStatus;
  priority: number;
  assignee: MemberRef | null;
  createdBy: MemberRef | null;
  parentId: string | null;
  depth: number;
  scheduleId: string | null;
  result: string | null;
  position: number;
  attempts: number;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  kind: TaskKind;
  goalId: string | null;
  proposal: ProposalDetails | null;
  /** A person approved this (needed before an 'act' agent's task can run). */
  founderApprovedAt: string | null;
  director: {
    decision: 'approved' | 'declined' | 'escalated' | null;
    note: string | null;
    decidedAt: string | null;
    /** Waiting for the founder (the director can't act on it). */
    escalatedAt: string | null;
    review: 'accepted' | 'reopened' | null;
    reviewNote: string | null;
    reviewedAt: string | null;
    reopenCount: number;
  };
}

export interface Message {
  id: number;
  taskId: string | null;
  author: MemberRef | null;
  recipient: MemberRef | null;
  kind: 'comment' | 'handoff' | 'system' | 'result';
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface Run {
  id: string;
  member: MemberRef;
  taskId: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  model: string | null;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costCents: number;
  summary: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface RunDetail extends Run {
  log: { ts: string; tool: string; input: unknown; ok: boolean }[];
  sdkSessionId: string | null;
}

export interface TaskDetail extends Task {
  messages: Message[];
  runs: Run[];
  children: Task[];
  parent: Task | null;
}

export interface Schedule {
  id: string;
  member: MemberRef;
  name: string;
  cron: string;
  timezone: string;
  taskTitle: string;
  taskBody: string;
  /** 'standup' schedules create the agent's daily standup task. */
  taskKind: 'task' | 'standup';
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HqEvent {
  id: number;
  ts: string;
  type: string;
  level: 'info' | 'warn' | 'error';
  member: MemberRef | null;
  taskId: string | null;
  taskNumber: number | null;
  runId: string | null;
  message: string;
  data: unknown;
}

export interface Settings {
  paused: boolean;
  pausedReason: string | null;
  dailyLimitCents: number;
  dailyRunLimit: number;
  maxConcurrentRuns: number;
  /** Share of the Claude plan HQ may use: urgent-only from planSoftPct, stop at planHardPct. */
  planSoftPct: number;
  planHardPct: number;
  updatedAt: string;
  today: { runs: number; costCents: number };
  plan: PlanStatus;
}

export interface PlanWindowStatus {
  key: string;
  label: string;
  /** 0-100, null when the plan didn't say. */
  usedPct: number | null;
  resetsAt: string | null;
  status: string;
}

export interface PlanStatus {
  /** ok · auth (login/key rejected) · limit (waiting for a reset). */
  state: 'ok' | 'auth' | 'limit';
  until: string | null;
  /**
   * What the worker does now, from the same rules as its gate: normal, only
   * urgent work (incl. the Director's chat) from planSoftPct, nothing from
   * planHardPct or an open incident until `until`.
   */
  mode: 'normal' | 'urgent_only' | 'blocked';
  /** Current windows only (a window whose reset already passed is dropped). */
  windows: PlanWindowStatus[];
}

export type ExternalStats =
  | { kind: 'question_agents'; jobs7d: number; accepted7d: number; rejected7d: number; failed7d: number }
  | { kind: 'bug_triage'; reports7d: number; prsOpened7d: number; needsInfo7d: number };

export interface MemberDetail extends Member {
  recentRuns: Run[];
  openTasks: Task[];
  recentTasks: Task[];
  schedules: Schedule[];
  external: ExternalStats | null;
}

export interface Department {
  key: DepartmentKey;
  name: string;
  emoji: string;
  members: MemberRef[];
  counts: { open: number; todo: number; inProgress: number; needsApproval: number; blocked: number; doneToday: number };
  lastResult: Task | null;
  working: { member: MemberRef; task: { id: string; number: number; title: string } }[];
}

export interface PulseDay {
  newUsers: number;
  matches: number;
  activePlayers: number;
}

export interface Pulse {
  generatedAt: string;
  timezone: string;
  days: number;
  totals: { registeredUsers: number };
  series: ({ date: string } & PulseDay)[];
  today: PulseDay;
  yesterday: PulseDay;
  /** Mean of the 7 full days before today. */
  avg7d: PulseDay;
  feedback: {
    count7d: number;
    avgRating7d: number | null;
    lowRatings7d: number;
    countPrev7d: number;
    avgRatingPrev7d: number | null;
  };
}

export interface GoalPage {
  items: Goal[];
  /** Pass as `before` to get the next (older) page; null when there is none or for active-only lists. */
  nextCursor: string | null;
}

export interface GoalProgress {
  /** Measured value (metric goals) — null for manual goals or before the period starts. */
  current: number | null;
  /** 0–100; manual goals report manualProgress. */
  pct: number | null;
}

export interface Goal {
  id: string;
  horizon: GoalHorizon;
  title: string;
  description: string;
  metric: GoalMetric | null;
  target: number | null;
  manualProgress: number | null;
  periodStart: string;
  periodEnd: string;
  status: GoalStatus;
  department: DepartmentKey | null;
  position: number;
  progress: GoalProgress;
  createdAt: string;
  updatedAt: string;
}

export interface StandupEntry {
  member: MemberRef & { title: string; department: DepartmentKey };
  standup: { headline: string; yesterday: string; today: string; blockers: string; createdAt: string } | null;
  proposals: Task[];
  working: { id: string; number: number; title: string } | null;
  finishedYesterday: Task[];
}

/** `today` = the standup date, `yesterday` = the day before; null when out of the data window. */
export interface KpiPair {
  today: number | null;
  yesterday: number | null;
}

export interface Standup {
  date: string;
  goals: { northStar: Goal | null; week: Goal[]; day: Goal[] };
  entries: StandupEntry[];
  waitingOn: MemberRef[];
  proposals: Task[];
  kpis: {
    newUsers: KpiPair;
    activePlayers: KpiPair;
    matches: KpiPair;
    /** 7-day average ending on the standup date vs the 7 days before it. */
    rating: { current: number | null; previous: number | null; lowRatings7d: number | null };
  };
}

export interface AnalyticsDay {
  date: string;
  newUsers: number;
  activePlayers: number;
  matches: number;
}

export interface Analytics {
  generatedAt: string;
  days: number;
  series: AnalyticsDay[];
  actives: { dau: number; wau: number; mau: number };
  totals: { registeredUsers: number };
  modes: { mode: string; matches: number; share: number }[];
  modesByDay: ({ date: string } & Record<string, number | string>)[];
  modeLabels: Record<string, string>;
  countries: { country: string; players: number; registered: number }[];
  /** Sums over every country, before the top-30 cut. */
  countriesTotalPlayers: number;
  countriesTotalRegistered: number;
  retention: { cohortStart: string; size: number; d1: number | null; d7: number | null; d30: number | null }[];
}

export type PosthogAnalytics =
  | { connected: false }
  | { connected: true; error: string }
  | {
      connected: true;
      visitorsByDay: { date: string; visitors: number; pageviews: number }[];
      topCountries: { country: string; visitors: number }[];
      topReferrers: { source: string; visitors: number }[];
      topPages: { path: string; views: number }[];
      funnel: { visitors: number; signups?: number; firstMatch?: number };
    };

export interface Overview {
  settings: Settings;
  today: { runs: number; costCents: number; tasksCreated: number; tasksDone: number; failedRuns: number };
  countsByStatus: Record<TaskStatus, number>;
  needsApproval: Task[];
  blocked: Task[];
  inProgress: Task[];
  recentResults: Task[];
  runningRuns: Run[];
  team: Member[];
  latestBriefing: Task | null;
  inboxUnread: number;
  departments: Department[];
}

// ── Director ──
export const directorChatQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DirectorChatQuery = z.infer<typeof directorChatQuerySchema>;

export const directorChatBodySchema = z.object({ body: z.string().trim().min(1).max(8000) });
export type DirectorChatBody = z.infer<typeof directorChatBodySchema>;

export interface DirectorSummary {
  director: Member | null;
  brief: { taskId: string; taskNumber: number; result: string; completedAt: string | null } | null;
  needsYou: Task[];
  /** Today's plan items (proposals he put up this morning) with their status. */
  plan: Task[];
  /** What every agent is working on right now. */
  runningNow: Task[];
  decisions: HqEvent[];
  chat: { queued: boolean; running: boolean };
}

export interface DirectorChatPage {
  items: Message[];
  chat: { queued: boolean; running: boolean };
}
