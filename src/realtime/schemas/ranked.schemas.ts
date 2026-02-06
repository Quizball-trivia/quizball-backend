import { z } from 'zod';

export const rankedQueueJoinSchema = z
  .object({
    searchMode: z.enum(['human_first']).optional(),
  })
  .optional()
  .transform((data) => ({
    searchMode: data?.searchMode ?? 'human_first',
  }));

export type RankedQueueJoinPayload = z.infer<typeof rankedQueueJoinSchema>;
