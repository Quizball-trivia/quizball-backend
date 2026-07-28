import { z } from 'zod';

export const auctionLeaderboardQuerySchema = z.object({
  scope: z.enum(['global', 'country']).optional().default('global'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

export type AuctionLeaderboardQuery = z.infer<typeof auctionLeaderboardQuerySchema>;

export const auctionUserRankQuerySchema = auctionLeaderboardQuerySchema.pick({
  scope: true,
});

export type AuctionUserRankQuery = z.infer<typeof auctionUserRankQuerySchema>;

export const auctionLeaderboardEntryResponseSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
  avatarCustomization: z.unknown().nullable(),
  auctionPoints: z.number().int().nonnegative(),
  country: z.string().nullable(),
  rank: z.number().int().positive(),
});

export const auctionLeaderboardResponseSchema = z.object({
  entries: z.array(auctionLeaderboardEntryResponseSchema),
});

export const auctionUserRankResponseSchema = auctionLeaderboardEntryResponseSchema.extend({
  total: z.number().int().nonnegative(),
}).nullable();
