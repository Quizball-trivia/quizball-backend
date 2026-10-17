import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const cache = vi.hoisted(() => ({
  getOrLoadJson: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()),
  deleteJsonCacheKeys: vi.fn(async () => {}),
}));
vi.mock('../../src/core/json-cache.js', () => cache);

const repo = vi.hoisted(() => ({
  listLeaderboard: vi.fn(async () => []),
  getUserRank: vi.fn(async () => ({ rank: 4, total: 40, trendWins: 0, trendTotal: 0 })),
  getNextAbove: vi.fn(async () => ({ username: 'Rival', points: 900 })),
}));
vi.mock('../../src/modules/ranked/ranked.repo.js', () => ({ rankedRepo: repo }));

const { invalidateAffiliationRanks, rankedBoardCacheKey, rankedUserRankKeys } = await import(
  '../../src/modules/leaderboards/rank-cache.js'
);
const { rankedService } = await import('../../src/modules/ranked/ranked.service.js');

const GEORGIA = { kind: 'country', country: 'GE' } as const;

// Keys written by the release that ranked bots among real players on country and club boards.
const PRE_BOTS_LAST_PREFIXES = ['ranked:leaderboard:v2:', 'ranked:next-above:v1:', 'ranked:user-rank:v3:'];

const keysRead = () => cache.getOrLoadJson.mock.calls.map(([key]) => key);

beforeEach(() => vi.clearAllMocks());

describe('ranked board cache keys across a rolling deploy', () => {
  it('never reads a list, next target or own rank cached in the old order', async () => {
    await rankedService.getLeaderboard(50, 0, GEORGIA);
    await rankedService.getUserRank('user-1', GEORGIA);

    expect(keysRead()).toEqual([
      rankedBoardCacheKey.list(GEORGIA, 50, 0),
      expect.stringMatching(/^ranked:user-rank:v4:country:GE:user-1$/),
      rankedBoardCacheKey.nextAbove('user-1', GEORGIA),
    ]);
    for (const key of keysRead()) {
      for (const prefix of PRE_BOTS_LAST_PREFIXES) expect(key.startsWith(prefix)).toBe(false);
    }
  });

  it('clears the old own-rank key too, so a replica still on it does not keep a stale rank', async () => {
    expect(rankedUserRankKeys('user-1', GEORGIA)).toEqual([
      'ranked:user-rank:v4:country:GE:user-1',
      'ranked:user-rank:v3:country:GE:user-1',
    ]);

    await invalidateAffiliationRanks('user-1', [GEORGIA]);
    expect(cache.deleteJsonCacheKeys).toHaveBeenCalledWith(expect.arrayContaining([
      'ranked:user-rank:v4:country:GE:user-1',
      'ranked:user-rank:v3:country:GE:user-1',
    ]));
  });
});
