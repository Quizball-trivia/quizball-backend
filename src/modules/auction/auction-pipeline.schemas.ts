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
