import { firstLetter, lastLetter, normalizeName, surnameOf, typoBudget, TYPO_MIN_LENGTH, withinEdits, withinOneEdit } from './footballers.text.js';

/** Bumped whenever a change here could judge the same text differently: content pins the version it was built for. */
export const MATCHER_VERSION = 1;

export interface UniversePlayer {
  /** Durable id: the same footballer keeps it from one release to the next. */
  pid: string;
  name: string;
  /** The name the footballer is known by: the next letter of a chain is read from it. */
  game: string;
  /** Orders namesakes: the best known is tried first. */
  fame: number;
  aliases: string[];
}

/**
 * Every footballer of one release, indexed for the word games. Immutable and pure: two processes that load the same
 * release judge every text the same way.
 */
export interface Universe {
  releaseId: string;
  size: number;
  player(pid: string): UniversePlayer | undefined;
  /** The letters a footballer can answer: the first of the full name, of the name they are known by and of the surname. */
  starts(pid: string): readonly string[];
  /** The letter the next footballer must start with. */
  last(pid: string): string;
  /** Every footballer the text can mean, best known first. */
  resolve(text: string): string[];
  /** Footballers who can answer the letter, best known first. */
  starting(letter: string): readonly string[];
  /**
   * The footballer the text names among `among`, read generously: full name, the name they are known by, an alias, or
   * any single name word, with typos forgiven. Null when it fits nobody, or when the text is, as typed, the name of a
   * footballer who is not among them.
   */
  pickAmong(text: string, among: readonly string[]): string | null;
}

export function buildUniverse(releaseId: string, rows: readonly UniversePlayer[]): Universe {
  // Best known first, ties by id: the order (and so every "best known" pick) depends only on the release.
  const players = [...rows].sort((a, b) => b.fame - a.fame || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
  const indexOf = new Map(players.map((p, i) => [p.pid, i]));
  if (indexOf.size !== players.length) throw new Error('Duplicate footballer id in the release');
  const starts = players.map((p) => [...new Set([firstLetter(p.name), firstLetter(p.game), firstLetter(surnameOf(p.name))])].filter(Boolean));
  const lasts = players.map((p) => lastLetter(p.game));
  const pidOf = (i: number) => players[i].pid;

  const exact = new Map<string, number[]>();
  const add = (key: string, player: number) => {
    if (!key) return;
    const list = exact.get(key);
    if (!list) exact.set(key, [player]);
    else if (list[list.length - 1] !== player && !list.includes(player)) list.push(player);
  };
  // Indices rise with falling fame, so every list below is already best known first.
  players.forEach((p, i) => {
    add(normalizeName(p.name), i);
    add(normalizeName(p.game), i);
    for (const alias of p.aliases) add(normalizeName(alias), i);
  });
  exact.forEach((list) => list.sort((a, b) => a - b));

  const byLetter = new Map<string, string[]>();
  players.forEach((p, i) => {
    for (const letter of starts[i]) {
      const list = byLetter.get(letter);
      if (list) list.push(p.pid);
      else byLetter.set(letter, [p.pid]);
    }
  });

  // Typo search: full names only, bucketed by length so one lookup compares a few thousand keys.
  const fullByLength = new Map<number, Array<[string, number]>>();
  players.forEach((p, i) => {
    const key = normalizeName(p.name);
    const bucket = fullByLength.get(key.length);
    if (bucket) bucket.push([key, i]);
    else fullByLength.set(key.length, [[key, i]]);
  });

  const resolve = (text: string): string[] => {
    const key = normalizeName(text);
    if (!key) return [];
    const hit = exact.get(key);
    if (hit) return hit.map(pidOf);
    if (key.length < TYPO_MIN_LENGTH) return [];
    const found = new Set<number>();
    for (const length of [key.length - 1, key.length, key.length + 1]) {
      for (const [candidate, player] of fullByLength.get(length) ?? []) if (withinOneEdit(key, candidate)) found.add(player);
    }
    return [...found].sort((a, b) => a - b).map(pidOf);
  };

  const pickAmong = (text: string, among: readonly string[]): string | null => {
    const key = normalizeName(text);
    if (key.length < 2) return null;
    const candidates = among.flatMap((pid) => {
      const i = indexOf.get(pid);
      if (i === undefined) return [];
      const whole = [players[i].name, players[i].game, ...players[i].aliases].map(normalizeName).filter(Boolean);
      return [{ i, whole, words: whole.flatMap((n) => n.split(' ')).filter((w) => w.length >= 2) }];
    }).sort((a, b) => a.i - b.i);
    const tiers: Array<(c: (typeof candidates)[number]) => boolean> = [
      (c) => c.whole.includes(key),
      (c) => c.words.includes(key),
      (c) => c.whole.some((n) => withinEdits(key, n, typoBudget(Math.min(key.length, n.length)))),
      (c) => c.words.some((w) => withinEdits(key, w, typoBudget(Math.min(key.length, w.length)))),
    ];
    for (const [tier, fits] of tiers.entries()) {
      // Typos are only forgiven when the text is not, as typed, some other footballer's name.
      if (tier === 2 && exact.has(key)) return null;
      // A word two of them share names the best known of them.
      const hit = candidates.find(fits);
      if (hit) return players[hit.i].pid;
    }
    return null;
  };

  return {
    releaseId,
    size: players.length,
    player: (pid) => { const i = indexOf.get(pid); return i === undefined ? undefined : players[i]; },
    starts: (pid) => { const i = indexOf.get(pid); return i === undefined ? [] : starts[i]; },
    last: (pid) => { const i = indexOf.get(pid); return i === undefined ? '' : lasts[i]; },
    resolve,
    starting: (letter) => byLetter.get(letter) ?? [],
    pickAmong,
  };
}
