import { z } from 'zod';

// ── Spawn a generation job (CMS → agents.jobs) ──
export const spawnJobBodySchema = z.object({
  type: z.enum(['mcq_generate', 'daily_challenge']).default('mcq_generate'),
  questionType: z
    .enum(['mcq_single', 'true_false', 'clue_chain', 'put_in_order', 'countdown_list', 'career_path'])
    .default('mcq_single'),
  categoryId: z.string().uuid(),
  topic: z.string().min(3).max(500),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  count: z.number().int().min(1).max(500),
  budgetCents: z.number().int().positive().nullable().optional(),
});
export type SpawnJobBody = z.infer<typeof spawnJobBodySchema>;

export const jobIdParamSchema = z.object({ jobId: z.string().uuid() });
export type JobIdParam = z.infer<typeof jobIdParamSchema>;

export const taskIdParamSchema = z.object({ taskId: z.string().uuid() });
export type TaskIdParam = z.infer<typeof taskIdParamSchema>;

export const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>;

export const setBudgetBodySchema = z.object({
  limitCents: z.number().int().positive().optional(),
  paused: z.boolean().optional(),
});
export type SetBudgetBody = z.infer<typeof setBudgetBodySchema>;

// ── Response shapes (camelCase to the CMS) ──
export const agentJobSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  params: z.unknown(),
  counts: z.unknown(),
  requestedBy: z.string().nullable(),
  budgetCents: z.number().nullable(),
  spentCents: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AgentJob = z.infer<typeof agentJobSchema>;

export const agentTaskSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  seq: z.number().nullable(),
  status: z.string(),
  stage: z.string().nullable(),
  questionDraft: z.unknown(),
  verdicts: z.unknown(),
  warnings: z.unknown(),
  decision: z.string().nullable(),
  rejectReason: z.string().nullable(),
  publishedQuestionId: z.string().nullable(),
  attempt: z.number(),
  error: z.string().nullable(),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const agentEventSchema = z.object({
  id: z.number(),
  taskId: z.string().nullable(),
  ts: z.string(),
  level: z.string(),
  type: z.string(),
  message: z.string().nullable(),
});

export const budgetStatusSchema = z.object({
  limitCents: z.number(),
  spentTodayCents: z.number(),
  spentWeekCents: z.number(),
  spentMonthCents: z.number(),
  monthlyCreditCents: z.number(),
  paused: z.boolean(),
});

// ── Editable sub-agent prompts (agents.prompts) ──
export const promptRoleSchema = z.enum(['generator', 'factcheck', 'criteria', 'dedupe']);
export type PromptRole = z.infer<typeof promptRoleSchema>;

export const promptRoleParamSchema = z.object({ role: promptRoleSchema });
export type PromptRoleParam = z.infer<typeof promptRoleParamSchema>;

export const promptIdParamSchema = z.object({ promptId: z.string().uuid() });
export type PromptIdParam = z.infer<typeof promptIdParamSchema>;

// Optional question-type selector on the prompt endpoints. When omitted the
// endpoints operate on the (role, '*') defaults.
export const promptTypeQuerySchema = z.object({
  type: z.string().min(1).optional(),
});
export type PromptTypeQuery = z.infer<typeof promptTypeQuerySchema>;

export const savePromptBodySchema = z.object({
  content: z.string().min(20),
  note: z.string().max(500).optional(),
  type: z.string().min(1).optional(),
});
export type SavePromptBody = z.infer<typeof savePromptBodySchema>;

// Response shapes (camelCase to the CMS)
export const activePromptSchema = z.object({
  role: z.string(),
  type: z.string(),
  content: z.string(),
  version: z.number(),
  note: z.string().nullable(),
  updatedAt: z.string(),
});
export type ActivePrompt = z.infer<typeof activePromptSchema>;

export const promptVersionSchema = z.object({
  id: z.string(),
  version: z.number(),
  content: z.string(),
  note: z.string().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});
export type PromptVersion = z.infer<typeof promptVersionSchema>;

// ── Question types (agents.question_types) ──
export const questionTypeParamSchema = z.object({ type: z.string().min(1) });
export type QuestionTypeParam = z.infer<typeof questionTypeParamSchema>;

export const updateQuestionTypeBodySchema = z.object({
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});
export type UpdateQuestionTypeBody = z.infer<typeof updateQuestionTypeBodySchema>;

// Response shape (camelCase to the CMS)
export const questionTypeSchema = z.object({
  type: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  sortOrder: z.number(),
});
export type QuestionType = z.infer<typeof questionTypeSchema>;

// ── Schedules (agents.schedules) ──
export const scheduleIdParamSchema = z.object({ id: z.string().min(1) });
export type ScheduleIdParam = z.infer<typeof scheduleIdParamSchema>;

export const updateScheduleBodySchema = z.object({
  enabled: z.boolean().optional(),
  hourTbilisi: z.number().int().min(0).max(23).optional(),
  // params template (count/difficulty/questionType/categoryId/topic/rotation)
  params: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>;

// Response shape (camelCase to the CMS)
export const agentScheduleSchema = z.object({
  id: z.string(),
  label: z.string(),
  jobType: z.string(),
  enabled: z.boolean(),
  hourTbilisi: z.number(),
  params: z.unknown(),
  lastRunAt: z.string().nullable(),
  lastJobId: z.string().nullable(),
  lastStatus: z.string().nullable(),
});
export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
