import { z } from 'zod';
import { UL_ANSWER_MAX_LENGTH } from './ultimo.constants.js';

/** A real calendar date: a malformed one is a 422, never a database error. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((day) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}, 'Expected a valid date');

// Content versions are content hashes: positive integers up to 2^32.
export const contentVersionSchema = z.number().int().min(1).max(2 ** 32);

export const startSchema = z.object({ day: daySchema, contentVersion: contentVersionSchema.optional() });
export type StartRequest = z.infer<typeof startSchema>;

/** Every move names the run and the version the client last saw; the server row decides. */
export const moveSchema = z.object({ runId: z.string().uuid(), version: z.number().int().min(0).max(2 ** 31 - 1) });
export type MoveRequest = z.infer<typeof moveSchema>;

export const answerSchema = moveSchema.extend({
  answer: z.string().max(UL_ANSWER_MAX_LENGTH).regex(/[\p{L}\p{N}]/u, 'An answer needs a letter or a digit'),
});
export type AnswerRequest = z.infer<typeof answerSchema>;

export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;

export const reviewQuerySchema = z.object({ day: daySchema });
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;
