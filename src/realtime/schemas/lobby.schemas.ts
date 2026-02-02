import { z } from 'zod';

export const lobbyCreateSchema = z.object({
  mode: z.enum(['friendly', 'ranked']),
});

export const lobbyJoinByCodeSchema = z.object({
  inviteCode: z.string().min(3).max(12),
});

export const lobbyReadySchema = z.object({
  ready: z.boolean(),
});

export type LobbyCreatePayload = z.infer<typeof lobbyCreateSchema>;
export type LobbyJoinByCodePayload = z.infer<typeof lobbyJoinByCodeSchema>;
export type LobbyReadyPayload = z.infer<typeof lobbyReadySchema>;
