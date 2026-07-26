import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

// Nickname change limits: 2 free changes, then a rolling 30-day cooldown.
// The signup name is free (one-shot), case-only edits are free, and an OAuth
// identity name must never be published as a "previously known as" entry.

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
  rankedRepo: { getProfile: vi.fn().mockResolvedValue(null) },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { getUserRank: vi.fn().mockResolvedValue(null) },
  tierFromRp: () => 'Academy',
}));

vi.mock('../../src/modules/stats/stats.service.js', () => ({
  statsService: {
    getUserStatsSummary: vi.fn().mockResolvedValue({
      ranked: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
      friendly: { gamesPlayed: 0, wins: 0, losses: 0, draws: 0, winRate: 0 },
    }),
    getHeadToHead: vi.fn().mockResolvedValue(null),
  },
}));

const USER_ID = 'user-1';

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: 'p@example.com',
    role: 'user',
    nickname: 'OldName',
    country: 'GE',
    avatar_url: null,
    avatar_customization: null,
    favorite_club: null,
    preferred_language: 'ka',
    onboarding_complete: true,
    total_xp: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Captures the params handed to changeNicknameInTx for the last call. */
function lastChangeCall() {
  return changeNicknameInTxMock.mock.calls.at(-1)?.[0] as {
    oldNickname: string | null;
    newNickname: string;
    changedBy: string;
    counted: boolean;
  };
}

