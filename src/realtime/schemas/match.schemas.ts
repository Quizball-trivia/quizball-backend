import { z } from 'zod';
import { QUESTION_TIME_MS } from '../match-flow.js';
import { CLUES_QUESTION_TIME_MS, COUNTDOWN_QUESTION_TIME_MS } from '../possession-state.js';

// Allow slight buffer over question time for network latency
const MAX_TIME_MS = Math.max(QUESTION_TIME_MS, COUNTDOWN_QUESTION_TIME_MS, CLUES_QUESTION_TIME_MS) + 1000;

export const matchAnswerSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(999),
  selectedIndex: z.number().int().min(0).max(3).nullable(),
  timeMs: z.number().int().min(0).max(MAX_TIME_MS),
});

export const matchCountdownGuessSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(999),
  guess: z.string().trim().min(1).max(120),
});

export const matchPutInOrderAnswerSchema = z.object({
  matchId: z.string().uuid(),
  qIndex: z.number().int().min(0).max(999),
  orderedItemIds: z.array(z.string().min(1).max(120)).min(3).max(12)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      { message: 'orderedItemIds must not contain duplicates' },
    ),
  timeMs: z.number().int().min(0).max(MAX_TIME_MS),
});

export const matchCluesAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('guess'),
    matchId: z.string().uuid(),
    qIndex: z.number().int().min(0).max(999),
    guess: z.string().trim().min(1).max(120),
    timeMs: z.number().int().min(0).max(MAX_TIME_MS),
  }),
  z.object({
    kind: z.literal('giveUp'),
    matchId: z.string().uuid(),
    qIndex: z.number().int().min(0).max(999),
    giveUp: z.literal(true),
    timeMs: z.number().int().min(0).max(MAX_TIME_MS),
  }),
]);

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

export const matchPlayAgainSchema = z.object({
  matchId: z.string().uuid(),
});

export type MatchAnswerPayload = z.infer<typeof matchAnswerSchema>;
export type MatchCountdownGuessPayload = z.infer<typeof matchCountdownGuessSchema>;
export type MatchPutInOrderAnswerPayload = z.infer<typeof matchPutInOrderAnswerSchema>;
export type MatchCluesAnswerPayload = z.infer<typeof matchCluesAnswerSchema>;
export type MatchHalftimeBanPayload = z.infer<typeof matchHalftimeBanSchema>;
export type MatchChanceCardUsePayload = z.infer<typeof matchChanceCardUseSchema>;
export type MatchRejoinPayload = z.infer<typeof matchRejoinSchema>;
export type MatchLeavePayload = z.infer<typeof matchLeaveSchema>;
export type MatchForfeitPayload = z.infer<typeof matchForfeitSchema>;
export type MatchFinalResultsAckPayload = z.infer<typeof matchFinalResultsAckSchema>;
export type MatchPlayAgainPayload = z.infer<typeof matchPlayAgainSchema>;
