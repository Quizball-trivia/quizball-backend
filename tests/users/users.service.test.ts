import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const updateMock = vi.fn();
const getActiveByPhoneNumberMock = vi.fn();
const isNicknameTakenMock = vi.fn();
const requestDeletionMock = vi.fn();
const cancelPendingDeletionMock = vi.fn();
const createWithIdentityMock = vi.fn();
const searchByNicknameRepoMock = vi.fn();
const getByProviderSubjectMock = vi.fn();
const getCachedUserMock = vi.fn();
const setCachedUserMock = vi.fn();
const updateCachedUserMock = vi.fn();
const invalidateByUserIdMock = vi.fn();
const getProfileMock = vi.fn();
const getUserRankMock = vi.fn();
const getUserStatsSummaryMock = vi.fn();
const getHeadToHeadMock = vi.fn();
const getRelationshipStatusesMock = vi.fn();
const listInventoryWithProductsMock = vi.fn();

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
    update: (...args: unknown[]) => updateMock(...args),
    isNicknameTaken: (...args: unknown[]) => isNicknameTakenMock(...args),
    getActiveByPhoneNumber: (...args: unknown[]) => getActiveByPhoneNumberMock(...args),
    requestDeletion: (...args: unknown[]) => requestDeletionMock(...args),
    cancelPendingDeletion: (...args: unknown[]) => cancelPendingDeletionMock(...args),
    createWithIdentity: (...args: unknown[]) => createWithIdentityMock(...args),
  },
  isUserAccountInactive: (user: { is_deleted?: boolean; deleted_at?: string | null; pending_deletion_at?: string | null }) =>
    Boolean(user.is_deleted || user.deleted_at || user.pending_deletion_at),
}));

vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: {
    listInventoryWithProducts: (...args: unknown[]) => listInventoryWithProductsMock(...args),
  },
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: {
    getRelationshipStatuses: (...args: unknown[]) => getRelationshipStatusesMock(...args),
  },
}));

vi.mock('../../src/modules/users/identities.repo.js', () => ({
  identitiesRepo: {
    getByProviderSubject: (...args: unknown[]) => getByProviderSubjectMock(...args),
  },
}));

vi.mock('../../src/modules/users/user-cache.js', () => ({
  getCachedUser: (...args: unknown[]) => getCachedUserMock(...args),
  setCachedUser: (...args: unknown[]) => setCachedUserMock(...args),
  updateCachedUser: (...args: unknown[]) => updateCachedUserMock(...args),
  invalidateByUserId: (...args: unknown[]) => invalidateByUserIdMock(...args),
}));

