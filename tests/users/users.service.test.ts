import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const getProfileMock = vi.fn();
const getUserRankMock = vi.fn();
const getUserStatsSummaryMock = vi.fn();
const getHeadToHeadMock = vi.fn();

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
    update: vi.fn(),
    createWithIdentity: vi.fn(),
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

  it('skips H2H call when viewer is the same as target', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.getPublicProfile('user-target-id', 'user-target-id');

    expect(getHeadToHeadMock).not.toHaveBeenCalled();
    expect(result.headToHead).toBeNull();
  });
});
