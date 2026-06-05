import { z } from 'zod';

export const devSkipToSchema = z.object({
  matchId: z.string().uuid(),
  target: z.enum(['halftime', 'last_attack', 'shot', 'penalties', 'penalty_ban', 'second_half']),
});

export const devQuickMatchSchema = z.object({
  skipTo: z.enum(['halftime', 'last_attack', 'shot', 'penalties', 'penalty_ban', 'second_half']).optional(),
});

export const devMatchIdSchema = z.object({
  matchId: z.string().uuid(),
});
