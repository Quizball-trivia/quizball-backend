import { z } from 'zod';
import { QUESTION_TIME_MS } from '../match-flow.js';

// Allow slight buffer over question time for network latency
const MAX_TIME_MS = QUESTION_TIME_MS + 1000;

export const matchAnswerSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(999),
  selectedIndex: z.number().int().min(0).max(3).nullable(),
  timeMs: z.number().int().min(0).max(MAX_TIME_MS),
});

export const matchTacticSelectSchema = z.object({
  matchId: z.string().uuid(),
  tactic: z.enum(['press-high', 'play-safe', 'all-in']),
});

export const matchRejoinSchema = z.object({
  matchId: z.string().uuid().optional(),
});

export const matchLeaveSchema = z.object({
  matchId: z.string().uuid().optional(),
});

export const matchForfeitSchema = z.object({
  matchId: z.string().uuid().optional(),
});

export const matchFinalResultsAckSchema = z.object({
  matchId: z.string().uuid(),
  resultVersion: z.number().int().positive(),
});

export type MatchAnswerPayload = z.infer<typeof matchAnswerSchema>;
export type MatchTacticSelectPayload = z.infer<typeof matchTacticSelectSchema>;
export type MatchRejoinPayload = z.infer<typeof matchRejoinSchema>;
export type MatchLeavePayload = z.infer<typeof matchLeaveSchema>;
export type MatchForfeitPayload = z.infer<typeof matchForfeitSchema>;
export type MatchFinalResultsAckPayload = z.infer<typeof matchFinalResultsAckSchema>;