describe('nickname change limits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getByIdMock.mockResolvedValue(makeUser());
    updateMock.mockResolvedValue(makeUser());
    isNicknameTakenMock.mockResolvedValue(false);
    isNicknameReservedMock.mockResolvedValue(false);
    hasConsumedSignupNamingMock.mockResolvedValue(true);
    getIdentityDerivedNicknameMock.mockResolvedValue(null);
    getPublicNicknameHistoryMock.mockResolvedValue([]);
    getNicknameQuotaMock.mockResolvedValue({ countedChanges: 0, nextChangeAt: null });
    changeNicknameInTxMock.mockImplementation(async (p: { newNickname: string }) =>
      makeUser({ nickname: p.newNickname })
    );
  });

  describe('signup exemption', () => {
    it('does not count the first name for an email signup (nickname starts NULL)', async () => {
      getByIdMock.mockResolvedValue(makeUser({ nickname: null, onboarding_complete: false }));
      hasConsumedSignupNamingMock.mockResolvedValue(false);
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'ChosenHandle' });

      expect(lastChangeCall()).toMatchObject({ changedBy: 'signup', counted: false });
    });

    it('does not count the first name for an OAuth signup (nickname pre-filled, NOT null)', async () => {
      // The regression this design exists to prevent: gating on `nickname IS NULL`
      // would bill a social signup for their first real handle.
      getByIdMock.mockResolvedValue(
        makeUser({ nickname: 'Giorgi Beradze', onboarding_complete: false })
      );
      hasConsumedSignupNamingMock.mockResolvedValue(false);
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'ChosenHandle' });

      expect(lastChangeCall()).toMatchObject({ changedBy: 'signup', counted: false });
    });

    it('stays free even when onboarding is finished days later (no time bound)', async () => {
      getByIdMock.mockResolvedValue(
        makeUser({
          nickname: null,
          onboarding_complete: false,
          created_at: '2026-01-01T00:00:00.000Z', // long ago
        })
      );
      hasConsumedSignupNamingMock.mockResolvedValue(false);
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'LateFinisher' });

      expect(lastChangeCall().counted).toBe(false);
    });

    it('is ONE-SHOT: a second pre-onboarding rename is counted', async () => {
      // Guards the defect where "zero counted rows" was used as the gate: an
      // uncounted row never increments that total, so every pre-completion
      // rename would have stayed free forever.
      getByIdMock.mockResolvedValue(makeUser({ onboarding_complete: false }));
      hasConsumedSignupNamingMock.mockResolvedValue(true); // pass already consumed
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'SecondTry' });

      expect(lastChangeCall()).toMatchObject({ changedBy: 'user', counted: true });
    });
  });

  describe('OAuth real-name privacy', () => {
    it('never publishes the identity-derived name as a previous nickname', async () => {
      // User kept their OAuth real name through onboarding, then renames: the
      // change still counts, but the real name must not become old_nickname.
      getByIdMock.mockResolvedValue(makeUser({ nickname: 'Giorgi Beradze' }));
      getIdentityDerivedNicknameMock.mockResolvedValue('Giorgi Beradze');
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'RealHandle' });

      const call = lastChangeCall();
      expect(call.oldNickname).toBeNull();
      expect(call.counted).toBe(true);
    });

    it('still records a normal previous nickname when it is not identity-derived', async () => {
      getByIdMock.mockResolvedValue(makeUser({ nickname: 'ChosenHandle' }));
      getIdentityDerivedNicknameMock.mockResolvedValue('Giorgi Beradze');
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'NewHandle' });

      expect(lastChangeCall().oldNickname).toBe('ChosenHandle');
    });
  });

  describe('no-op and case-only edits', () => {
    it('treats a byte-identical resubmit as a no-op (no history, no quota)', async () => {
      getByIdMock.mockResolvedValue(makeUser({ nickname: 'SameName' }));
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'SameName' });

      expect(changeNicknameInTxMock).not.toHaveBeenCalled();
    });

    it('does not charge for a case-only edit', async () => {
      getByIdMock.mockResolvedValue(makeUser({ nickname: 'nika' }));
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, { nickname: 'NIKA' });

      expect(lastChangeCall()).toMatchObject({ newNickname: 'NIKA', counted: false });
    });
  });

  describe('quota enforcement', () => {
    it('rejects with NICKNAME_CHANGE_COOLDOWN when the DB gate declines', async () => {
      // The repo returns null when its gated INSERT matched no rows.
      changeNicknameInTxMock.mockResolvedValue(null);
      getNicknameQuotaMock.mockResolvedValue({
        countedChanges: 2,
        nextChangeAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      });
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await expect(
        usersService.updateProfile(USER_ID, { nickname: 'ThirdName' })
      ).rejects.toMatchObject({ code: 'NICKNAME_CHANGE_COOLDOWN' });
    });

    it('surfaces nextAvailableAt and remainingSeconds in the error details', async () => {
      const nextAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
      changeNicknameInTxMock.mockResolvedValue(null);
      getNicknameQuotaMock.mockResolvedValue({ countedChanges: 2, nextChangeAt: nextAt });
      const { usersService } = await import('../../src/modules/users/users.service.js');

      const err = await usersService
        .updateProfile(USER_ID, { nickname: 'ThirdName' })
        .catch((e: unknown) => e as { details: Record<string, unknown> });

      expect(err.details).toMatchObject({ changeCount: 2, nextAvailableAt: nextAt });
      expect(err.details.remainingSeconds).toBeGreaterThan(0);
    });

    it('admin self-rename is still counted (no privilege bypass)', async () => {
      // requesterRole on PUT /me is the CALLER's own role, so treating it as an
      // admin override would grant admins unlimited free self-renames.
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(
        USER_ID,
        { nickname: 'AdminHandle' },
        { requesterRole: 'admin' }
      );

      expect(lastChangeCall()).toMatchObject({ changedBy: 'user', counted: true });
    });
  });

  describe('freed-name reservation', () => {
    it('rejects a nickname another user vacated recently', async () => {
      isNicknameReservedMock.mockResolvedValue(true);
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await expect(
        usersService.updateProfile(USER_ID, { nickname: 'FamousName' })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(changeNicknameInTxMock).not.toHaveBeenCalled();
    });

    it('maps a lost unique-index race to a conflict, not a 500', async () => {
      // isNicknameTaken is a check-then-act: two users claiming the same name
      // both pass it and the loser trips uq_users_lower_nickname_real.
      changeNicknameInTxMock.mockRejectedValue(
        Object.assign(new Error('duplicate key value'), { code: '23505' })
      );
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await expect(
        usersService.updateProfile(USER_ID, { nickname: 'Contested' })
      ).rejects.toMatchObject({ code: 'CONFLICT', statusCode: 409 });
    });
  });

  describe('partial-write safety on rejection', () => {
    it('does not persist other profile fields when the rename is rejected', async () => {
      // Regression: the rename used to be applied AFTER usersRepo.update, so a
      // cooldown rejection committed `country` and then threw 400 — leaving the
      // DB changed, the response an error, and the user cache stale.
      changeNicknameInTxMock.mockResolvedValue(null);
      getNicknameQuotaMock.mockResolvedValue({
        countedChanges: 2,
        nextChangeAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await expect(
        usersService.updateProfile(USER_ID, { nickname: 'ThirdName', country: 'DE' })
      ).rejects.toMatchObject({ code: 'NICKNAME_CHANGE_COOLDOWN' });

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('does not issue a redundant users UPDATE for a nickname-only change', async () => {
      // The controller always sends all six profile keys, so a naive
      // Object.keys() check was always true and every rename wrote the row twice.
      const { usersService } = await import('../../src/modules/users/users.service.js');

      await usersService.updateProfile(USER_ID, {
        nickname: 'FreshName',
        country: undefined,
        avatarUrl: undefined,
        avatarCustomization: undefined,
        favoriteClub: undefined,
        preferredLanguage: undefined,
      });

      expect(changeNicknameInTxMock).toHaveBeenCalledTimes(1);
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('public history exposure', () => {
    it('hides previous nicknames for banned users', async () => {
      getByIdMock.mockResolvedValue(makeUser({ is_banned: true }));
      getPublicNicknameHistoryMock.mockResolvedValue([
        { nickname: 'ShouldNotAppear', changedAt: '2026-07-01T00:00:00.000Z' },
      ]);
      const { usersService } = await import('../../src/modules/users/users.service.js');

      const profile = await usersService.getPublicProfile(USER_ID, 'viewer-id');

      expect(profile.previousNicknames).toEqual([]);
      expect(getPublicNicknameHistoryMock).not.toHaveBeenCalled();
    });
  });
});
