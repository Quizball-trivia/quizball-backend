import { z } from 'zod';

export const rankedQueueJoinSchema = z
  .object({
    searchMode: z.enum(['human_first']).optional(),
    source: z.enum(['mode_select', 'play_again', 'retry', 'recovery', 'unknown']).optional(),
    reason: z.enum(['initial', 'retry', 'recovery_retry']).optional(),
    clientRequestId: z.string().trim().min(1).max(80).optional(),
  })
  .optional()
  .transform((data) => ({
    searchMode: data?.searchMode ?? 'human_first',
    source: data?.source ?? 'unknown',
    reason: data?.reason ?? 'initial',
    clientRequestId: data?.clientRequestId,
  }));

export type RankedQueueJoinPayload = z.infer<typeof rankedQueueJoinSchema>;
