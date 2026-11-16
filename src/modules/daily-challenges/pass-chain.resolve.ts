import { foldLatin } from '../../lib/latin-fold.js';
import { currentFootballerNames, type FootballerNames } from '../footballers/footballers.names.js';
import { normalizeAnswerString } from './answer-normalize.js';

export interface PassChainNamed {
  id: string;
  normalized_aliases: string[];
}

/** Where the chain stands: a name two players share is read as the one that fits this step. */
export interface PassChainStep<Row> {
  /** Shares a club or coach with the chain's current end. */
  links?: (row: Row) => boolean;
  /** Is the target or shares a club or coach with it. */
  reaches?: (row: Row) => boolean;
}

// Stored keys predate the folding of ø, ł, ı …: folded once per row, so both sides compare the same way.
const keysOf = new WeakMap<PassChainNamed, string[]>();
function keys(row: PassChainNamed): string[] {
  let found = keysOf.get(row);
  if (!found) keysOf.set(row, (found = row.normalized_aliases.map(foldLatin)));
  return found;
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * One player among several a name fits: the only one that links from the chain's end, else the only one of those that
 * also reaches the target. Anything else is unknown: never guess between two people.
 */
function fitting<Row extends PassChainNamed>(found: readonly Row[], step: PassChainStep<Row>): Row | null {
  const unique = [...new Map(found.map((row) => [row.id, row])).values()];
  if (unique.length <= 1) return unique[0] ?? null;
  if (!step.links) return null;
  const linking = unique.filter(step.links);
  if (linking.length === 1) return linking[0];
  if (linking.length === 0 || !step.reaches) return null;
  const reaching = linking.filter(step.reaches);
  return reaching.length === 1 ? reaching[0] : null;
}

/**
 * Same tolerance as the web answer matcher: an exact alias (or, failing that, a name the footballer release gives only
 * players of the pool), then a whole-word surname, then 1–2 typos on names ≥ 5 chars with a unique nearest. A name two
 * players share is read against the step (fitting); the tier decides even when that leaves it unknown. A text that is,
 * as typed, a footballer's name is never forgiven as a typo of another one.
 */
export function resolvePassChainPlayer<Row extends PassChainNamed>(
  players: readonly Row[],
  text: string,
  step: PassChainStep<Row> = {},
  names: FootballerNames | null = currentFootballerNames(),
): Row | null {
  const normalized = normalizeAnswerString(text);
  if (!normalized || normalized.length < 3) return null;
  const input = foldLatin(normalized);
  const exact = players.filter((p) => keys(p).includes(input));
  if (exact.length > 0) return fitting(exact, step);
  // A name the release gives only players of the pool; one it also gives an outsider may mean the outsider.
  const holders = names?.holders(text) ?? [];
  if (holders.length > 0) {
    const ids = new Set(holders);
    const named = players.filter((p) => ids.has(p.id));
    if (named.length === ids.size) return fitting(named, step);
  }
  // Several words inside a longer name, or a typo, never stand for a text that is somebody's own name.
  const contained = holders.length > 0 && input.includes(' ') ? [] : players.filter((p) => keys(p).some((alias) => alias.startsWith(`${input} `) || alias.endsWith(` ${input}`) || alias.includes(` ${input} `)));
  if (contained.length > 0) return fitting(contained, step);
  if (input.length < 4 || holders.length > 0) return null;
  const allowed = (target: string) => (target.length < 5 ? 0 : target.length > 6 ? 2 : 1);
  let best: { rows: Row[]; distance: number } | null = null;
  for (const p of players) {
    for (const alias of keys(p)) {
      const max = allowed(alias);
      if (max === 0 || Math.abs(alias.length - input.length) > max) continue;
      const distance = levenshtein(input, alias);
      if (distance > max) continue;
      if (!best || distance < best.distance) best = { rows: [p], distance };
      else if (distance === best.distance) best.rows.push(p);
    }
  }
  // Two different names equally near is a guess, whatever the step: only a unique nearest counts.
  return best && new Set(best.rows.map((row) => row.id)).size === 1 ? best.rows[0] : null;
}
