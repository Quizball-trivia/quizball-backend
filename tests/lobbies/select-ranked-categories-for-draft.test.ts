import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const listRecentMock = vi.hoisted(() => vi.fn());
const recordPlayedMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listAllRankedEligibleCategories: vi.fn(),
  },
}));

vi.mock('../../src/modules/user-recent-categories/user-recent-categories.repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/user-recent-categories/user-recent-categories.repo.js')>();
  return {
    ...actual,
    userRecentCategoriesRepo: {
      listRecentCategoriesForUsers: listRecentMock,
      recordPlayedCategoryForUsers: recordPlayedMock,
    },
  };
});

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { ensureProfile: vi.fn() },
}));

import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';
import { invalidateCategoryCache, lobbiesService } from '../../src/modules/lobbies/lobbies.service.js';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

function poolRow(id: string) {
  return { id, name: { en: `Category ${id}` }, icon: null, image_url: null };
}

function makePool(size: number): Array<ReturnType<typeof poolRow>> {
  return Array.from({ length: size }, (_, i) => poolRow(`cat-${i + 1}`));
}

function recentRow(userId: string, categoryId: string, playedAtIso: string) {
  return { user_id: userId, category_id: categoryId, played_at: new Date(playedAtIso) };
}

describe('lobbiesService.selectRankedCategoriesForDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCategoryCache();
    listRecentMock.mockResolvedValue([]);
  });

  it('excludes the combined recents of both matched players', async () => {
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(30));
    listRecentMock.mockResolvedValue([
      recentRow(USER_A, 'cat-1', '2026-06-10T10:00:00Z'),
      recentRow(USER_A, 'cat-2', '2026-06-10T09:00:00Z'),
      recentRow(USER_B, 'cat-3', '2026-06-10T08:00:00Z'),
      recentRow(USER_B, 'cat-2', '2026-06-09T08:00:00Z'),
    ]);

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A, USER_B],
    });

    expect(listRecentMock).toHaveBeenCalledWith([USER_A, USER_B], 'ranked');
    expect(result.categories).toHaveLength(3);
    expect(result.recentFilterApplied).toBe(true);
    const ids = result.categories.map((c) => c.id);
    expect(ids).not.toContain('cat-1');
    expect(ids).not.toContain('cat-2');
    expect(ids).not.toContain('cat-3');
  });

  it('bot match: looks up recents only for the human user', async () => {
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(10));
    listRecentMock.mockResolvedValue([recentRow(USER_A, 'cat-5', '2026-06-10T10:00:00Z')]);

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A],
    });

    expect(listRecentMock).toHaveBeenCalledTimes(1);
    expect(listRecentMock).toHaveBeenCalledWith([USER_A], 'ranked');
    expect(result.categories.map((c) => c.id)).not.toContain('cat-5');
  });

  it('skips the recents lookup entirely when there are no user ids', async () => {
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(5));

    const result = await lobbiesService.selectRankedCategoriesForDraft({ count: 3, userIds: [] });

    expect(listRecentMock).not.toHaveBeenCalled();
    expect(result.categories).toHaveLength(3);
    expect(result.recentFilterApplied).toBe(false);
  });

  it('always returns 3 when the pool has at least 3 — trims exclusions oldest-first', async () => {
    // Pool of 4, recents cover all 4 => only 1 may stay excluded (the newest).
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(4));
    listRecentMock.mockResolvedValue([
      recentRow(USER_A, 'cat-1', '2026-06-10T10:00:00Z'), // newest — stays excluded
      recentRow(USER_A, 'cat-2', '2026-06-09T10:00:00Z'),
      recentRow(USER_B, 'cat-3', '2026-06-08T10:00:00Z'),
      recentRow(USER_B, 'cat-4', '2026-06-07T10:00:00Z'),
    ]);

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A, USER_B],
    });

    expect(result.categories).toHaveLength(3);
    expect(result.categories.map((c) => c.id).sort()).toEqual(['cat-2', 'cat-3', 'cat-4']);
    expect(result.recentFilterApplied).toBe(true);
  });

  it('fail-open: recents lookup failure still returns 3 categories unfiltered', async () => {
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(5));
    listRecentMock.mockRejectedValue(new Error('db down'));

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A, USER_B],
    });

    expect(result.categories).toHaveLength(3);
    expect(result.recentFilterApplied).toBe(false);
  });

  it('respects hard exclusions (halftime) on top of recents', async () => {
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(10));
    listRecentMock.mockResolvedValue([recentRow(USER_A, 'cat-9', '2026-06-10T10:00:00Z')]);

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A],
      excludeCategoryIds: ['cat-1', 'cat-2', 'cat-3'],
    });

    const ids = result.categories.map((c) => c.id);
    expect(ids).toHaveLength(3);
    for (const hard of ['cat-1', 'cat-2', 'cat-3', 'cat-9']) {
      expect(ids).not.toContain(hard);
    }
  });

  it('hard exclusions are never relaxed even when the pool gets tiny', async () => {
    // Pool 4, hard-exclude 2 => only 2 candidates can ever be returned.
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(makePool(4));
    listRecentMock.mockResolvedValue([recentRow(USER_A, 'cat-3', '2026-06-10T10:00:00Z')]);

    const result = await lobbiesService.selectRankedCategoriesForDraft({
      count: 3,
      userIds: [USER_A],
      excludeCategoryIds: ['cat-1', 'cat-2'],
    });

    // Recents exclusion is fully relaxed (pool of 2 < count) but hard ones hold.
    expect(result.categories.map((c) => c.id).sort()).toEqual(['cat-3', 'cat-4']);
  });
});
