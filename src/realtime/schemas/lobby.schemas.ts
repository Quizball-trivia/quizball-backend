import { z } from 'zod';

export const lobbyCreateSchema = z.object({
  mode: z.enum(['friendly', 'ranked']),
  isPublic: z.boolean().optional(),
});

export const lobbyJoinByCodeSchema = z.object({
  inviteCode: z
    .string()
    .min(3)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/, 'Invite code must be alphanumeric'),
});

export const lobbyReadySchema = z.object({
  ready: z.boolean(),
});

export const lobbyUpdateSettingsSchema = z
  .object({
    lobbyId: z.string().uuid().optional(),
    gameMode: z.enum(['friendly_possession', 'friendly_party_quiz', 'ranked_sim']),
    friendlyRandom: z.boolean().optional(),
    friendlyCategoryAId: z.string().uuid().nullable().optional(),
    friendlyCategoryBId: z.string().uuid().nullable().optional(),
    isPublic: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.gameMode === 'ranked_sim') return;

    if (data.friendlyRandom === false) {
      if (!data.friendlyCategoryAId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A category is required when random is disabled',
          path: ['friendlyCategoryAId'],
        });
      }
    }
  });

export const lobbyStartSchema = z.object({
  lobbyId: z.string().uuid().optional(),
});

export type LobbyCreatePayload = z.infer<typeof lobbyCreateSchema>;
export type LobbyJoinByCodePayload = z.infer<typeof lobbyJoinByCodeSchema>;
export type LobbyReadyPayload = z.infer<typeof lobbyReadySchema>;
export type LobbyUpdateSettingsPayload = z.infer<typeof lobbyUpdateSettingsSchema>;
export type LobbyStartPayload = z.infer<typeof lobbyStartSchema>;
