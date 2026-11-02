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
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TOOL_GROUPS = ['web', 'metrics', 'feedback'] as const;
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
  status: memberEditable.status.optional(),
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
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const updateTaskBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.number().int().min(0).max(3).optional(),
    assigneeId: uuid.nullable().optional(),
    position: z.number().finite().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;

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

// ── Settings / inbox ──
export const updateSettingsBodySchema = z
  .object({
    paused: z.boolean().optional(),
    pausedReason: z.string().trim().max(500).nullable().optional(),
    dailyLimitCents: z.number().int().min(0).max(1_000_000).optional(),
    dailyRunLimit: z.number().int().min(0).max(10_000).optional(),
    maxConcurrentRuns: z.number().int().min(1).max(10).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'provide at least one field' });
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
  maxTurns: number;
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
  updatedAt: string;
  today: { runs: number; costCents: number };
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
}
