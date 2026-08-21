import { z } from 'zod';

const correlationIdSchema = z.string().min(1).max(128).optional();

export const lobbyCreateSchema = z.object({
  mode: z.enum(['friendly', 'ranked']),
  isPublic: z.boolean().optional(),
  correlationId: correlationIdSchema,
});

export const lobbyJoinByCodeSchema = z.object({
  inviteCode: z
    .string()
    .min(3)
    .max(12)
    .regex(/^[A-Za-z0-9]+$/, 'Invite code must be alphanumeric'),
  correlationId: correlationIdSchema,
});

export const lobbyLeaveSchema = z.object({
  correlationId: correlationIdSchema,
});

export const lobbyReadySchema = z.object({
  ready: z.boolean(),
});

export const lobbyUpdateSettingsSchema = z
  .object({
    lobbyId: z.string().uuid().optional(),
    gameMode: z.enum([
      'friendly_possession',
      'friendly_party_quiz',
      'football_grid',
      'auction',
      'ranked_sim',
    ]),
    friendlyRandom: z.boolean().optional(),
    friendlyCategoryAId: z.string().uuid().nullable().optional(),
    friendlyCategoryBId: z.string().uuid().nullable().optional(),
    isPublic: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    // Auction draws from published auction cards, not lobby categories.
    if (
      data.gameMode === 'ranked_sim'
      || data.gameMode === 'auction'
      || data.gameMode === 'football_grid'
    ) return;

    if (data.friendlyRandom === false) {
      if (!data.friendlyCategoryAId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'A category is required when random is disabled',
          path: ['friendlyCategoryAId'],
        });
      }
      // The optional second-half pick must be a DIFFERENT category — the whole
      // point is two distinct halves, and a duplicate would silently look like
      // a preset that changes nothing.
      if (
        data.friendlyCategoryBId
        && data.friendlyCategoryAId
        && data.friendlyCategoryBId === data.friendlyCategoryAId
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'The second-half category must differ from the first-half category',
          path: ['friendlyCategoryBId'],
        });
      }
    }
  });

export const lobbyStartSchema = z.object({
  lobbyId: z.string().uuid().optional(),
});

export const lobbyChallengeSchema = z.object({
  toUserId: z.string().uuid(),
  gameMode: z.enum(['friendly_possession', 'friendly_party_quiz', 'football_grid']).optional(),
});

export const lobbyChallengeDecisionSchema = z.object({
  invitationId: z.string().uuid(),
});

export type LobbyCreatePayload = z.infer<typeof lobbyCreateSchema>;
export type LobbyJoinByCodePayload = z.infer<typeof lobbyJoinByCodeSchema>;
export type LobbyLeavePayload = z.infer<typeof lobbyLeaveSchema>;
export type LobbyReadyPayload = z.infer<typeof lobbyReadySchema>;
export type LobbyUpdateSettingsPayload = z.infer<typeof lobbyUpdateSettingsSchema>;
export type LobbyStartPayload = z.infer<typeof lobbyStartSchema>;
export type LobbyChallengePayload = z.infer<typeof lobbyChallengeSchema>;
export type LobbyChallengeDecisionPayload = z.infer<typeof lobbyChallengeDecisionSchema>;
