import { z } from 'zod';

export const devSkipToSchema = z.object({
  matchId: z.string().uuid(),
  target: z.enum(['halftime', 'last_attack', 'shot', 'penalties', 'second_half']),
});
