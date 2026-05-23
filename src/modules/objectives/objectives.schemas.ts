import { z } from 'zod';
import { i18nFieldSchema } from '../../http/schemas/shared.js';

export const objectivePeriodTypeSchema = z.enum(['daily', 'weekly']);

export const objectiveMetadataSchema = z.object({
  leadingCategoryId: z.string().uuid().optional(),
  leadingCategoryName: z.string().optional(),
  categoryProgress: z.record(z.string(), z.number().int().nonnegative()).optional(),
}).passthrough();

export const objectiveProgressResponseSchema = z.object({
  id: z.string(),
  periodType: objectivePeriodTypeSchema,
  title: i18nFieldSchema,
  description: i18nFieldSchema,
  icon: z.string(),
  progress: z.number().int().nonnegative(),
  target: z.number().int().positive(),
  completed: z.boolean(),
  rewarded: z.boolean(),
  completedAt: z.string().datetime().nullable(),
  rewardedAt: z.string().datetime().nullable(),
  rewardCoins: z.number().int().nonnegative(),
  rewardXp: z.number().int().nonnegative(),
  metadata: objectiveMetadataSchema.optional(),
});

export const objectivePeriodResponseSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  completedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  objectives: z.array(objectiveProgressResponseSchema),
});

export const objectivesResponseSchema = z.object({
  daily: objectivePeriodResponseSchema,
  weekly: objectivePeriodResponseSchema,
});

export type ObjectiveProgressResponse = z.infer<typeof objectiveProgressResponseSchema>;
export type ObjectivesResponse = z.infer<typeof objectivesResponseSchema>;
