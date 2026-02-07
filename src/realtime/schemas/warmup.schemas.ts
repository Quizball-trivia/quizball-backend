import { z } from 'zod';

export const warmupTapSchema = z.object({
  tapX: z.number().min(0).max(1),
  tapY: z.number().min(0).max(1),
  tapSeq: z.number().int().min(1),
});

export const warmupDroppedSchema = z.object({
  clientTs: z.number().int().min(0),
  y: z.number(),
});

export type WarmupTapInput = z.infer<typeof warmupTapSchema>;
export type WarmupDroppedInput = z.infer<typeof warmupDroppedSchema>;
