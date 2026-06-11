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

/**
 * Admin: leaderboard reset request. `confirm` must be true so the destructive
 * action can't be triggered by an empty/accidental POST.
 */
export const leaderboardResetBodySchema = z.object({
  confirm: z.literal(true),
  notes: z.string().max(500).optional(),
});

export type LeaderboardResetBody = z.infer<typeof leaderboardResetBodySchema>;

export const leaderboardResetResponseSchema = z.object({
  batchId: z.string().uuid(),
  profilesReset: z.number().int().nonnegative(),
  profilesArchived: z.number().int().nonnegative(),
  rpChangesArchived: z.number().int().nonnegative(),
});

export type LeaderboardResetResponse = z.infer<typeof leaderboardResetResponseSchema>;
