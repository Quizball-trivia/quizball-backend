import { describe, expect, it } from 'vitest';

import {
  buildRecentExclusionSet,
  type RecentCategoryEntry,
} from '../../src/modules/lobbies/recent-category-filter.js';

const POOL_30 = Array.from({ length: 30 }, (_, i) => `cat-${i + 1}`);

function recent(categoryId: string, playedAtMs: number): RecentCategoryEntry {
  return { categoryId, playedAtMs };
}

describe('buildRecentExclusionSet', () => {
  it('excludes the union of both players recents (task example)', () => {
    // Pool of 30, A played [Argentina, Brazil, Messi], B played [Germany, Brazil, Maradona]
    const pool = ['argentina', 'brazil', 'messi', 'germany', 'maradona', ...POOL_30.slice(0, 25)];
    const recents = [
      recent('argentina', 100),
      recent('brazil', 200),
      recent('messi', 300),
      recent('germany', 150),
      recent('brazil', 50),
      recent('maradona', 250),
    ];
    const excluded = buildRecentExclusionSet({ poolIds: pool, recents, minRemaining: 3 });
    expect(excluded).toEqual(new Set(['argentina', 'brazil', 'messi', 'germany', 'maradona']));
  });

  it('returns an empty set when there are no recents', () => {
    expect(buildRecentExclusionSet({ poolIds: POOL_30, recents: [], minRemaining: 3 }).size).toBe(0);
  });

  it('ignores recents that are not in the pool', () => {
    const excluded = buildRecentExclusionSet({
      poolIds: ['a', 'b', 'c', 'd'],
      recents: [recent('zz', 100), recent('a', 50)],
      minRemaining: 3,
    });
    expect(excluded).toEqual(new Set(['a']));
  });

  it('trims exclusions starting from the OLDEST when pool would drop below minRemaining', () => {
    // Pool of 5, 4 recents, need 3 remaining => only 2 can stay excluded.
    const pool = ['a', 'b', 'c', 'd', 'e'];
    const recents = [
      recent('a', 10), // oldest — un-excluded first
      recent('b', 40), // newest — keeps exclusion priority
      recent('c', 30),
      recent('d', 20), // second oldest — un-excluded second
    ];
    const excluded = buildRecentExclusionSet({ poolIds: pool, recents, minRemaining: 3 });
    expect(excluded).toEqual(new Set(['b', 'c']));
  });

  it('excludes nothing when the pool only has exactly minRemaining categories', () => {
    const excluded = buildRecentExclusionSet({
      poolIds: ['a', 'b', 'c'],
      recents: [recent('a', 1), recent('b', 2), recent('c', 3)],
      minRemaining: 3,
    });
    expect(excluded.size).toBe(0);
  });

  it('excludes nothing when the pool is smaller than minRemaining', () => {
    const excluded = buildRecentExclusionSet({
      poolIds: ['a', 'b'],
      recents: [recent('a', 1)],
      minRemaining: 3,
    });
    expect(excluded.size).toBe(0);
  });

  it('uses the NEWEST timestamp when both players played the same category', () => {
    // 4-category pool, room for 1 exclusion. Category 'a' is old for player 1
    // (t=5) but fresh for player 2 (t=100) — the merged entry must win over
    // 'b' (t=50).
    const pool = ['a', 'b', 'c', 'd'];
    const recents = [recent('a', 5), recent('b', 50), recent('a', 100)];
    const excluded = buildRecentExclusionSet({ poolIds: pool, recents, minRemaining: 3 });
    expect(excluded).toEqual(new Set(['a']));
  });

  it('can exclude the whole recents list on a big pool (30-category event)', () => {
    // 10 recents per user is the cap; 2 users => up to 20 exclusions, pool 30
    // leaves 10 fresh — all 20 stay excluded.
    const recents = POOL_30.slice(0, 20).map((id, i) => recent(id, i));
    const excluded = buildRecentExclusionSet({ poolIds: POOL_30, recents, minRemaining: 3 });
    expect(excluded.size).toBe(20);
    expect(POOL_30.filter((id) => !excluded.has(id)).length).toBe(10);
  });

  it('handles minRemaining 0 / negative defensively', () => {
    const excluded = buildRecentExclusionSet({
      poolIds: ['a', 'b'],
      recents: [recent('a', 1), recent('b', 2)],
      minRemaining: 0,
    });
    expect(excluded).toEqual(new Set(['a', 'b']));
  });
});
