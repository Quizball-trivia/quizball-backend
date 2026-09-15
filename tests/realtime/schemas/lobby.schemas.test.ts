import { describe, expect, it } from 'vitest';
import { lobbyCreateSchema } from '../../../src/realtime/schemas/lobby.schemas.js';

describe('lobbyCreateSchema', () => {
  it('accepts a friend-playable initial game mode and rejects the others', () => {
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'auction' }).success).toBe(true);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', isPublic: false, gameMode: 'football_grid' }).success).toBe(true);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly' }).success).toBe(true);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'friendly_possession' }).success).toBe(false);
    expect(lobbyCreateSchema.safeParse({ mode: 'friendly', gameMode: 'ranked_sim' }).success).toBe(false);
  });
});
