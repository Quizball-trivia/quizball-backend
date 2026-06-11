/**
 * Recent-category exclusion for ranked draft candidate selection.
 *
 * Given the available category pool and the players' recently played
 * categories, decide which pool entries to exclude so players see as many
 * fresh categories as possible — while GUARANTEEING that at least
 * `minRemaining` categories survive whenever the pool itself has that many.
 *
 * Fallback rule (small pools): the exclusion list is reduced starting from
 * the OLDEST recently played categories; the newest stay excluded as a
 * priority, so repeats are pushed as far back as possible.
 *
 * Pure + synchronous so the trimming rules are unit-testable without a DB.
 */

export interface RecentCategoryEntry {
  categoryId: string;
  /** Epoch ms of when the category was last played (by any of the users). */
  playedAtMs: number;
}

/**
 * Build the set of category ids to exclude from `poolIds`.
 *
 * - `recents` may contain the same category multiple times (two players, or
 *   unmerged rows); the NEWEST timestamp wins, so a category one player just
 *   played is treated as fresh-played even if the other played it long ago.
 * - Recents not present in the pool are ignored (they cannot reduce it).
 * - At most `poolIds.length - minRemaining` entries are excluded; when the
 *   limit binds, the newest-played categories keep their exclusion priority.
 */
export function buildRecentExclusionSet(params: {
  poolIds: readonly string[];
  recents: readonly RecentCategoryEntry[];
  minRemaining: number;
}): Set<string> {
  const { poolIds, recents, minRemaining } = params;
  const poolSet = new Set(poolIds);

  // Merge duplicates: newest played_at wins per category.
  const newestByCategory = new Map<string, number>();
  for (const entry of recents) {
    if (!poolSet.has(entry.categoryId)) continue;
    const current = newestByCategory.get(entry.categoryId);
    if (current === undefined || entry.playedAtMs > current) {
      newestByCategory.set(entry.categoryId, entry.playedAtMs);
    }
  }

  const maxExcludable = Math.max(0, poolSet.size - Math.max(0, minRemaining));
  if (newestByCategory.size <= maxExcludable) {
    return new Set(newestByCategory.keys());
  }

  // Too many exclusions for the pool: keep only the newest `maxExcludable`
  // (drop exclusions starting from the oldest played).
  const newestFirst = [...newestByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxExcludable)
    .map(([categoryId]) => categoryId);
  return new Set(newestFirst);
}
