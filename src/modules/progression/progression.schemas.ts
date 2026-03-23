import { z } from 'zod';

export const xpEventSourceTypeEnum = z.enum([
  'daily_challenge_completion',
  'match_result',
]);

export const progressionResponseSchema = z.object({
  level: z.number().int().positive(),
  totalXp: z.number().int().nonnegative(),
  currentLevelXp: z.number().int().nonnegative(),
  xpForNextLevel: z.number().int().positive(),
  progressPct: z.number().int().min(0).max(100),
});

export type XpEventSourceType = z.infer<typeof xpEventSourceTypeEnum>;
export type ProgressionResponse = z.infer<typeof progressionResponseSchema>;
