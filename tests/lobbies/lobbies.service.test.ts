import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '../setup.js';

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listMembersWithUser: vi.fn(),
    listPublicLobbies: vi.fn(),
  },
}));

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/index.js')>();
  return {
    ...actual,
    pickI18nText: vi.fn((value: unknown) => {
      if (!value || typeof value !== 'object') return '';
      const asRecord = value as Record<string, string>;
      return asRecord.en ?? Object.values(asRecord)[0] ?? '';
    }),
  };
});

import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';
import { lobbiesService } from '../../src/modules/lobbies/lobbies.service.js';

describe('lobbiesService public/friendly helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults legacy friendly game mode to friendly_possession in lobby state', async () => {
    (lobbiesRepo.listMembersWithUser as Mock).mockResolvedValue([
      {
        lobby_id: 'lobby-1',
        user_id: 'host-1',
        is_ready: false,
        joined_at: new Date().toISOString(),
        nickname: 'Host',
        avatar_url: null,
      },
    ]);

    const state = await lobbiesService.buildLobbyState({
      id: 'lobby-1',
      mode: 'friendly',
      status: 'waiting',
      invite_code: 'ABC123',
      display_name: 'Friendly Lobby',
      is_public: false,
      host_user_id: 'host-1',
      game_mode: null,
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
    } as never);

    expect(state.settings.gameMode).toBe('friendly_possession');
    expect(state.members).toEqual([
      expect.objectContaining({
        userId: 'host-1',
        username: 'Host',
        isHost: true,
      }),
    ]);
  });

  it('maps public lobbies to 6-player max capacity and preserves explicit party mode', async () => {
    (lobbiesRepo.listPublicLobbies as Mock).mockResolvedValue([
      {
        lobby_id: 'lobby-party',
        invite_code: 'PARTY6',
        display_name: 'Party Room',
        game_mode: 'friendly_party_quiz',
        is_public: true,
        created_at: new Date().toISOString(),
        host_user_id: 'host-2',
        host_nickname: 'Captain',
        host_avatar_url: null,
        member_count: 4,
      },
    ]);

    const lobbies = await lobbiesService.listPublicLobbies({ limit: 20, joinableOnly: true });

    expect(lobbies).toEqual([
      {
        lobbyId: 'lobby-party',
        inviteCode: 'PARTY6',
        displayName: 'Party Room',
        gameMode: 'friendly_party_quiz',
        isPublic: true,
        createdAt: expect.any(String),
        memberCount: 4,
        maxMembers: 6,
        host: {
          id: 'host-2',
          username: 'Captain',
          avatarUrl: null,
        },
      },
    ]);
    expect(lobbiesRepo.listPublicLobbies).toHaveBeenCalledWith({ limit: 20, joinableOnly: true });
  });
});
