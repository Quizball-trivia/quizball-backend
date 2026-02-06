import { z } from 'zod';
import { QUESTION_TIME_MS } from '../match-flow.js';

// Allow slight buffer over question time for network latency
const MAX_TIME_MS = QUESTION_TIME_MS + 1000;

export const matchAnswerSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(9),
  selectedIndex: z.number().int().min(0).max(3).nullable(),
  timeMs: z.number().int().min(0).max(MAX_TIME_MS),
});

export const matchRejoinSchema = z.object({
  matchId: z.string().uuid().optional(),
});

export type MatchAnswerPayload = z.infer<typeof matchAnswerSchema>;
export type MatchRejoinPayload = z.infer<typeof matchRejoinSchema>;
