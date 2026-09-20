import { z } from 'zod';
import { FREE_KICKS_MAX_STAKE, FREE_KICKS_MIN_STAKE, OPEN_ORDER } from './free-kicks.constants.js';

const clientNonceSchema = z.string().min(1).max(64).optional();
const expectedVersionSchema = z.number().int().min(0);

export const startRoundSchema = z.object({
  stake: z.number().int().min(FREE_KICKS_MIN_STAKE).max(FREE_KICKS_MAX_STAKE),
  client_nonce: clientNonceSchema,
});
export type StartRoundRequest = z.infer<typeof startRoundSchema>;

export const dealQuestionSchema = z.object({
  expected_version: expectedVersionSchema,
});
export type DealQuestionRequest = z.infer<typeof dealQuestionSchema>;

export const answerQuestionSchema = z.object({
  question_id: z.string().uuid(),
  option_id: z.string().min(1).max(64),
  expected_version: expectedVersionSchema,
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionSchema>;

export const shootSchema = z.object({
  zone: z.enum(OPEN_ORDER),
  expected_version: expectedVersionSchema,
});
export type ShootRequest = z.infer<typeof shootSchema>;

export const nextAttackSchema = z.object({
  expected_version: expectedVersionSchema,
  client_nonce: clientNonceSchema,
});
export type NextAttackRequest = z.infer<typeof nextAttackSchema>;

export const cashoutSchema = z.object({
  expected_version: expectedVersionSchema,
});
export type CashoutRequest = z.infer<typeof cashoutSchema>;
