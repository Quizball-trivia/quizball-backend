/**
 * Selection shaping for daily sets: a difficulty curve (Money Drop) and an
 * answer balance (True or False). Pure functions so the rules are testable
 * without the session builder.
 */

const DIFFICULTY_RANK: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

/** Easy → medium → hard; unknown difficulties sort last. Stable within a tier (keeps the random pick order). */
export function orderByDifficultyAscending<T>(items: T[], difficultyOf: (item: T) => string): T[] {
  const rank = (item: T) => DIFFICULTY_RANK[difficultyOf(item)] ?? Object.keys(DIFFICULTY_RANK).length;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Money Drop climbs: roughly a third easy openers, a third medium, a third hard
 * finishers, with at least one easy warm-up. A soft quota — pickChallengeQuestions
 * fills empty tiers from whatever the pool has.
 */
export function moneyDropDifficultyQuota(count: number): Record<string, number> {
  if (count <= 0) return { easy: 0, medium: 0, hard: 0 };
  const easy = Math.max(1, Math.round(count * 0.35));
  const hard = Math.min(count - easy, Math.round(count * 0.3));
  return { easy, medium: Math.max(0, count - easy - hard), hard };
}

/** Fewest statements of each answer a True or False set should carry: none of a set is ever all-true or all-false. */
export function minimumPerAnswer(count: number): number {
  return count >= 2 ? Math.max(1, Math.floor(count / 3)) : 0;
}

/**
 * Swaps picked items of the over-represented answer for unpicked pool items of the
 * missing answer until each answer appears at least `minEach` times. Candidates are
 * tried in `rankOf` order (lower first, e.g. not recently served). Soft: when the pool
 * has no more of the missing answer, the set is returned as balanced as it can be.
 */
export function rebalanceBinaryAnswers<T>(
  picked: T[],
  pool: T[],
  options: {
    idOf: (item: T) => string;
    answerOf: (item: T) => boolean;
    minEach: number;
    rankOf?: (item: T) => number;
  }
): T[] {
  const { idOf, answerOf, minEach, rankOf } = options;
  const result = [...picked];
  const usedIds = new Set(result.map(idOf));
  const countOf = (answer: boolean) => result.filter((item) => answerOf(item) === answer).length;

  for (const missing of [true, false]) {
    if (countOf(missing) >= minEach) continue;
    const candidates = pool
      .filter((item) => answerOf(item) === missing && !usedIds.has(idOf(item)))
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (rankOf?.(a.item) ?? 0) - (rankOf?.(b.item) ?? 0) || a.index - b.index)
      .map(({ item }) => item);

    for (const candidate of candidates) {
      if (countOf(missing) >= minEach || countOf(!missing) <= minEach) break;
      let replaceAt = -1;
      for (let index = result.length - 1; index >= 0; index -= 1) {
        if (answerOf(result[index]) !== missing) { replaceAt = index; break; }
      }
      if (replaceAt < 0) break;
      usedIds.delete(idOf(result[replaceAt]));
      result[replaceAt] = candidate;
      usedIds.add(idOf(candidate));
    }
  }

  return result;
}
