import { z } from 'zod';
import { DUEL_GAMES } from '../../modules/duel/duel.types.js';
import { ROOM_GAMES } from '../../modules/room/room.types.js';
import { LOBBY_GAME_MODES, LOBBY_MODES } from '../../modules/lobbies/lobby-modes.js';

const correlationIdSchema = z.string().min(1).max(128).optional();
const duelGameSchema = z.enum(DUEL_GAMES);
const roomGameSchema = z.enum(ROOM_GAMES);

/** A duel room names its game; no other room has one (mirrors lobbies_duel_game_check). */
function refineDuelGame(data: { gameMode?: string; duelGame?: string | null; roomGame?: string | null }, ctx: z.RefinementCtx): void {
  if (data.gameMode === 'room_game' && !data.roomGame) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A room-game room needs its game', path: ['roomGame'] });
  }
  if (data.gameMode !== 'room_game' && data.roomGame) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a room-game room has a room game', path: ['roomGame'] });
  }
  if (data.gameMode === 'duel' && !data.duelGame) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A duel room needs its game', path: ['duelGame'] });
  }
  if (data.gameMode !== 'duel' && data.duelGame) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only a duel room has a duel game', path: ['duelGame'] });
  }
}

export const lobbyCreateSchema = z
  .object({
    mode: z.enum(['friendly', 'ranked']),
    isPublic: z.boolean().optional(),
    // Open the room straight in a friend-playable mode (the game modals' "Play with friend").
    gameMode: z.enum(['football_grid', 'auction', 'duel', 'room_game']).optional(),
    // Whether the game is enabled is checked by the service, which answers DUEL_UNAVAILABLE / ROOM_GAME_UNAVAILABLE.
    duelGame: duelGameSchema.optional(),
    roomGame: roomGameSchema.optional(),
    correlationId: correlationIdSchema,
  })
  .superRefine(refineDuelGame);

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

export const lobbyRoomOptionsSchema = z.object({
  lobbyId: z.string().uuid().optional(),
  // The room's game decides what is valid; this only bounds the size.
  options: z.record(z.union([z.string().max(32), z.number(), z.boolean()])).nullable().refine((o) => o === null || Object.keys(o).length <= 8, 'too many options'),
});

/**
 * The game the sender's screen showed when they pressed Ready or Start. Sent by clients that know about it; the
 * command is refused when the room is on another game by the time it arrives (the state push with the change and
 * the command crossed on the wire).
 */
const seenGameSchema = z.object({
  gameMode: z.enum(LOBBY_GAME_MODES),
  duelGame: duelGameSchema.nullable().optional(),
  roomGame: roomGameSchema.nullable().optional(),
});

export const lobbyReadySchema = z.object({
  ready: z.boolean(),
  seen: seenGameSchema.optional(),
});

export const lobbyUpdateSettingsSchema = z
  .object({
    lobbyId: z.string().uuid().optional(),
    gameMode: z.enum(LOBBY_GAME_MODES),
    duelGame: duelGameSchema.nullable().optional(),
    roomGame: roomGameSchema.nullable().optional(),
    friendlyRandom: z.boolean().optional(),
    friendlyCategoryAId: z.string().uuid().nullable().optional(),
    friendlyCategoryBId: z.string().uuid().nullable().optional(),
    isPublic: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    refineDuelGame(data, ctx);
    // Auction, grid, ranked sim and duels bring their own content, not lobby categories.
    if (!LOBBY_MODES[data.gameMode].needsCategories) return;

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
  seen: seenGameSchema.optional(),
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
