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
    gameMode: z.enum(['friendly', 'ranked_sim']),
    friendlyRandom: z.boolean().optional(),
    friendlyCategoryAId: z.string().uuid().nullable().optional(),
    friendlyCategoryBId: z.string().uuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.gameMode !== 'friendly') return;

    if (data.friendlyRandom === false) {
      if (!data.friendlyCategoryAId || !data.friendlyCategoryBId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Friendly mode requires two categories when random is disabled',
          path: ['friendlyCategoryAId'],
        });
        return;
      }
      if (data.friendlyCategoryAId === data.friendlyCategoryBId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Selected categories must be different',
          path: ['friendlyCategoryBId'],
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
