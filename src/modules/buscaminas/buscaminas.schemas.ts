import { z } from 'zod';

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const tokenSchema = z.string().min(1).max(8192);

// Content versions are content hashes: positive integers up to 2^32.
export const contentVersionSchema = z.number().int().min(1).max(2 ** 32);

export const startSchema = z.object({ day: daySchema, contentVersion: contentVersionSchema.optional() });
export type StartRequest = z.infer<typeof startSchema>;

export const tapSchema = z.object({ token: tokenSchema, cardId: z.string().min(1).max(64) });
export type TapRequest = z.infer<typeof tapSchema>;

export const tokenBodySchema = z.object({ token: tokenSchema });
export type TokenBodyRequest = z.infer<typeof tokenBodySchema>;

export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;

export const boardParamsSchema = z.object({ day: daySchema });
export type BoardParams = z.infer<typeof boardParamsSchema>;
