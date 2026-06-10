import { z } from 'zod';

export const draftBanSchema = z.object({
  categoryId: z.string().uuid(),
});

export const draftRejoinSchema = z.object({
  lobbyId: z.string().uuid().optional(),
}).optional();

export type DraftBanPayload = z.infer<typeof draftBanSchema>;
export type DraftRejoinPayload = z.infer<typeof draftRejoinSchema>;
