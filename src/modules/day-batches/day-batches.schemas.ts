import { z } from 'zod';
import { DAILY_GAMES } from './day-batches.games.js';

export const dailyGameSchema = z.enum(DAILY_GAMES);

export const listDayBatchesQuerySchema = z.object({
  game: dailyGameSchema.optional(),
  status: z.enum(['pending', 'seeded', 'rejected', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListDayBatchesQuery = z.infer<typeof listDayBatchesQuerySchema>;

export const dayBatchIdParamSchema = z.object({ batchId: z.string().uuid() });
export type DayBatchIdParam = z.infer<typeof dayBatchIdParamSchema>;

export const rejectDayBatchBodySchema = z.object({ reason: z.string().trim().min(3).max(500) });
export type RejectDayBatchBody = z.infer<typeof rejectDayBatchBodySchema>;

export const spawnDayBatchBodySchema = z.object({
  game: dailyGameSchema,
  days: z.number().int().min(1).max(60),
});
export type SpawnDayBatchBody = z.infer<typeof spawnDayBatchBodySchema>;

export const dailyGameParamSchema = z.object({ game: dailyGameSchema });
export type DailyGameParam = z.infer<typeof dailyGameParamSchema>;

export const dayBatchHoldBodySchema = z.object({ hold: z.boolean() });
export type DayBatchHoldBody = z.infer<typeof dayBatchHoldBodySchema>;
