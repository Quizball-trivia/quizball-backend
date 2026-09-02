import { createHash } from 'node:crypto';

export type FifaCardCandidate = {
  id: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'veryHard';
  edition: string;
  name: string;
  /** Most recent challenge_day this card was served (YYYY-MM-DD), or null if never. */
  last_served_day: string | null;
};

const fifaEditionNumber = (edition: string): number => {
  const parsed = Number.parseInt(edition.replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : 99;
};

/** "Older than FIFA 2020" — the daily wants >=5 of these per 10-card set. */
export const isPreFifa20 = (card: FifaCardCandidate): boolean => fifaEditionNumber(card.edition) < 20;

/**
 * Choose the day's FIFA-card set. For a 10-card round: 3 veryHard + 3 hard +
 * 4 medium/easy, with >=5 from pre-FIFA20 editions (2 old veryHard + 2 old hard
 * + 1 old medium/easy). Prefers never-served cards, then least-recently-served,
 * with a per-(salt, day) hash tie-break so the pick is deterministic yet rotates
 * daily; never repeats a player within a set. Quotas scale for smaller rounds,
 * and any shortfall backfills from the remaining pool so the round still fills.
 * Pure + DB-free (candidates are fetched by the repo). Mirrors
 * frontend-web-next/scripts/fifa/DAILY-SELECTION.md.
 */
export function selectDailyFifaCardIds(
  candidates: FifaCardCandidate[],
  count: number,
  salt: string,
  day: string,
): string[] {
  const hashOf = new Map(
    candidates.map((card) => [card.id, createHash('md5').update(`${salt}:${day}:${card.id}`).digest('hex')]),
  );
  const byRotation = (a: FifaCardCandidate, b: FifaCardCandidate): number => {
    const lastA = a.last_served_day ?? ''; // '' (never served) sorts first
    const lastB = b.last_served_day ?? '';
    if (lastA !== lastB) return lastA < lastB ? -1 : 1;
    const hashA = hashOf.get(a.id) ?? '';
    const hashB = hashOf.get(b.id) ?? '';
    return hashA < hashB ? -1 : hashA > hashB ? 1 : 0;
  };

  const usedIds = new Set<string>();
  const usedNames = new Set<string>(); // one card per player across the whole set
  const chosen: string[] = [];

  const drawTier = (tiers: FifaCardCandidate['difficulty'][], want: number, oldQuota: number): void => {
    const pool = candidates.filter(
      (card) => tiers.includes(card.difficulty) && !usedIds.has(card.id) && !usedNames.has(card.name),
    );
    const old = pool.filter(isPreFifa20).sort(byRotation);
    const fresh = pool.filter((card) => !isPreFifa20(card)).sort(byRotation);
    let taken = 0;
    const takeFrom = (list: FifaCardCandidate[], limit: number): void => {
      for (const card of list) {
        if (taken >= limit) break;
        if (usedNames.has(card.name)) continue;
        usedIds.add(card.id);
        usedNames.add(card.name);
        chosen.push(card.id);
        taken += 1;
      }
    };
    takeFrom(old, Math.min(oldQuota, want)); // prefer old cards up to the quota
    takeFrom(fresh, want); // fill the rest with newer editions
    if (taken < want) takeFrom([...old, ...fresh].sort(byRotation), want); // shallow tier: top up
  };

  const veryHardWant = Math.round(count * 0.3);
  const hardWant = Math.round(count * 0.3);
  const easyWant = count - veryHardWant - hardWant;
  drawTier(['veryHard'], veryHardWant, Math.min(veryHardWant, 2));
  drawTier(['hard'], hardWant, Math.min(hardWant, 2));
  drawTier(['medium', 'easy'], easyWant, Math.min(easyWant, 1));

  if (chosen.length < count) {
    const rest = candidates
      .filter((card) => !usedIds.has(card.id) && !usedNames.has(card.name))
      .sort(byRotation);
    for (const card of rest) {
      if (chosen.length >= count) break;
      usedIds.add(card.id);
      usedNames.add(card.name);
      chosen.push(card.id);
    }
  }

  // Deterministically shuffle so the three veryHard cards aren't served in a row.
  return chosen.sort((a, b) => {
    const hashA = hashOf.get(a) ?? '';
    const hashB = hashOf.get(b) ?? '';
    return hashA < hashB ? -1 : hashA > hashB ? 1 : 0;
  });
}
