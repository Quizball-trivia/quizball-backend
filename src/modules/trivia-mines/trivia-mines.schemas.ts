import { z } from 'zod';
import { BOARD_SIZE, TRIVIA_MINES_MAX_STAKE, TRIVIA_MINES_MIN_STAKE } from './trivia-mines.constants.js';

const clientNonceSchema = z.string().min(1).max(64).optional();
const expectedVersionSchema = z.number().int().min(0);

export const startRoundSchema = z.object({
  stake: z.number().int().min(TRIVIA_MINES_MIN_STAKE).max(TRIVIA_MINES_MAX_STAKE),
  client_nonce: clientNonceSchema,
});
export type StartRoundRequest = z.infer<typeof startRoundSchema>;

export const pickSchema = z.object({
  tile: z.number().int().min(0).max(BOARD_SIZE - 1),
  expected_version: expectedVersionSchema,
});
export type PickRequest = z.infer<typeof pickSchema>;

export const dealQuestionSchema = z.object({ expected_version: expectedVersionSchema });
export type DealQuestionRequest = z.infer<typeof dealQuestionSchema>;

export const answerQuestionSchema = z.object({
  question_id: z.string().uuid(),
  option_id: z.string().min(1).max(64),
  expected_version: expectedVersionSchema,
});
export type AnswerQuestionRequest = z.infer<typeof answerQuestionSchema>;

export const cashoutSchema = z.object({ expected_version: expectedVersionSchema });
export type CashoutRequest = z.infer<typeof cashoutSchema>;
