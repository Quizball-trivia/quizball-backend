import { z } from 'zod';

export const devSkipToSchema = z.object({
  matchId: z.string().uuid(),
  target: z.enum(['halftime', 'shot', 'penalties', 'second_half']),
});
