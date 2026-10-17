import { z } from 'zod';

export const standingsQuerySchema = z.object({
  mode: z.enum(['ranked', 'auction', 'ticTacToe']).optional().default('ranked'),
  kind: z.enum(['country', 'club']),
});

export type StandingsQuery = z.infer<typeof standingsQuerySchema>;

export const standingsResponseSchema = z.object({
  standings: z.array(z.object({
    key: z.string(),
    rank: z.number().int().positive(),
    players: z.number().int().positive(),
    score: z.number().int().nonnegative(),
    topPlayer: z.object({ username: z.string(), points: z.number().int() }).nullable(),
  })),
  viewer: z.object({
    mine: z.string(),
    slot: z.number().int().positive().nullable(),
    gap: z.number().int().positive().nullable(),
    points: z.number().int().nullable(),
  }).nullable(),
});
