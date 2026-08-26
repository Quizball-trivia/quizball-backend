import { z } from 'zod';
import { leaderboardOffsetSchema } from '../../http/schemas/shared.js';

export const footballGridLeaderboardQuerySchema = z.object({
  scope: z.enum(['global', 'country']).optional().default('global'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: leaderboardOffsetSchema,
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