const disconnectUserSocketsMock = vi.fn();
vi.mock('../../src/realtime/services/auth-realtime.service.js', () => ({
  disconnectUserSockets: (...args: unknown[]) => disconnectUserSocketsMock(...args),
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
  avatar_customization: null,
  favorite_club: 'Arsenal',
  preferred_language: 'en',
  onboarding_complete: true,
  total_xp: 250,
  created_at: '2024-01-01T00:00:00.000Z',
  deletion_requested_at: null,
  pending_deletion_at: null,
  deleted_at: null,
  is_deleted: false,
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
    updateMock.mockResolvedValue({ ...MOCK_USER, avatar_customization: { skin: 'skin_male_white' } });
    isNicknameTakenMock.mockResolvedValue(false);
    listInventoryWithProductsMock.mockResolvedValue([]);
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
      avatar_customization: null,
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

  it('hides users pending deletion from public profiles', async () => {
    getByIdMock.mockResolvedValue({
      ...MOCK_USER,
      deletion_requested_at: '2026-05-07T12:00:00.000Z',
      pending_deletion_at: '2026-06-06T12:00:00.000Z',
    });
    const { usersService } = await import('../../src/modules/users/users.service.js');
    const { NotFoundError } = await import('../../src/core/errors.js');

    await expect(usersService.getPublicProfile('user-target-id', 'viewer-id'))
      .rejects
      .toThrow(NotFoundError);
    expect(getProfileMock).not.toHaveBeenCalled();
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

  it('rejects avatar customization with unowned paid items', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.updateProfile('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white',
        hair: 'hair_ramos',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Avatar customization includes unowned items',
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('allows local admin avatar customization preview with unowned paid items', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await usersService.updateProfile('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white_alt',
        hair: 'hair_ramos',
      },
    }, {
      requesterRole: 'admin',
    });

    expect(updateMock).toHaveBeenCalledWith('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white_alt',
        hair: 'hair_ramos',
      },
    });
  });

  it('allows avatar customization with free and owned paid items', async () => {
    listInventoryWithProductsMock.mockResolvedValue([
      { product_slug: 'avatar_hair_ramos' },
    ]);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await usersService.updateProfile('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white',
        hair: 'hair_ramos',
      },
    });

    expect(updateMock).toHaveBeenCalledWith('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white',
        hair: 'hair_ramos',
      },
    });
  });

  it('allows keeping an already-equipped paid item while changing another slot', async () => {
    getByIdMock.mockResolvedValue({
      ...MOCK_USER,
      avatar_customization: {
        skin: 'skin_male_white',
        jersey: 'jersey_real',
        hair: 'hair_ronaldo_goat',
      },
    });
    listInventoryWithProductsMock.mockResolvedValue([
      { product_slug: 'avatar_jersey_real' },
      { product_slug: 'avatar_jersey_milan' },
    ]);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await usersService.updateProfile('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white',
        jersey: 'jersey_milan',
        hair: 'hair_ronaldo_goat',
      },
    });

    expect(updateMock).toHaveBeenCalledWith('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_white',
        jersey: 'jersey_milan',
        hair: 'hair_ronaldo_goat',
      },
    });
  });

  it('allows all skin tones without inventory ownership', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await usersService.updateProfile('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_dark_alt',
      },
    });

    expect(updateMock).toHaveBeenCalledWith('user-target-id', {
      avatarCustomization: {
        skin: 'skin_male_dark_alt',
      },
    });
  });

  it('rejects prohibited nicknames before checking uniqueness', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.updateProfile('user-target-id', {
      nickname: `Ni${'gge'}R`,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Nickname is not allowed',
      details: {
        field: 'nickname',
        reason: 'prohibited_content',
      },
    });

    expect(isNicknameTakenMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('trims nickname before uniqueness checks and persistence', async () => {
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await usersService.updateProfile('user-target-id', {
      nickname: '  CleanName  ',
    });

    expect(isNicknameTakenMock).toHaveBeenCalledWith('CleanName', 'user-target-id');
    expect(updateMock).toHaveBeenCalledWith('user-target-id', {
      nickname: 'CleanName',
    });
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
        avatarCustomization: null,
        level: 4,
        pendingDeletion: false,
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
        avatarCustomization: null,
        level: 1,
        pendingDeletion: false,
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

describe('usersService account deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules deletion and invalidates cached auth state', async () => {
    requestDeletionMock.mockResolvedValue({
      ...MOCK_USER,
      deletion_requested_at: '2026-05-07T12:00:00.000Z',
      pending_deletion_at: '2026-06-06T12:00:00.000Z',
    });
    const { usersService } = await import('../../src/modules/users/users.service.js');

    const result = await usersService.requestAccountDeletion('user-target-id');

    expect(requestDeletionMock).toHaveBeenCalledWith('user-target-id');
    expect(invalidateByUserIdMock).toHaveBeenCalledWith('user-target-id');
    expect(disconnectUserSocketsMock).toHaveBeenCalledWith('user-target-id', 'account_deleted');
    expect(result).toEqual({
      deletionRequestedAt: '2026-05-07T12:00:00.000Z',
      pendingDeletionAt: '2026-06-06T12:00:00.000Z',
    });
  });

  it('restores pending deletion before the grace period expires', async () => {
    cancelPendingDeletionMock.mockResolvedValue(MOCK_USER);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.restorePendingDeletion('user-target-id')).resolves.toEqual(MOCK_USER);

    expect(cancelPendingDeletionMock).toHaveBeenCalledWith('user-target-id');
    expect(invalidateByUserIdMock).toHaveBeenCalledWith('user-target-id');
  });

  it('rejects restore when the account is not restorable', async () => {
    cancelPendingDeletionMock.mockResolvedValue(null);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.restorePendingDeletion('user-target-id')).rejects.toMatchObject({
      statusCode: 400,
      message: 'Account is not pending deletion or grace period has expired',
    });
  });

  it('blocks auth resolution for pending deletion identities', async () => {
    getCachedUserMock.mockReturnValue(null);
    getByProviderSubjectMock.mockResolvedValue({
      id: 'identity-id',
      provider: 'supabase',
      subject: 'provider-sub',
      user_id: 'user-target-id',
      email: 'target@example.com',
      created_at: '2026-05-07T12:00:00.000Z',
      user: {
        ...MOCK_USER,
        pending_deletion_at: '2026-06-06T12:00:00.000Z',
      },
    });
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.getOrCreateFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      email: 'target@example.com',
      claims: {},
    })).rejects.toMatchObject({
      statusCode: 401,
      message: 'Account is scheduled for deletion',
      details: { reason: 'pending_deletion' },
    });

    expect(setCachedUserMock).not.toHaveBeenCalled();
    expect(updateCachedUserMock).not.toHaveBeenCalled();
  });

  it('self-restores a pending deletion account from a verified identity', async () => {
    getByProviderSubjectMock.mockResolvedValue({
      id: 'identity-id',
      provider: 'supabase',
      subject: 'provider-sub',
      user_id: 'user-target-id',
      email: 'target@example.com',
      created_at: '2026-05-07T12:00:00.000Z',
      user: {
        ...MOCK_USER,
        deletion_requested_at: '2026-05-07T12:00:00.000Z',
        pending_deletion_at: '2026-06-06T12:00:00.000Z',
      },
    });
    cancelPendingDeletionMock.mockResolvedValue(MOCK_USER);
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.restorePendingDeletionFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      email: 'target@example.com',
      claims: {},
    })).resolves.toEqual(MOCK_USER);

    expect(cancelPendingDeletionMock).toHaveBeenCalledWith('user-target-id');
    expect(invalidateByUserIdMock).toHaveBeenCalledWith('user-target-id');
  });

  it('treats self-restore as success when the matching account is already active', async () => {
    getByProviderSubjectMock.mockResolvedValue({
      id: 'identity-id',
      provider: 'supabase',
      subject: 'provider-sub',
      user_id: 'user-target-id',
      email: 'target@example.com',
      created_at: '2026-05-07T12:00:00.000Z',
      user: MOCK_USER,
    });
    const { usersService } = await import('../../src/modules/users/users.service.js');

    await expect(usersService.restorePendingDeletionFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      claims: {},
    })).resolves.toEqual(MOCK_USER);

    expect(cancelPendingDeletionMock).not.toHaveBeenCalled();
    expect(invalidateByUserIdMock).not.toHaveBeenCalled();
  });
});

