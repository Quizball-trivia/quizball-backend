import { z } from 'zod';

export const footballGridLeaderboardQuerySchema = z.object({
  scope: z.enum(['global', 'country']).optional().default('global'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export type FootballGridLeaderboardQuery = z.infer<typeof footballGridLeaderboardQuerySchema>;

export const footballGridUserRankQuerySchema = footballGridLeaderboardQuerySchema.pick({
  scope: true,
});

export type FootballGridUserRankQuery = z.infer<typeof footballGridUserRankQuerySchema>;

export const footballGridLeaderboardEntryResponseSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  avatarCustomization: z.unknown().nullable(),
  ticTacToePoints: z.number().int().nonnegative(),
  country: z.string().nullable(),
  tier: z.string().nullable(),
  rank: z.number().int().positive(),
});

export const footballGridLeaderboardResponseSchema = z.object({
  entries: z.array(footballGridLeaderboardEntryResponseSchema),
});

export const footballGridUserRankResponseSchema = footballGridLeaderboardEntryResponseSchema.extend({
  total: z.number().int().nonnegative(),
}).nullable();
