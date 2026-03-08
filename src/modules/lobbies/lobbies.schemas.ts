import { z } from 'zod';

export const listPublicLobbiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  joinableOnly: z.coerce.boolean().optional().default(false),
});

export const publicLobbyResponseSchema = z.object({
  lobbyId: z.string().uuid(),
  inviteCode: z.string(),
  displayName: z.string(),
  gameMode: z.enum(['friendly_possession', 'friendly_party_quiz', 'ranked_sim']),
  isPublic: z.boolean(),
  createdAt: z.string().datetime(),
  memberCount: z.number().int(),
  maxMembers: z.number().int(),
  host: z.object({
    id: z.string().uuid(),
    username: z.string().nullable(),
    avatarUrl: z.string().url().nullable(),
  }),
});

export const listPublicLobbiesResponseSchema = z.object({
  items: z.array(publicLobbyResponseSchema),
});

export type ListPublicLobbiesQuery = z.infer<typeof listPublicLobbiesQuerySchema>;
export type PublicLobbyResponse = z.infer<typeof publicLobbyResponseSchema>;
export type ListPublicLobbiesResponse = z.infer<typeof listPublicLobbiesResponseSchema>;
