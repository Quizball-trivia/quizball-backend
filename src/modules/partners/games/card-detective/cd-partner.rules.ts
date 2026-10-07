/** FIFA Card Detective rules for Freecroco (contract v1.2 §7.3), pinned here rather than read from the quizball.io
 *  daily so a change to the site's prices never changes what a partner play is worth. */

import { levenshtein, normalizeAnswer } from '../../../../realtime/possession-answer-matching.js';

export const CD_CARD_COUNT = 10;
export const CD_START_POINTS = 100;
export const CD_WRONG_GUESS_COST = 15;
export const CD_CLUE_COSTS = {
  rating: 25,
  club: 20,
  league: 15,
  nation: 10,
  position: 10,
  pac: 5,
  sho: 5,
  pas: 5,
  dri: 5,
  def: 5,
  phy: 5,
} as const;
export type CdClueKey = keyof typeof CD_CLUE_COSTS;
export const CD_CLUE_KEYS = Object.keys(CD_CLUE_COSTS) as CdClueKey[];
export const CD_STAT_KEYS = ['pac', 'sho', 'pas', 'dri', 'def', 'phy'] as const;
export type CdStatKey = (typeof CD_STAT_KEYS)[number];

/** A play nobody touches for this long is settled with the points earned so far (contract §7: leaving early). */
export const CD_IDLE_SECONDS = 10 * 60;

export function isClueKey(value: string): value is CdClueKey {
  return Object.prototype.hasOwnProperty.call(CD_CLUE_COSTS, value);
}

/**
 * The free starters: the position and two stats, the same rule as the web's freeCluesFor
 * (frontend src/features/fifa-universe/components/DetectiveCard.tsx), applied to the play's opaque card ref.
 */
export function freeCluesFor(ref: string): CdClueKey[] {
  let h = 7;
  for (const ch of ref) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const first = h % CD_STAT_KEYS.length;
  const second = (first + 1 + ((h >>> 8) % (CD_STAT_KEYS.length - 1))) % CD_STAT_KEYS.length;
  return ['position', CD_STAT_KEYS[first], CD_STAT_KEYS[second]];
}

const GEORGIAN_TO_LATIN: Record<string, string> = {
  ა: 'a', ბ: 'b', გ: 'g', დ: 'd', ე: 'e', ვ: 'v', ზ: 'z', თ: 't', ი: 'i',
  კ: 'k', ლ: 'l', მ: 'm', ნ: 'n', ო: 'o', პ: 'p', ჟ: 'zh', რ: 'r', ს: 's',
  ტ: 't', უ: 'u', ფ: 'p', ქ: 'k', ღ: 'gh', ყ: 'q', შ: 'sh', ჩ: 'ch', ც: 'ts',
  ძ: 'dz', წ: 'ts', ჭ: 'ch', ხ: 'kh', ჯ: 'j', ჰ: 'h',
};

/** Same folding as the web matcher (frontend src/features/mini-games/lib/matching.ts): Georgian → Latin, Turkish ı. */
export function normalizeCardName(value: string): string {
  let out = '';
  for (const ch of value) out += GEORGIAN_TO_LATIN[ch] ?? ch;
  return normalizeAnswer(out.replace(/ı/g, 'i').replace(/İ/g, 'i'));
}

// Name particles shared by many players: a guess of "de" or "van" must never name de Jong or van Dijk.
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'dos', 'das', 'del', 'della', 'ben', 'bin', 'jr', 'junior', 'mac']);

/**
 * Server-side version of the web's typo-tolerant name check, stricter where a prize is at stake: a single surname or
 * a full name with a typo or two counts, but not a fragment ("aldo" is not Ronaldo) and not a short particle.
 */
export function matchesCardName(input: string, accepted: string[]): boolean {
  const guess = normalizeCardName(input);
  if (!guess) return false;
  const allowed = guess.length < 5 ? 1 : guess.length > 8 ? 3 : 2;
  for (const answer of accepted) {
    const full = normalizeCardName(answer);
    if (!full) continue;
    if (guess === full) return true;
    if (guess.length < 3) continue;
    const tokens = full.split(' ').filter((t) => t.length >= 3 && !PARTICLES.has(t));
    for (const target of [full, ...tokens]) {
      // Short targets only match exactly: one edit away from a 3-letter surname is a different name.
      const tolerance = target.length < 4 ? 0 : allowed;
      if (Math.abs(target.length - guess.length) > tolerance) continue;
      if (levenshtein(guess, target) <= tolerance) return true;
    }
  }
  return false;
}
