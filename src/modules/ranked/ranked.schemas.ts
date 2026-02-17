import { z } from 'zod';

export const rankedTierSchema = z.enum([
  'Academy',
  'Youth Prospect',
  'Reserve',
  'Bench',
  'Rotation',
  'Starting11',
  'Key Player',
  'Captain',
  'World-Class',
  'Legend',
  'GOAT',
]);

export const placementStatusSchema = z.enum(['unplaced', 'in_progress', 'placed']);

export const rankedProfileResponseSchema = z.object({
  rp: z.number().int().nonnegative(),
  tier: rankedTierSchema,
  placementStatus: placementStatusSchema,
  placementPlayed: z.number().int().nonnegative(),
  placementRequired: z.number().int().nonnegative(),
  placementWins: z.number().int().nonnegative(),
  currentWinStreak: z.number().int().nonnegative(),
  lastRankedMatchAt: z.string().datetime().nullable(),
});

export type RankedProfileResponse = z.infer<typeof rankedProfileResponseSchema>;
