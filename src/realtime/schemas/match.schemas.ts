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

export const matchHalftimeBanSchema = z.object({
  matchId: z.string().uuid(),
  categoryId: z.string().uuid(),
});

export const matchChanceCardUseSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(999),
  clientActionId: z.string().min(8).max(120),
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
export type MatchHalftimeBanPayload = z.infer<typeof matchHalftimeBanSchema>;
export type MatchChanceCardUsePayload = z.infer<typeof matchChanceCardUseSchema>;
export type MatchRejoinPayload = z.infer<typeof matchRejoinSchema>;
export type MatchLeavePayload = z.infer<typeof matchLeaveSchema>;
export type MatchForfeitPayload = z.infer<typeof matchForfeitSchema>;
export type MatchFinalResultsAckPayload = z.infer<typeof matchFinalResultsAckSchema>;
