import { normalizeName } from '../footballers/footballers.text.js';
import type { Universe } from '../footballers/footballers.universe.js';

/** Pure: what a "that was right" report is about, decided by the same matcher that refused the text. */

/** What a refused text was about, as the review needs it. */
export interface Refusal { release: string; subject: string | null; resolvedPid: string | null }

/**
 * "Played for both": a text the pair does not accept. Null when the pair accepts it (nothing to report) or the text
 * has nothing to read. A text that names a known footballer is a claim about the clubs; any other is a claim about
 * the name.
 */
export function refusedForPair(universe: Universe, pair: { a: { key: string }; b: { key: string }; accepted: readonly string[] }, text: string): Refusal | null {
  if (!normalizeName(text) || universe.pickAmong(text, pair.accepted) !== null) return null;
  return { release: universe.releaseId, subject: [pair.a.key, pair.b.key].sort().join('|'), resolvedPid: universe.resolve(text)[0] ?? null };
}

/** The name chain: a text the release does not know as a footballer. Null when it does (the refusal was about the letter or a repeat). */
export function refusedName(universe: Universe, text: string): Refusal | null {
  if (!normalizeName(text) || universe.resolve(text).length > 0) return null;
  return { release: universe.releaseId, subject: null, resolvedPid: null };
}
