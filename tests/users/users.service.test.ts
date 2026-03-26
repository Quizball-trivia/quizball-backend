import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const searchByNicknameRepoMock = vi.fn();
const getProfileMock = vi.fn();
const getUserRankMock = vi.fn();
const getUserStatsSummaryMock = vi.fn();
const getHeadToHeadMock = vi.fn();
const getRelationshipStatusesMock = vi.fn();

vi.mock('../../src/core/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getByIdMock(...args),
    searchByNickname: (...args: unknown[]) => searchByNicknameRepoMock(...args),
    update: vi.fn(),
    createWithIdentity: vi.fn(),
  },
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: {
    getRelationshipStatuses: (...args: unknown[]) => getRelationshipStatusesMock(...args),
  },
}));

vi.mock('../../src/modules/users/identities.repo.js', () => ({
  identitiesRepo: {
    getByProviderSubject: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/user-cache.js', () => ({
  getCachedUser: vi.fn(),
  setCachedUser: vi.fn(),
  updateCachedUser: vi.fn(),
}));

vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({
  rankedRepo: {
    getProfile: (...args: unknown[]) => getProfileMock(...args),
    getUserRank: (...args: unknown[]) => getUserRankMock(...args),
  },
}));

vi.mock('../../src/modules/stats/stats.repo.js', () => ({
  statsRepo: {
    getUserModeStats: vi.fn().mockResolvedValue([]),
    getHeadToHead: vi.fn().mockResolvedValue({
      wins_a: 0,
      wins_b: 0,
      draws: 0,
      total: 0,
      last_played_at: null,
    }),
  },
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({
  statsService: {
    getUserStatsSummary: (...args: unknown[]) => getUserStatsSummaryMock(...args),
    getHeadToHead: (...args: unknown[]) => getHeadToHeadMock(...args),
  },
}));

const MOCK_USER = {
  id: 'user-target-id',
  email: 'target@example.com',
  nickname: 'TargetUser',
  country: 'US',
  avatar_url: 'https://example.com/avatar.png',
  favorite_club: 'Arsenal',
  preferred_language: 'en',
  onboarding_complete: true,
  total_xp: 250,
  created_at: '2024-01-01T00:00:00.000Z',
};

const MOCK_RANKED_PROFILE = {
  user_id: 'user-target-id',
  rp: 1500,
  tier: 'Captain',
  placement_status: 'placed',
  placement_played: 3,
  placement_required: 3,
  placement_wins: 2,
  current_win_streak: 3,
  last_ranked_match_at: '2024-06-01T00:00:00.000Z',
};

const MOCK_GLOBAL_RANK = { rank: 42, total: 500, trendWins: 2, trendTotal: 3 };
const MOCK_COUNTRY_RANK = { rank: 5, total: 50, trendWins: 2, trendTotal: 3 };

const MOCK_STATS_SUMMARY = {
  overall: { gamesPlayed: 10, wins: 6, losses: 3, draws: 1, winRate: 60 },
  ranked: { gamesPlayed: 5, wins: 3, losses: 1, draws: 1, winRate: 60 },
  friendly: { gamesPlayed: 5, wins: 3, losses: 2, draws: 0, winRate: 60 },
};

const MOCK_H2H = {
  userAId: 'viewer-id',
  userBId: 'user-target-id',
  winsA: 3,
  winsB: 2,
  draws: 1,
  total: 6,
  lastPlayedAt: '2024-06-01T00:00:00.000Z',
};

describe('usersService.getPublicProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByIdMock.mockResolvedValue(MOCK_USER);
    getProfileMock.mockResolvedValue(MOCK_RANKED_PROFILE);
    getUserRankMock.mockImplementation((_userId: string, country?: string) =>
      Promise.resolve(country ? MOCK_COUNTRY_RANK : MOCK_GLOBAL_RANK),
    );
    getUserStatsSummaryMock.mockResolvedValue(MOCK_STATS_SUMMARY);
    getHeadToHeadMock.mockResolvedValue(MOCK_H2H);
  });

  it('returns full public profile with ranked, stats, and H2H for different viewer', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.getPublicProfile('user-target-id', 'viewer-id');

    expect(getByIdMock).toHaveBeenCalledWith('user-target-id');
    expect(getProfileMock).toHaveBeenCalledWith('user-target-id');
    expect(getUserStatsSummaryMock).toHaveBeenCalledWith('user-target-id');
    expect(getHeadToHeadMock).toHaveBeenCalledWith('viewer-id', 'user-target-id');

    expect(result.user).toEqual({
      id: 'user-target-id',
      nickname: 'TargetUser',
      avatar_url: 'https://example.com/avatar.png',
      country: 'US',
      favorite_club: 'Arsenal',
      total_xp: 250,
    });
    // Excludes private fields
    expect(result.user).not.toHaveProperty('email');
    expect(result.user).not.toHaveProperty('preferred_language');
    expect(result.user).not.toHaveProperty('onboarding_complete');

    expect(result.ranked).toEqual({
      rp: 1500,
      tier: 'Captain',
      placementStatus: 'placed',
      placementPlayed: 3,
      placementRequired: 3,
      placementWins: 2,
      currentWinStreak: 3,
      lastRankedMatchAt: '2024-06-01T00:00:00.000Z',
    });

    expect(result.progression).toEqual({
      level: 3,
      totalXp: 250,
      currentLevelXp: 38,
      xpForNextLevel: 125,
      progressPct: 30,
    });
    expect(result.stats).toEqual(MOCK_STATS_SUMMARY);
    expect(result.headToHead).toEqual(MOCK_H2H);
    expect(result.globalRank).toEqual({ rank: 42, total: 500 });
    expect(result.countryRank).toEqual({ rank: 5, total: 50 });
  });

  it('throws NotFoundError when user does not exist', async () => {
    getByIdMock.mockResolvedValue(null);
    const { usersService } = await import('../../src/modules/users/users.service.js');
    const { NotFoundError } = await import('../../src/core/errors.js');

    await expect(usersService.getPublicProfile('nonexistent-id', 'viewer-id'))
      .rejects
      .toThrow(NotFoundError);
  });

  it('returns null ranked when user has no ranked profile', async () => {
    getProfileMock.mockResolvedValue(null);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.getPublicProfile('user-target-id', 'viewer-id');

    expect(result.ranked).toBeNull();
  });

  it('maps updated total_xp into refreshed profile progression', async () => {
    getByIdMock.mockResolvedValue({
      ...MOCK_USER,
      total_xp: 370,
    });
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.getPublicProfile('user-target-id', 'viewer-id');

    expect(result.user.total_xp).toBe(370);
    expect(result.progression).toEqual({
      level: 4,
      totalXp: 370,
      currentLevelXp: 33,
      xpForNextLevel: 140,
      progressPct: 23,
    });
  });

  it('skips H2H call when viewer is the same as target', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.getPublicProfile('user-target-id', 'user-target-id');

    expect(getHeadToHeadMock).not.toHaveBeenCalled();
    expect(result.headToHead).toBeNull();
  });
});

