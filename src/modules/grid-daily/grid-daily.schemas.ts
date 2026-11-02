import { z } from 'zod';
import { REPORT_MAX_LENGTH } from '../wordgame-reports/wordgame-reports.service.js';

/** A real calendar date: a malformed one is a 422, never a database error. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((day) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}, 'Expected a valid date');

export const contentVersionSchema = z.number().int().min(1).max(2 ** 32);

export const startSchema = z.object({ day: daySchema, contentVersion: contentVersionSchema.optional() });
export type StartRequest = z.infer<typeof startSchema>;

/** Every move names the run and the version the client last saw; the server row decides. */
export const moveSchema = z.object({ runId: z.string().uuid(), version: z.number().int().min(0).max(2 ** 31 - 1) });
export type MoveRequest = z.infer<typeof moveSchema>;

export const guessSchema = moveSchema.extend({
  day: daySchema,
  cellIndex: z.number().int().min(0).max(8),
  text: z.string().trim().min(1).max(160),
});
export type GuessRequest = z.infer<typeof guessSchema>;

/**
 * "Think this is right?": a refused name the player says fits the square. It is not a move: it names no run version,
 * spends nothing and never changes the run.
 */
export const reportSchema = z.object({
  day: daySchema,
  cellIndex: z.number().int().min(0).max(8),
  // What wordgame_reports keeps intact (REPORT_MAX_LENGTH); a longer text is refused rather than stored cut.
  text: z.string().trim().min(1).max(REPORT_MAX_LENGTH),
});
export type ReportRequest = z.infer<typeof reportSchema>;

export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;

export const reviewQuerySchema = z.object({ day: daySchema });
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;
