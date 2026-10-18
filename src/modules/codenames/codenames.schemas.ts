import { z } from 'zod';

/** A real calendar date: a malformed one is a 422, never a database error. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((day) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}, 'Expected a valid date');

const run = { runId: z.string().uuid(), version: z.number().int().min(0).max(2 ** 31 - 1) };
export const contentVersionSchema = z.number().int().min(1).max(2 ** 32);
export const startSchema = z.object({ day: daySchema, contentVersion: contentVersionSchema.optional() });
export type StartRequest = z.infer<typeof startSchema>;
export const flipSchema = z.object({ ...run, card: z.number().int().min(0).max(19) });
export type FlipRequest = z.infer<typeof flipSchema>;
export const stopSchema = z.object(run);
export type StopRequest = z.infer<typeof stopSchema>;
export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;
export const reviewQuerySchema = z.object({ day: daySchema });
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;