describe('usersService.searchByNickname', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchByNicknameRepoMock.mockResolvedValue([
      {
        id: '11111111-1111-1111-1111-111111111111',
        nickname: 'LevelFourUser',
        avatar_url: 'https://example.com/a.png',
        total_xp: 370,
        ranked_rp: 1420,
        ranked_tier: 'Rotation',
        ranked_placement_status: 'in_progress',
        ranked_placement_played: 1,
        ranked_placement_required: 3,
        ranked_placement_wins: 1,
        ranked_current_win_streak: 1,
        ranked_last_ranked_match_at: '2024-01-01T00:00:00.000Z',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        nickname: 'PendingUser',
        avatar_url: null,
        total_xp: 0,
        ranked_rp: null,
        ranked_tier: null,
        ranked_placement_status: null,
        ranked_placement_played: null,
        ranked_placement_required: null,
        ranked_placement_wins: null,
        ranked_current_win_streak: null,
        ranked_last_ranked_match_at: null,
      },
    ]);
    getRelationshipStatusesMock.mockResolvedValue(new Map([
      ['11111111-1111-1111-1111-111111111111', 'friends'],
      ['22222222-2222-2222-2222-222222222222', 'pending_sent'],
    ]));
  });

  it('maps total_xp to progression level and includes ranked placement data', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.searchByNickname('user', 'viewer-id');

    expect(searchByNicknameRepoMock).toHaveBeenCalledWith('user', 'viewer-id');
    expect(getRelationshipStatusesMock).toHaveBeenCalledWith('viewer-id', [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
    expect(result).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        nickname: 'LevelFourUser',
        avatarUrl: 'https://example.com/a.png',
        level: 4,
        ranked: {
          rp: 1420,
          tier: 'Rotation',
          placementStatus: 'in_progress',
          placementPlayed: 1,
          placementRequired: 3,
          placementWins: 1,
          currentWinStreak: 1,
          lastRankedMatchAt: '2024-01-01T00:00:00.000Z',
        },
        friendStatus: 'friends',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        nickname: 'PendingUser',
        avatarUrl: null,
        level: 1,
        ranked: null,
        friendStatus: 'pending_sent',
      },
    ]);
  });

  it('defaults missing relationship rows to none', async () => {
    getRelationshipStatusesMock.mockResolvedValue(new Map());
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.searchByNickname('user', 'viewer-id');

    expect(result[0]?.friendStatus).toBe('none');
    expect(result[1]?.friendStatus).toBe('none');
  });
});
