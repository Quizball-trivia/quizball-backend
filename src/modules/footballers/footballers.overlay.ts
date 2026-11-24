import { isCyrillicText, isGreekText } from './footballers.text.js';
import type { ScopableIndex, Universe } from './footballers.universe.js';

/**
 * What the versioned name overlays of the word games share (Russian: wordgame_ru_*, Greek: wordgame_el_*). A run or
 * room freezes the versions it started with and is judged with exactly those; the active version only decides what
 * new runs and rooms freeze.
 */

/** The letters a run or room plays with. Absent on runs from before the overlays: Latin. */
export type ChainAlphabet = 'latin' | 'cyrillic' | 'greek';

/** Thrown by a room's hydrator under the match lock; the room service answers it as a retryable 503. */
export class RoomContentUnavailable extends Error {
  constructor() {
    super('room_content_unavailable');
  }
}

export interface VersionCache {
  /** The version if this process already holds it: lets a caller under a transaction avoid a database read. */
  held(version: string): ScopableIndex | undefined;
  /** One version, loaded once per process (a failed load is not remembered); concurrent callers share the load. */
  get(version: string): Promise<ScopableIndex>;
  forget(): void;
}

/** Loaded versions, least recently used first. Loads in flight are kept apart so eviction never duplicates one. */
export function createVersionCache(load: (version: string) => Promise<ScopableIndex>, maxHeld: number): VersionCache {
  const held = new Map<string, ScopableIndex>();
  const loading = new Map<string, Promise<ScopableIndex>>();
  const heldIndex = (version: string): ScopableIndex | undefined => {
    const index = held.get(version);
    if (index) {
      held.delete(version);
      held.set(version, index);
    }
    return index;
  };
  return {
    held: heldIndex,
    get(version) {
      const ready = heldIndex(version);
      if (ready) return Promise.resolve(ready);
      const pending = loading.get(version);
      if (pending) return pending;
      const started = load(version).then((index) => {
        held.set(version, index);
        for (const id of held.keys()) {
          if (held.size <= maxHeld) break;
          held.delete(id);
        }
        return index;
      }).finally(() => {
        if (loading.get(version) === started) loading.delete(version);
      });
      loading.set(version, started);
      return started;
    },
    forget() {
      held.clear();
      loading.clear();
    },
  };
}

export interface ActiveVersion {
  /** The version new runs and rooms freeze; null while the overlay is not switched on. Re-read after `ttlMs`. */
  get(now?: number): Promise<string | null>;
  /** As last read, without reading: for callers under a transaction (they warmed it before). */
  known(): string | null;
  forget(): void;
}

export function createActiveVersion(read: () => Promise<string | null>, ttlMs: number): ActiveVersion {
  let active: { version: string | null; checkedAt: number } = { version: null, checkedAt: 0 };
  return {
    async get(now = Date.now()) {
      if (now - active.checkedAt < ttlMs) return active.version;
      active = { version: await read(), checkedAt: now };
      return active.version;
    },
    known: () => active.version,
    forget() {
      active = { version: null, checkedAt: 0 };
    },
  };
}

// Weak on both keys: an evicted version is freed even while a release that was viewed through it stays cached.
const views = new WeakMap<Universe, WeakMap<ScopableIndex, Universe>>();
/** The release's footballers under the overlay's names (only those the release has). */
export function overlayView(universe: Universe, index: ScopableIndex): Universe {
  let byIndex = views.get(universe);
  if (!byIndex) views.set(universe, (byIndex = new WeakMap()));
  let view = byIndex.get(index);
  if (!view) byIndex.set(index, (view = index.scoped(universe.releaseId, (pid) => universe.player(pid) !== undefined)));
  return view;
}

/**
 * A room's overlay names for its hydrator: the view it already holds, else the version from memory, else (only before
 * the match lock) a load. Under the lock a version not in memory is a retryable refusal, never a database read.
 */
export async function roomOverlayView(universe: Universe, held: Universe | null | undefined, version: string, underLock: boolean, cache: VersionCache): Promise<Universe> {
  if (held) return held;
  const index = cache.held(version) ?? (underLock ? null : await cache.get(version));
  if (!index) throw new RoomContentUnavailable();
  return overlayView(universe, index);
}

const combined = new WeakMap<Universe, WeakMap<Universe, Partial<Record<ChainAlphabet, Universe>>>>();
/**
 * What a run or room is judged with: a typed name is read in the alphabet it was typed in (Cyrillic through the Russian
 * view, Greek through the Greek view, everything else exactly as before), while letters, starts and the names shown
 * follow the frozen alphabet. Without an overlay this is the release itself, unchanged.
 */
export function judgingUniverse(universe: Universe, russian: Universe | null, alphabet: ChainAlphabet, greek: Universe | null = null): Universe {
  if (!russian && !greek) return universe;
  // Each overlay view is memoised per (release, version), so the pair of them identifies the combination.
  const first = (russian ?? greek)!;
  const second = greek ?? first;
  let bySecond = combined.get(first);
  if (!bySecond) combined.set(first, (bySecond = new WeakMap()));
  let byAlphabet = bySecond.get(second);
  if (!byAlphabet) bySecond.set(second, (byAlphabet = {}));
  const cached = byAlphabet[alphabet];
  if (cached) return cached;
  const letters = (alphabet === 'cyrillic' ? russian : alphabet === 'greek' ? greek : null) ?? universe;
  const readerOf = (text: string): Universe => (isCyrillicText(text) ? russian ?? universe : isGreekText(text) ? greek ?? universe : universe);
  const view: Universe = {
    releaseId: universe.releaseId,
    size: letters.size,
    alphabet: letters.alphabet,
    player: (pid) => letters.player(pid) ?? universe.player(pid),
    starts: (pid) => letters.starts(pid),
    last: (pid) => letters.last(pid),
    starting: (letter) => letters.starting(letter),
    resolve: (text) => readerOf(text).resolve(text),
    pickAmong: (text, among) => readerOf(text).pickAmong(text, among),
    named: (text) => readerOf(text).named(text),
  };
  byAlphabet[alphabet] = view;
  return view;
}
