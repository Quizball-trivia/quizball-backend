import { z } from 'zod';

// ── Spawn a generation job (CMS → agents.jobs) ──
export const spawnJobBodySchema = z.object({
  type: z.enum(['mcq_generate', 'daily_challenge']).default('mcq_generate'),
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
  paused: z.boolean(),
});
