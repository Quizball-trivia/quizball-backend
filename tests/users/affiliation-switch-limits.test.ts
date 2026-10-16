import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdMock = vi.fn();
const updateMock = vi.fn();
const isNicknameTakenMock = vi.fn();
const isNicknameReservedMock = vi.fn();
const changeNicknameInTxMock = vi.fn();
const getNicknameQuotaMock = vi.fn();
const hasConsumedSignupNamingMock = vi.fn();
const getIdentityDerivedNicknameMock = vi.fn();
const getPublicNicknameHistoryMock = vi.fn();

vi.mock('../../src/core/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...a: unknown[]) => getByIdMock(...a),
    update: (...a: unknown[]) => updateMock(...a),
    isNicknameTaken: (...a: unknown[]) => isNicknameTakenMock(...a),
    isNicknameReserved: (...a: unknown[]) => isNicknameReservedMock(...a),
    changeNicknameInTx: (...a: unknown[]) => changeNicknameInTxMock(...a),
    getNicknameQuota: (...a: unknown[]) => getNicknameQuotaMock(...a),
    hasConsumedSignupNaming: (...a: unknown[]) => hasConsumedSignupNamingMock(...a),
    getIdentityDerivedNickname: (...a: unknown[]) => getIdentityDerivedNicknameMock(...a),
    getPublicNicknameHistory: (...a: unknown[]) => getPublicNicknameHistoryMock(...a),
  },
  NICKNAME_FREE_CHANGES: 2,
  NICKNAME_COOLDOWN_DAYS: 30,
  NICKNAME_RESERVATION_DAYS: 30,
  isUserAccountInactive: () => false,
  isUserBanned: (user: { is_banned?: boolean }) => Boolean(user.is_banned),
}));

vi.mock('../../src/modules/users/user-cache.js', () => ({
  getCachedUser: vi.fn(),
  setCachedUser: vi.fn(),
  updateCachedUser: vi.fn(),
  invalidateByUserId: vi.fn(),
}));

// getPublicProfile fans out to ranked/stats; stub them so no test touches a DB.
vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({
  rankedRepo: {
    getProfile: vi.fn().mockResolvedValue(null),
    getUserRank: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { getUserRank: vi.fn().mockResolvedValue(null) },
  tierFromRp: () => 'Academy',
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({ statsService: {} }));

const resolveClubMock = vi.fn();
vi.mock('../../src/modules/leaderboards/leaderboard-clubs.js', () => ({
  leaderboardClubs: { resolve: (...a: unknown[]) => resolveClubMock(...a), exists: vi.fn() },
}));

const { usersService } = await import('../../src/modules/users/users.service.js');

const USER_ID = 'user-1';
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    role: 'user',
    nickname: 'Player',
    country: 'GE',
    favorite_club: 'FC Barcelona',
    club_changed_at: null,
    country_changed_at: null,
    ...overrides,
  };
}

const CLUB_IDS: Record<string, string> = {
  'fc barcelona': 'fc-barcelona',
  'real madrid': 'real-madrid-cf',
  'real madrid cf': 'real-madrid-cf',
};

beforeEach(() => {
  vi.clearAllMocks();
  getByIdMock.mockResolvedValue(makeUser());
  updateMock.mockImplementation(async (_id: string, data: Record<string, unknown>) => makeUser(data));
  resolveClubMock.mockImplementation(async (name: string) => CLUB_IDS[name.trim().toLowerCase()] ?? null);
});

describe('club and country switches', () => {
  it('lets a player set a club for the first time without starting the 30 days', async () => {
    getByIdMock.mockResolvedValue(makeUser({ favorite_club: null }));
    await usersService.updateProfile(USER_ID, { favoriteClub: 'Real Madrid CF' });
    expect(updateMock.mock.calls[0][1]).toMatchObject({ favoriteClub: 'Real Madrid CF', enforceAffiliationLock: true });
  });

  it('stamps a real switch and refuses another within 30 days', async () => {
    await usersService.updateProfile(USER_ID, { favoriteClub: 'Real Madrid CF' });
    expect(updateMock.mock.calls[0][1]).toMatchObject({ enforceAffiliationLock: true });

    getByIdMock.mockResolvedValue(makeUser({ favorite_club: 'Real Madrid CF', club_changed_at: daysAgo(10) }));
    await expect(usersService.updateProfile(USER_ID, { favoriteClub: 'FC Barcelona' })).rejects.toMatchObject({
      statusCode: 409,
      details: { field: 'favoriteClub', reason: 'affiliation_cooldown' },
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('allows the next switch after 30 days', async () => {
    getByIdMock.mockResolvedValue(makeUser({ club_changed_at: daysAgo(31) }));
    await usersService.updateProfile(USER_ID, { favoriteClub: 'Real Madrid CF' });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('treats another spelling of the same club as no switch', async () => {
    getByIdMock.mockResolvedValue(makeUser({ favorite_club: 'Real Madrid', club_changed_at: daysAgo(2) }));
    await usersService.updateProfile(USER_ID, { favoriteClub: 'Real Madrid CF' });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('applies the same rule to countries, and a resubmitted country is not a switch', async () => {
    getByIdMock.mockResolvedValue(makeUser({ country_changed_at: daysAgo(5) }));
    await usersService.updateProfile(USER_ID, { country: 'GE' });
    expect(updateMock).toHaveBeenCalledTimes(1);

    await expect(usersService.updateProfile(USER_ID, { country: 'AR' })).rejects.toMatchObject({
      statusCode: 409,
      details: { field: 'country', reason: 'affiliation_cooldown' },
    });
  });

  it('refuses before any other field is written', async () => {
    getByIdMock.mockResolvedValue(makeUser({ club_changed_at: daysAgo(1) }));
    await expect(
      usersService.updateProfile(USER_ID, { favoriteClub: 'Real Madrid CF', preferredLanguage: 'es' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(changeNicknameInTxMock).not.toHaveBeenCalled();
  });
});

describe('racing switches', () => {
  it('reports the lock when another request switched between the check and the write', async () => {
    getByIdMock
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser({ country: 'AR', country_changed_at: daysAgo(0) }));
    updateMock.mockResolvedValueOnce(null);
    await expect(usersService.updateProfile(USER_ID, { country: 'BR' })).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'affiliation_cooldown' },
    });
  });
});
