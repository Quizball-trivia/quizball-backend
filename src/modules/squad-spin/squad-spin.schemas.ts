import { z } from 'zod';
import { SQUAD_SPIN_MAX_STAKE, SQUAD_SPIN_MIN_STAKE } from './squad-spin.constants.js';

const expectedVersionSchema = z.number().int().min(0);

export const startRoundSchema = z.object({
  stake: z.number().int().min(SQUAD_SPIN_MIN_STAKE).max(SQUAD_SPIN_MAX_STAKE),
  reels: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  client_nonce: z.string().min(1).max(64).optional(),
});
export type StartRoundRequest = z.infer<typeof startRoundSchema>;

// Every mutation names its round: versions restart at 0 per round, so a delayed
// retry from an earlier run must never land on the next one.
export const answerSchema = z.object({
  round_id: z.string().uuid(),
  text: z.string().min(1).max(160),
  expected_version: expectedVersionSchema,
});
export type AnswerRequest = z.infer<typeof answerSchema>;

export const decisionSchema = z.object({ round_id: z.string().uuid(), expected_version: expectedVersionSchema });
export type DecisionRequest = z.infer<typeof decisionSchema>;
