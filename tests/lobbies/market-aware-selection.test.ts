import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const forPlayersMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listAllRankedEligibleCategories: vi.fn(),
    listAllValidCategories: vi.fn(),
  },
}));

vi.mock('../../src/modules/user-recent-categories/user-recent-categories.repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/user-recent-categories/user-recent-categories.repo.js')>();
  return {
    ...actual,
    userRecentCategoriesRepo: {
      listRecentCategoriesForUsers: vi.fn().mockResolvedValue([]),
      recordPlayedCategoryForUsers: vi.fn(),
    },
  };
});

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { ensureProfile: vi.fn() },
}));

vi.mock('../../src/modules/markets/markets.service.js', () => ({
  marketsService: { forPlayers: forPlayersMock, forCountry: vi.fn(), list: vi.fn() },
  invalidateMarketsCache: vi.fn(),
}));

import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';
import { invalidateCategoryCache, lobbiesService } from '../../src/modules/lobbies/lobbies.service.js';

function row(id: string, market: string | null = null, marketOnly = false) {
  return { id, name: { en: id }, icon: null, image_url: null, market, market_only: marketOnly };
}

// Three categories for everyone, one that is only for Georgia.
const POOL = [row('all-1'), row('all-2'), row('all-3'), row('ge-only', 'ge', true)];

describe('category selection follows the players\' markets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCategoryCache();
    (lobbiesRepo.listAllRankedEligibleCategories as ReturnType<typeof vi.fn>).mockResolvedValue(POOL);
    (lobbiesRepo.listAllValidCategories as ReturnType<typeof vi.fn>).mockResolvedValue(POOL);
  });

  it('ranked draft: a market-only category is offered when every player is in the market', async () => {
    forPlayersMock.mockResolvedValue(['ge', 'ge']);

    const { categories } = await lobbiesService.selectRankedCategoriesForDraft({ count: 4, userIds: ['a', 'b'] });

    expect(forPlayersMock).toHaveBeenCalledWith(['a', 'b']);
    expect(categories.map((category) => category.id).sort()).toEqual(['all-1', 'all-2', 'all-3', 'ge-only']);
  });

  it('ranked draft: it is never offered when one player is outside the market', async () => {
    forPlayersMock.mockResolvedValue(['ge', 'tr']);

    for (let round = 0; round < 50; round++) {
      const { categories } = await lobbiesService.selectRankedCategoriesForDraft({ count: 3, userIds: ['a', 'b'] });
      expect(categories).toHaveLength(3);
      expect(categories.map((category) => category.id)).not.toContain('ge-only');
    }
  });

  it('ranked draft: a market-only category does not count toward the pool the recents filter protects', async () => {
    // Only three categories may be offered to these players, so all three are
    // drawn even though the pool holds four.
    forPlayersMock.mockResolvedValue([null]);

    const { categories } = await lobbiesService.selectRankedCategoriesForDraft({ count: 3, userIds: ['a'] });

    expect(categories.map((category) => category.id).sort()).toEqual(['all-1', 'all-2', 'all-3']);
  });

  it('every other selector leaves market-only categories out for players outside the market', async () => {
    forPlayersMock.mockResolvedValue(['uk']);

    const ids = (categories: Array<{ id: string }>) => categories.map((category) => category.id);
    expect(ids(await lobbiesService.selectRandomCategories(10, 5, 'possession', ['a']))).not.toContain('ge-only');
    expect(ids(await lobbiesService.selectRandomCategoriesExcluding(10, [], 'possession', ['a']))).not.toContain('ge-only');
    expect(ids(await lobbiesService.selectRandomRankedCategories(10, ['a']))).not.toContain('ge-only');
    expect(ids(await lobbiesService.selectRandomRankedCategoriesExcluding(10, [], ['a']))).not.toContain('ge-only');
  });

  it('every other selector offers them to players inside the market', async () => {
    forPlayersMock.mockResolvedValue(['ge']);

    const ids = (categories: Array<{ id: string }>) => categories.map((category) => category.id);
    expect(ids(await lobbiesService.selectRandomCategories(10, 5, 'possession', ['a']))).toContain('ge-only');
    expect(ids(await lobbiesService.selectRandomCategoriesExcluding(10, ['all-1'], 'possession', ['a'])).sort())
      .toEqual(['all-2', 'all-3', 'ge-only']);
    expect(ids(await lobbiesService.selectRandomRankedCategories(10, ['a']))).toContain('ge-only');
    expect(ids(await lobbiesService.selectRandomRankedCategoriesExcluding(10, [], ['a']))).toContain('ge-only');
  });

  it('with no players given, only content for all markets is drawn', async () => {
    forPlayersMock.mockResolvedValue([]);

    const categories = await lobbiesService.selectRandomCategories(10);

    expect(categories.map((category) => category.id).sort()).toEqual(['all-1', 'all-2', 'all-3']);
  });

  it('the pool for everyone leaves market-only categories out', async () => {
    await expect(lobbiesService.listRankedCategoryIdsForAllMarkets()).resolves.toEqual(['all-1', 'all-2', 'all-3']);
  });
});
