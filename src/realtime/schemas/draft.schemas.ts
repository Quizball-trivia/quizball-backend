import { z } from 'zod';

export const draftBanSchema = z.object({
  categoryId: z.string().uuid(),
  // New clients echo the room id from draft:start. Optional keeps older mobile
  // clients compatible; the server has a DB fallback for cross-replica sockets.
  lobbyId: z.string().uuid().optional(),
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
