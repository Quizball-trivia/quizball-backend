import { z } from 'zod';

export const headToHeadQuerySchema = z.object({
  userA: z.string().uuid(),
  userB: z.string().uuid(),
}).refine(
  (data) => data.userA !== data.userB,
  {
    message: 'userA and userB must be different',
    path: ['userB'], // Point error to userB field
  }
);

export type HeadToHeadQuery = z.infer<typeof headToHeadQuerySchema>;

export const headToHeadResponseSchema = z.object({
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
  winsA: z.number().int(),
  winsB: z.number().int(),
  draws: z.number().int(),
  total: z.number().int(),
  lastPlayedAt: z.string().datetime().nullable(),
});

export type HeadToHeadResponse = z.infer<typeof headToHeadResponseSchema>;

export const recentMatchesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

export const recentMatchResultSchema = z.enum(['win', 'loss', 'draw']);

export const recentMatchResponseSchema = z.object({
  matchId: z.string().uuid(),
  mode: z.enum(['friendly', 'ranked']),
  status: z.enum(['completed', 'abandoned']),
  result: recentMatchResultSchema,
  endedAt: z.string().datetime().nullable(),
  playerScore: z.number().int().nonnegative(),
  opponentScore: z.number().int().nonnegative(),
  opponent: z.object({
    id: z.string().uuid().nullable(),
    username: z.string(),
    avatarUrl: z.string().url().nullable(),
    isAi: z.boolean(),
  }),
});

export const recentMatchesResponseSchema = z.object({
  items: z.array(recentMatchResponseSchema),
});

/**
 * Statistics summary for a specific game mode.
 * @property winRate - Win rate as a percentage (0-100), with up to 2 decimal places
 */
export const modeStatsSummarySchema = z.object({
  gamesPlayed: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
  winRate: z.number().nonnegative().max(100),
});

export const statsSummaryResponseSchema = z.object({
  overall: modeStatsSummarySchema,
  ranked: modeStatsSummarySchema,
  friendly: modeStatsSummarySchema,
});

export type RecentMatchesQuery = z.infer<typeof recentMatchesQuerySchema>;
export type RecentMatchResponse = z.infer<typeof recentMatchResponseSchema>;
export type RecentMatchesResponse = z.infer<typeof recentMatchesResponseSchema>;
export type ModeStatsSummary = z.infer<typeof modeStatsSummarySchema>;
export type StatsSummaryResponse = z.infer<typeof statsSummaryResponseSchema>;
