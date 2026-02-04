import { z } from 'zod';

export const headToHeadQuerySchema = z.object({
  userA: z.string().uuid(),
  userB: z.string().uuid(),
});

export type HeadToHeadQuery = z.infer<typeof headToHeadQuerySchema>;

export const headToHeadResponseSchema = z.object({
  userAId: z.string().uuid(),
  userBId: z.string().uuid(),
  winsA: z.number().int(),
  winsB: z.number().int(),
  draws: z.number().int(),
  total: z.number().int(),
  lastPlayedAt: z.string().datetime().nullable(),
});

export type HeadToHeadResponse = z.infer<typeof headToHeadResponseSchema>;
