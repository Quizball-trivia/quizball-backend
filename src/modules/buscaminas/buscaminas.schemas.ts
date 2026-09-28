import { z } from 'zod';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// Content versions are content hashes: positive integers up to 2^32.
export const contentVersionSchema = z.number().int().min(1).max(2 ** 32);

export const startSchema = z.object({ day: daySchema, contentVersion: contentVersionSchema.optional() });
export type StartRequest = z.infer<typeof startSchema>;

/** Every move names the run and the version the client last saw; the server row decides. */
export const moveSchema = z.object({ runId: z.string().uuid(), version: z.number().int().min(0).max(2 ** 31 - 1) });
export type MoveRequest = z.infer<typeof moveSchema>;

export const tapSchema = moveSchema.extend({ cardId: z.string().min(1).max(64) });
export type TapRequest = z.infer<typeof tapSchema>;

export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;

export const boardParamsSchema = z.object({ day: daySchema });
export type BoardParams = z.infer<typeof boardParamsSchema>;
