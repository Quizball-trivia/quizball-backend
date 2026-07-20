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

export const rankedLeaderboardQuerySchema = z.object({
  scope: z.enum(['global', 'country']).optional().default('global'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  season: z.string().uuid().optional(),
});

export type RankedLeaderboardQuery = z.infer<typeof rankedLeaderboardQuerySchema>;

export const rankedUserRankQuerySchema = rankedLeaderboardQuerySchema.pick({
  scope: true,
  season: true,
});

export type RankedUserRankQuery = z.infer<typeof rankedUserRankQuerySchema>;

export const rankedLeaderboardEntryResponseSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  avatarCustomization: z.unknown().nullable(),
  rp: z.number().int().nonnegative(),
  tier: rankedTierSchema,
  country: z.string().nullable(),
  rank: z.number().int().positive(),
  trend: z.enum(['up', 'down', 'same']),
  trendValue: z.number().int().nonnegative(),
});

export const rankedLeaderboardResponseSchema = z.object({
  entries: z.array(rankedLeaderboardEntryResponseSchema),
});

export const rankedUserRankResponseSchema = rankedLeaderboardEntryResponseSchema.extend({
  total: z.number().int().nonnegative(),
}).nullable();

export const rankedSeasonsResponseSchema = z.object({
  seasons: z.array(z.object({
    id: z.string().uuid(),
    seasonNumber: z.number().int().positive(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
  })),
  currentSeasonNumber: z.number().int().positive(),
});

/**
 * Admin: leaderboard reset request. `confirm` must be true so the destructive
 * action can't be triggered by an empty/accidental POST.
 */
export const leaderboardResetBodySchema = z.object({
  confirm: z.literal(true),
  notes: z.string().max(500).optional(),
  seasonNumber: z.number().int().positive().optional(),
});

export type LeaderboardResetBody = z.infer<typeof leaderboardResetBodySchema>;

export const leaderboardResetResponseSchema = z.object({
  batchId: z.string().uuid(),
  profilesReset: z.number().int().nonnegative(),
  profilesArchived: z.number().int().nonnegative(),
  rpChangesArchived: z.number().int().nonnegative(),
});

export type LeaderboardResetResponse = z.infer<typeof leaderboardResetResponseSchema>;
