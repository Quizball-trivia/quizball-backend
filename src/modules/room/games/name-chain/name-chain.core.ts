import type { Universe } from '../../../footballers/footballers.universe.js';

/**
 * The chain itself, shared by the room game and the solo daily: which footballer a text names on a letter, and which
 * well-known footballer the game supplies to start a chain. Pure: randomness comes from a seed and a counter, so every
 * replica (and every replay) picks the same names.
 */
export type Verdict = 'ok' | 'unknown' | 'letter' | 'repeat';

/** A starting name must leave real choice: at least this many unused footballers on its last letter. */
const MIN_OPTIONS = 8;
/** How well known a starting name must be. */
export const START_MIN_FAME = 40;

/** mulberry32 over (seed, counter): one independent draw per counter value. */
export function draw(seed: number, counter: number): number {
  let t = (seed ^ Math.imul(counter + 1, 0x9e3779b1)) >>> 0;
  t = (t + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), 1 | t);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
}

/** Start names are split in two stable halves, so a room never opens with a name the daily keeps for itself. */
export type StartBucket = 0 | 1;
export function startBucket(pid: string): StartBucket {
  let h = 0x811c9dc5;
  for (let i = 0; i < pid.length; i += 1) h = Math.imul(h ^ pid.charCodeAt(i), 0x01000193);
  return ((h >>> 0) % 2) as StartBucket;
}

function unusedOn(universe: Universe, letter: string, used: ReadonlySet<string>): number {
  let count = 0;
  for (const pid of universe.starting(letter)) if (!used.has(pid)) count += 1;
  return count;
}

const startPools = new WeakMap<Universe, Map<string, string[]>>();
/** Every footballer of a bucket at least this well known, in a fixed order (computed once per release). */
function startPool(universe: Universe, bucket: StartBucket | null, minFame: number): string[] {
  let pools = startPools.get(universe);
  if (!pools) startPools.set(universe, (pools = new Map()));
  const key = `${bucket}:${minFame}`;
  let pool = pools.get(key);
  if (!pool) {
    const seen = new Set<string>();
    pool = [];
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      for (const pid of universe.starting(letter)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        const player = universe.player(pid)!;
        if (player.fame >= minFame && (bucket === null || startBucket(pid) === bucket)) pool.push(pid);
      }
    }
    pool.sort();
    pools.set(key, pool);
  }
  return pool;
}

/**
 * A well-known footballer nobody has used, whose last letter still has plenty of answers; null when the release has
 * nobody left. `random` is one draw in [0, 1).
 */
export function pickStart(universe: Universe, used: ReadonlySet<string>, bucket: StartBucket, random: number): string | null {
  const open = new Map<string, number>();
  const openOn = (letter: string): number => {
    let count = open.get(letter);
    if (count === undefined) { count = unusedOn(universe, letter, used); open.set(letter, count); }
    return count;
  };
  // A name that can answer its own last letter must not count itself as its continuation.
  const options = (pid: string) => openOn(universe.last(pid)) - (universe.starts(pid).includes(universe.last(pid)) ? 1 : 0);
  // The caller's half first, however little is left of it: the other half is the last resort.
  const tiers: Array<[StartBucket | null, number, number]> = [[bucket, START_MIN_FAME, MIN_OPTIONS], [bucket, 0, MIN_OPTIONS], [bucket, 0, 1], [null, 0, 1]];
  for (const [from, minFame, minOptions] of tiers) {
    const list = startPool(universe, from, minFame).filter((pid) => !used.has(pid) && universe.last(pid) !== '' && options(pid) >= minOptions);
    if (list.length) return list[Math.min(list.length - 1, Math.floor(random * list.length))];
  }
  return null;
}

export interface Judgement { verdict: Verdict; pid: string | null }

/** What a typed text is on this letter: a footballer who starts with it and is still free, or why not. */
export function judge(universe: Universe, used: ReadonlySet<string>, letter: string, text: string): Judgement {
  const candidates = universe.resolve(text);
  const onLetter = candidates.filter((pid) => universe.starts(pid).includes(letter));
  const pick = onLetter.find((pid) => !used.has(pid));
  if (pick !== undefined) return { verdict: 'ok', pid: pick };
  if (candidates.length === 0) return { verdict: 'unknown', pid: null };
  return onLetter.length ? { verdict: 'repeat', pid: onLetter[0] } : { verdict: 'letter', pid: candidates[0] };
}

/** True when nobody unused is left on the letter: the game then supplies a fresh name. */
export const letterExhausted = (universe: Universe, used: ReadonlySet<string>, letter: string): boolean => unusedOn(universe, letter, used) === 0;

/** A few well-known unused footballers on a letter, to show when a turn was lost. */
export function examplesOn(universe: Universe, used: ReadonlySet<string>, letter: string, limit: number): string[] {
  const names: string[] = [];
  for (const pid of universe.starting(letter)) {
    if (used.has(pid)) continue;
    names.push(universe.player(pid)!.name);
    if (names.length >= limit) break;
  }
  return names;
}
