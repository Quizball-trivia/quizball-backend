import { z } from 'zod';

export const draftBanSchema = z.object({
  categoryId: z.string().uuid(),
});

export type DraftBanPayload = z.infer<typeof draftBanSchema>;
