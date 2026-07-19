import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '../setup.js';

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listMembersWithUser: vi.fn(),
    listPublicLobbies: vi.fn(),
    listAllValidCategories: vi.fn(),
  },
}));

const ensureProfileMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
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
import {
  invalidateCategoryCache,
  lobbiesService,
} from '../../src/modules/lobbies/lobbies.service.js';

describe('lobbiesService public/friendly helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCategoryCache();
    ensureProfileMock.mockResolvedValue({ rp: 0 });
  });

  it('keeps category eligibility caches separate for 5- and 10-question modes', async () => {
    (lobbiesRepo.listAllValidCategories as Mock).mockImplementation(async (minimum: number) => (
      minimum >= 10
        ? [{ id: 'deep', name: { en: 'Deep' }, icon: null, image_url: null }]
        : [{ id: 'thin', name: { en: 'Thin' }, icon: null, image_url: null }]
    ));

    await expect(lobbiesService.selectRandomCategories(1, 5)).resolves.toEqual([
      expect.objectContaining({ id: 'thin' }),
    ]);
    await expect(lobbiesService.selectRandomCategories(1, 10)).resolves.toEqual([
      expect.objectContaining({ id: 'deep' }),
    ]);
    await expect(lobbiesService.selectRandomCategories(1, 5)).resolves.toEqual([
      expect.objectContaining({ id: 'thin' }),
    ]);

    expect(lobbiesRepo.listAllValidCategories).toHaveBeenCalledTimes(2);
    expect(lobbiesRepo.listAllValidCategories).toHaveBeenNthCalledWith(1, 5);
    expect(lobbiesRepo.listAllValidCategories).toHaveBeenNthCalledWith(2, 10);
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
        avatar_customization: null,
        favorite_club: null,
        is_ai: false,
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
          avatarCustomization: null,
        },
      },
    ]);
    expect(lobbiesRepo.listPublicLobbies).toHaveBeenCalledWith({ limit: 20, joinableOnly: true });
  });

  it('includes ranked RP in active ranked lobby state after reconnect', async () => {
    ensureProfileMock.mockResolvedValue({ rp: 875 });
    (lobbiesRepo.listMembersWithUser as Mock).mockResolvedValue([
      {
        lobby_id: 'lobby-ranked',
        user_id: 'host-1',
        is_ready: true,
        joined_at: new Date().toISOString(),
        nickname: 'Host',
        avatar_url: null,
        avatar_customization: null,
        favorite_club: null,
        is_ai: false,
      },
      {
        lobby_id: 'lobby-ranked',
        user_id: 'ai-1',
        is_ready: true,
        joined_at: new Date().toISOString(),
        nickname: 'AI',
        avatar_url: null,
        avatar_customization: null,
        favorite_club: null,
        is_ai: true,
      },
    ]);

    const state = await lobbiesService.buildLobbyState({
      id: 'lobby-ranked',
      mode: 'ranked',
      status: 'active',
      invite_code: null,
      display_name: 'Ranked',
      is_public: false,
      host_user_id: 'host-1',
      game_mode: 'ranked_sim',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      ranked_context: { aiAnchorRp: 150 },
    } as never);

    expect(state.members).toEqual([
      expect.objectContaining({ userId: 'host-1', rankPoints: 875 }),
      expect.objectContaining({ userId: 'ai-1', rankPoints: 150 }),
    ]);
    expect(ensureProfileMock).toHaveBeenCalledWith('host-1');
    expect(ensureProfileMock).not.toHaveBeenCalledWith('ai-1');
  });
});
