import { z } from 'zod';

export const draftBanSchema = z.object({
  categoryId: z.string().uuid(),
});

export const draftRejoinSchema = z.object({
  lobbyId: z.string().uuid().optional(),
}).optional();

export const draftUiReadySchema = z.object({
  lobbyId: z.string().uuid().optional(),
  turnUserId: z.string().min(1).optional(),
  banCount: z.number().int().min(0).max(2).optional(),
}).optional();

export type DraftBanPayload = z.infer<typeof draftBanSchema>;
export type DraftRejoinPayload = z.infer<typeof draftRejoinSchema>;
export type DraftUiReadyPayload = z.infer<typeof draftUiReadySchema>;
