import { z } from 'zod';
import { boardQueryFields } from '../leaderboards/board-filter.js';
import { nextTargetSchema } from '../leaderboards/board-response.js';

export const auctionLeaderboardQuerySchema = z.object({
  ...boardQueryFields,
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).max(10_000).optional().default(0),
});

export type AuctionLeaderboardQuery = z.infer<typeof auctionLeaderboardQuerySchema>;

export const auctionUserRankQuerySchema = auctionLeaderboardQuerySchema.pick({
  scope: true,
  country: true,
  club: true,
});

export type AuctionUserRankQuery = z.infer<typeof auctionUserRankQuerySchema>;

export const auctionLeaderboardEntryResponseSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  avatarCustomization: z.unknown().nullable(),
  auctionPoints: z.number().int().nonnegative(),
  country: z.string().nullable(),
  tier: z.string().nullable(),
  rank: z.number().int().positive(),
});

export const auctionLeaderboardResponseSchema = z.object({
  entries: z.array(auctionLeaderboardEntryResponseSchema),
});

export const auctionUserRankResponseSchema = auctionLeaderboardEntryResponseSchema.extend({
  total: z.number().int().nonnegative(),
  nextTarget: nextTargetSchema,
}).nullable();