describe('usersService.getOrCreateFromIdentity phone backfill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes blank identity phone numbers before creating a new user', async () => {
    getCachedUserMock.mockReturnValue(null);
    getByProviderSubjectMock.mockResolvedValue(null);
    createWithIdentityMock.mockResolvedValue(MOCK_USER);

    const { usersService } = await import('../../src/modules/users/users.service.js');
    await usersService.getOrCreateFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      email: 'target@example.com',
      phoneNumber: '',
      claims: {},
    });

    expect(createWithIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: null,
        phoneVerifiedAt: null,
      }),
      expect.objectContaining({
        provider: 'supabase',
        subject: 'provider-sub',
      })
    );
  });

  it('skips the phone backfill when the number is already held by another active user', async () => {
    // Cached user has no phone yet; the identity carries a phone already linked
    // to a different active account — backfilling it would violate
    // uq_users_phone_number_active and break this otherwise-valid login.
    getCachedUserMock.mockReturnValue({ ...MOCK_USER, phone_number: null, phone_verified_at: null });
    getActiveByPhoneNumberMock.mockResolvedValue({ ...MOCK_USER, id: 'someone-else', phone_number: '+995577123456' });

    const { usersService } = await import('../../src/modules/users/users.service.js');
    const result = await usersService.getOrCreateFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      email: 'target@example.com',
      phoneNumber: '+995577123456',
      claims: {},
    });

    expect(getActiveByPhoneNumberMock).toHaveBeenCalledWith('+995577123456');
    // No update at all (only field would have been the conflicting phone) → login still succeeds.
    expect(updateMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 'user-target-id' });
  });

  it('backfills the phone when the number is free', async () => {
    getCachedUserMock.mockReturnValue({ ...MOCK_USER, phone_number: null, phone_verified_at: null });
    getActiveByPhoneNumberMock.mockResolvedValue(null);
    updateMock.mockResolvedValue({ ...MOCK_USER, phone_number: '+995577123456', phone_verified_at: '2026-05-29T00:00:00.000Z' });

    const { usersService } = await import('../../src/modules/users/users.service.js');
    await usersService.getOrCreateFromIdentity({
      provider: 'supabase',
      subject: 'provider-sub',
      email: 'target@example.com',
      phoneNumber: '+995577123456',
      phoneVerifiedAt: '2026-05-29T00:00:00.000Z',
      claims: {},
    });

    expect(updateMock).toHaveBeenCalledWith(
      'user-target-id',
      expect.objectContaining({
        phoneNumber: '+995577123456',
        phoneVerifiedAt: '2026-05-29T00:00:00.000Z',
      })
    );
  });
});
