import { z } from 'zod';

export const matchAnswerSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(9),
  selectedIndex: z.number().int().min(0).max(3).nullable(),
  timeMs: z.number().int().min(0),
});

export type MatchAnswerPayload = z.infer<typeof matchAnswerSchema>;
