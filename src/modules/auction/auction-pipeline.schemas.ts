import '../../http/openapi/zod-init.js';
import { z } from 'zod';

export const auctionPipelineStageCountSchema = z.object({
  stage: z.string(),
  count: z.number().int(),
});

export const auctionPipelineVariantCountSchema = z.object({
  variant_key: z.string(),
  count: z.number().int(),
  published: z.number().int(),
});

export const auctionPipelineErrorClassSchema = z.object({
  error_class: z.string(),
  count: z.number().int(),
});

export const auctionPipelineFailureSampleSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  task_stage: z.string(),
  status: z.string(),
  error_class: z.string().nullable(),
  error_message: z.string().nullable(),
  external_call: z.string().nullable(),
  created_at: z.string(),
});

export const auctionPipelineSnapshotSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  status: z.string(),
  player_row_count: z.number().int(),
  valuation_row_count: z.number().int(),
  created_at: z.string(),
  promoted_at: z.string().nullable(),
});

export const auctionPipelineStatsResponseSchema = z.object({
  generated_at: z.string(),
  totals: z.object({
    total_tasks: z.number().int(),
    terminal_families: z.number().int(),
    published_families: z.number().int(),
    rejected_families: z.number().int(),
    failed_families: z.number().int(),
    pass_rate: z.number().nullable(),
    recent_pass_rates: z.array(
      z.object({
        hours: z.number().int(),
        published: z.number().int(),
        terminal: z.number().int(),
        pass_rate: z.number().nullable(),
      })
    ),
    eligible_players: z.number().int(),
    players_done: z.number().int(),
    players_remaining: z.number().int(),
    completion_rate: z.number().nullable(),
  }),
  stages: z.array(auctionPipelineStageCountSchema),
  variants: z.array(auctionPipelineVariantCountSchema),
  cards: z.object({
    published: z.number().int(),
    needs_review: z.number().int(),
    superseded: z.number().int(),
    rejected: z.number().int(),
    published_families: z.number().int(),
  }),
  attempts_24h: z.object({
    total: z.number().int(),
    success: z.number().int(),
    rejected: z.number().int(),
    failed: z.number().int(),
    by_error_class: z.array(auctionPipelineErrorClassSchema),
  }),
  recent_failures: z.array(auctionPipelineFailureSampleSchema),
  latest_snapshot: auctionPipelineSnapshotSchema.nullable(),
});

export type AuctionPipelineStatsResponse = z.infer<typeof auctionPipelineStatsResponseSchema>;

export const auctionPipelinePromptKeyEnum = z.enum([
  'generator_rules',
  'verifier_rules',
  'judge_rules',
  'variant_medium',
  'variant_hard',
]);

export const auctionPipelineWorkerSchema = z.object({
  worker_id: z.string(),
  hostname: z.string(),
  task_id: z.string().uuid().nullable(),
  player_name: z.string().nullable(),
  variant_key: z.string().nullable(),
  stage: z.string().nullable(),
  started_at: z.string(),
  updated_at: z.string(),
  seconds_since_heartbeat: z.number().int(),
  is_stale: z.boolean(),
});

export const auctionPipelineWorkersResponseSchema = z.object({
  workers: z.array(auctionPipelineWorkerSchema),
  live: z.number().int(),
  stale: z.number().int(),
});

export const auctionPipelinePromptModeEnum = z.enum(['append', 'replace']);

export const auctionPipelinePromptSchema = z.object({
  key: z.string(),
  text: z.string(),
  mode: auctionPipelinePromptModeEnum,
  updated_at: z.string(),
  updated_by: z.string().nullable(),
});

export const auctionPipelinePromptsResponseSchema = z.object({
  items: z.array(auctionPipelinePromptSchema),
  /** Read-only assembled prompt text published by the runner, keyed by prompt key. */
  effective: z.record(z.string(), auctionPipelinePromptSchema),
});

export const auctionPipelinePromptKeyParamSchema = z.object({
  key: auctionPipelinePromptKeyEnum,
});

export const auctionPipelinePromptUpdateSchema = z.object({
  text: z.string().trim().min(1).max(8000),
  mode: auctionPipelinePromptModeEnum.default('append'),
});

/**
 * Either an explicit set of task ids or a whole-class filter, never both and
 * never neither — an unqualified requeue would reset every terminal task.
 */
export const auctionPipelineRequeueSchema = z
  .object({
    taskIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    filter: z.enum(['failed', 'rejected']).optional(),
  })
  .refine(
    (value) => (value.taskIds === undefined) !== (value.filter === undefined),
    { message: 'Provide exactly one of taskIds or filter' }
  );

export const auctionPipelinePromptResetResponseSchema = z.object({
  reset: z.boolean(),
});

export const auctionPipelineRequeueResponseSchema = z.object({
  requeued: z.number().int(),
});

export type AuctionPipelinePromptUpdate = z.infer<typeof auctionPipelinePromptUpdateSchema>;
export type AuctionPipelineRequeueRequest = z.infer<typeof auctionPipelineRequeueSchema>;
export type AuctionPipelinePromptKeyParam = z.infer<typeof auctionPipelinePromptKeyParamSchema>;
