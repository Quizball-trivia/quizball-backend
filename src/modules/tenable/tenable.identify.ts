import { isCyrillicText, normalizeName as normalizeLatin, normalizeNameCyrillic, surnameOf as surnameOfLatin, surnameOfCyrillic, typoBudget, withinEdits } from '../footballers/footballers.text.js';

/**
 * Who a typed text means, decided against every entity of one kind and never against a hidden list: every verdict a
 * player can observe apart from "right" and "wrong" is then the same whatever the list holds (no answer oracle).
 * Bumped whenever a change could identify the same text differently; content records the version it was validated with.
 */
export const TENABLE_MATCHER_VERSION = 1;

export const ENTITY_KINDS = ['player', 'manager', 'club', 'nation'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface TenableEntity {
  eid: string;
  name: string;
  /** The name the entity is known by ("Messi", "Barça"). */
  known: string;
  /** 0–100, from the release: orders suggestions and decides which holder a shared name means. */
  fame: number;
  aliases: readonly string[];
  /** Tells namesakes apart in suggestions ("ARG · 1987"). */
  qualifier: string | null;
}

export type Identity = { kind: 'entity'; eid: string } | { kind: 'ambiguous' } | { kind: 'unknown' };
export interface Suggestion { eid: string; label: string; qualifier: string | null }

/** A shared name means its best-known holder only when that one is well known and every other holder is far less so. */
export const DOMINANT_MIN_FAME = 40;
export const DOMINANT_RATIO = 0.5;
/** Words that never identify anyone on their own. */
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'del', 'della', 'di', 'van', 'von', 'der', 'den', 'el', 'al', 'la', 'le', 'los', 'las', 'bin', 'ben', 'mac', 'mc', 'st', 'y', 'e', 'fc', 'cf', 'sc', 'ac', 'cd', 'club']);
/** The same words as Russian media write them (in the compared form: й is и). */
const PARTICLES_CYRILLIC = new Set(['де', 'да', 'ду', 'дус', 'дас', 'дель', 'делла', 'ди', 'ван', 'фон', 'дер', 'ден', 'эль', 'аль', 'ла', 'ле', 'лос', 'лас', 'бин', 'бен', 'мак', 'сент', 'и', 'фк', 'ск', 'клуб', 'сборная']);

/** How names are compared: the Latin alphabet (every list's own names), or Cyrillic (a release's Russian names). */
export type DirectoryAlphabet = 'latin' | 'cyrillic';
const ALPHABETS = {
  latin: { normalize: normalizeLatin, surname: surnameOfLatin, particles: PARTICLES },
  cyrillic: { normalize: normalizeNameCyrillic, surname: surnameOfCyrillic, particles: PARTICLES_CYRILLIC },
} as const;
const MIN_WORD = 3;
export const SUGGEST_MIN = 2;
export const SUGGEST_MAX = 40;
export const SUGGEST_LIMIT = 8;
const IDENTITY_CACHE = 5_000;
/** Queries up to this long are answered from a table built with the directory (a short prefix matches thousands of names). */
const SHORT_PREFIX = 3;

export interface Directory {
  kind: EntityKind;
  releaseId: string;
  size: number;
  entity(eid: string): TenableEntity | undefined;
  identify(text: string): Identity;
  suggest(query: string, limit?: number): Suggestion[];
  /** Every entity whose own name is this text (normalised): the label a suggestion or an answer shows it by. */
  named(text: string): readonly string[];
  /** The release under its Russian names (every entity of it), when the release has them. */
  russian?: Directory;
}

const compact = (key: string) => key.replace(/ /g, '');

/** What a suggestion shows, from the normalised name and known name: whole, compact and word by word. */
function visibleKeys(own: readonly string[], particles: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const name of own) {
    if (!name) continue;
    keys.add(name).add(compact(name));
    for (const word of name.split(' ')) if (!particles.has(word)) keys.add(word);
  }
  return keys;
}

export function buildDirectory(kind: EntityKind, releaseId: string, rows: readonly TenableEntity[], alphabet: DirectoryAlphabet = 'latin'): Directory {
  const { normalize: normalizeName, surname: surnameOf, particles } = ALPHABETS[alphabet];
  // Best known first, ties by id: every "best known" decision depends on the release only.
  const all = [...rows].sort((a, b) => b.fame - a.fame || (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0));
  const byEid = new Map(all.map((e, i) => [e.eid, i]));
  if (byEid.size !== all.length) throw new Error('Duplicate entity id in the release');

  const names = new Map<string, number[]>();
  const words = new Map<string, number[]>();
  // Words of the shown name that identify no one (a first name, a middle word): found by suggestions only.
  const shownOnly = new Map<string, number[]>();
  // Entities are added in index order, so a repeat of the same key for one entity is always the last holder.
  const put = (map: Map<string, number[]>, key: string, i: number) => {
    if (!key) return;
    const list = map.get(key);
    if (!list) map.set(key, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  };
  const typoKeys: Array<[string, number]> = [];
  // Suggestions matching the shown name come before ones found only through an alias or another spelling ("sp":
  // Sporting before Tottenham's "Spurs"). The best known holders of every short prefix, the two kinds apart: entities
  // arrive best known first, so the first few of each are the answer (the same as rank() below, built in one pass).
  const shortShown = new Map<string, number[]>();
  const shortOther = new Map<string, number[]>();
  // The last entity each short prefix was counted for, per kind: no per-entity sets on a 100k-name release.
  const lastShown = new Map<string, number>();
  const lastOther = new Map<string, number>();
  const keepTop = (map: Map<string, number[]>, prefix: string, i: number) => {
    const top = map.get(prefix);
    if (!top) map.set(prefix, [i]);
    else if (top.length < SUGGEST_LIMIT) top.push(i);
  };
  const other = new Set<string>();
  all.forEach((e, i) => {
    other.clear();
    const own = [normalizeName(e.name), normalizeName(e.known)];
    const whole = new Set([...own, ...e.aliases.map(normalizeName)].filter(Boolean));
    for (const key of whole) {
      const joined = compact(key);
      typoKeys.push([joined, i]);
      // A name of several words identifies outright; a single word (a known name like "Vega", an alias, a surname)
      // always goes through the dominance rule, whichever way the release happened to classify it.
      if (key.includes(' ')) {
        other.add(key).add(joined);
        put(names, key, i);
        put(names, joined, i);
      }
    }
    // One word identifies only as a surname or a one-word name, never as a first name or a particle.
    for (const word of new Set([surnameOf(own[0]), ...[...whole].filter((k) => !k.includes(' '))])) {
      if (word.length >= MIN_WORD && !particles.has(word)) {
        other.add(word);
        put(words, word, i);
      }
    }
    const visible = visibleKeys(own, particles);
    for (const key of visible) {
      if (!other.has(key)) put(shownOnly, key, i);
      for (let n = SUGGEST_MIN; n <= Math.min(SHORT_PREFIX, key.length); n += 1) {
        const prefix = key.slice(0, n);
        if (lastShown.get(prefix) === i) continue;
        lastShown.set(prefix, i);
        keepTop(shortShown, prefix, i);
      }
    }
    for (const key of other) {
      for (let n = SUGGEST_MIN; n <= Math.min(SHORT_PREFIX, key.length); n += 1) {
        const prefix = key.slice(0, n);
        if (lastShown.get(prefix) === i || lastOther.get(prefix) === i) continue;
        lastOther.set(prefix, i);
        keepTop(shortOther, prefix, i);
      }
    }
  });
  // Build-only state shares the scope the returned functions keep alive.
  lastShown.clear();
  lastOther.clear();
  other.clear();
  // Typo search is bucketed by first letter and length: a typo in the first letter is not forgiven (the suggestions
  // cover it), and one lookup compares a few thousand keys at most instead of the whole release.
  const typoBuckets = new Map<string, Array<[string, number]>>();
  for (const entry of typoKeys) {
    const bucketKey = `${entry[0].charAt(0)}${entry[0].length}`;
    const bucket = typoBuckets.get(bucketKey);
    if (bucket) bucket.push(entry);
    else typoBuckets.set(bucketKey, [entry]);
  }
  typoKeys.length = 0;

  /** One holder, or the dominant one of several, or ambiguous. Indices are best known first. */
  const decide = (holders: readonly number[]): Identity => {
    const sorted = [...new Set(holders)].sort((a, b) => a - b);
    if (sorted.length === 1) return { kind: 'entity', eid: all[sorted[0]].eid };
    const [top, ...rest] = sorted.map((i) => all[i]);
    const dominant = top.fame >= DOMINANT_MIN_FAME && rest.every((o) => o.fame <= top.fame * DOMINANT_RATIO);
    return dominant ? { kind: 'entity', eid: top.eid } : { kind: 'ambiguous' };
  };

  const identifyUncached = (text: string): Identity => {
    const key = normalizeName(text);
    if (!key || compact(key).length < 2) return { kind: 'unknown' };
    // The strongest tier that knows the text decides; an ambiguity there never falls through to a weaker tier.
    if (key.includes(' ')) {
      const exact = names.get(key);
      if (exact) return decide(exact);
    } else {
      if (particles.has(key) || key.length < MIN_WORD) return { kind: 'unknown' };
      const holders = words.get(key) ?? names.get(key);
      if (holders) return decide(holders);
    }
    // Typed without spaces ("vanbasten"): the compact form of a name of several words.
    const joined = names.get(compact(key));
    if (joined) return decide(joined);
    const target = compact(key);
    const budget = typoBudget(target.length);
    if (budget === 0) return { kind: 'unknown' };
    const close: number[] = [];
    for (let length = target.length - budget; length <= target.length + budget; length += 1) {
      for (const [candidate, i] of typoBuckets.get(`${target.charAt(0)}${length}`) ?? []) {
        if (candidate.length >= 5 && withinEdits(target, candidate, budget)) close.push(i);
      }
    }
    // A typo is forgiven only towards exactly one entity: no fame tie-break between near spellings.
    const near = new Set(close);
    return near.size === 1 ? { kind: 'entity', eid: all[[...near][0]].eid } : near.size > 1 ? { kind: 'ambiguous' } : { kind: 'unknown' };
  };

  const cache = new Map<string, Identity>();
  const identify = (text: string): Identity => {
    const key = text.slice(0, 80);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const found = identifyUncached(key);
    cache.set(key, found);
    if (cache.size > IDENTITY_CACHE) cache.delete(cache.keys().next().value!);
    return found;
  };

  // Prefix search: every key (whole names, compact forms, identifying words, shown-only words), sorted once.
  const prefixKeys = [...new Set([...names.keys(), ...words.keys(), ...shownOnly.keys()])].sort();
  const holdersOf = (k: string) => [...(names.get(k) ?? []), ...(words.get(k) ?? []), ...(shownOnly.get(k) ?? [])];
  const rank = (q: string, max: number): number[] => {
    let lo = 0;
    let hi = prefixKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (prefixKeys[mid] < q) lo = mid + 1;
      else hi = mid;
    }
    const found = new Set<number>();
    for (let i = lo; i < prefixKeys.length && prefixKeys[i].startsWith(q); i += 1) for (const h of holdersOf(prefixKeys[i])) found.add(h);
    const first: number[] = [];
    const rest: number[] = [];
    for (const i of [...found].sort((a, b) => a - b)) {
      if (first.length >= max) break;
      const shown = [...visibleKeys([normalizeName(all[i].name), normalizeName(all[i].known)], particles)].some((k) => k.startsWith(q));
      if (shown) first.push(i);
      else if (rest.length < max) rest.push(i);
    }
    return [...first, ...rest].slice(0, max);
  };
  const shortTop = (q: string) => [...(shortShown.get(q) ?? []), ...(shortOther.get(q) ?? [])].slice(0, SUGGEST_LIMIT);
  const suggest = (query: string, limit = SUGGEST_LIMIT): Suggestion[] => {
    const q = normalizeName(query.slice(0, SUGGEST_MAX));
    if (q.length < SUGGEST_MIN) return [];
    const max = Math.max(0, Math.min(limit, SUGGEST_LIMIT));
    const top = q.length <= SHORT_PREFIX ? shortTop(q).slice(0, max) : rank(q, max);
    return top.map((i) => ({ eid: all[i].eid, label: all[i].name, qualifier: all[i].qualifier }));
  };

  // Built on first use: only translated names (tenable.names.ts) ask it.
  let byName: Map<string, string[]> | null = null;
  const named = (text: string): readonly string[] => {
    if (!byName) {
      byName = new Map();
      for (const e of all) { const k = normalizeName(e.name); byName.set(k, [...(byName.get(k) ?? []), e.eid]); }
    }
    return byName.get(normalizeName(text)) ?? [];
  };

  return {
    kind,
    releaseId,
    size: all.length,
    entity: (eid) => { const i = byEid.get(eid); return i === undefined ? undefined : all[i]; },
    identify,
    suggest,
    named,
  };
}

/**
 * The release with its Russian names: a text written in Cyrillic is read (and suggested) with the Russian names, any
 * other text exactly as before. Ids are the same in both, so `entity` and a picked id stay the release's own.
 */
export function withRussian(latin: Directory, russian: Directory): Directory {
  if (russian.kind !== latin.kind || russian.releaseId !== latin.releaseId || russian.size !== latin.size) throw new Error('Russian names do not match the release');
  return {
    ...latin,
    identify: (text) => (isCyrillicText(text) ? russian.identify(text) : latin.identify(text)),
    suggest: (query, limit) => (isCyrillicText(query) ? russian.suggest(query, limit) : latin.suggest(query, limit)),
    russian,
  };
}

/** The name to show for an entity: its Russian name to a Russian player when the release has one. */
export function displayName(directory: Directory, eid: string, russian: boolean): string | null {
  return (russian ? directory.russian?.entity(eid)?.name : undefined) ?? directory.entity(eid)?.name ?? null;
}

export type Verdict =
  | { kind: 'right'; slot: number; eid: string }
  | { kind: 'repeat'; slot: number; eid: string }
  | { kind: 'wrong'; eid: string }
  | { kind: 'ambiguous' }
  | { kind: 'unknown' };

/**
 * Judges one answer; the list is looked at only after the identity is settled. `picked` is a chosen suggestion's id:
 * sending any id of the directory is the same as typing that entity's full name (a wrong one costs a life), so it
 * reveals nothing a typed name would not.
 */
export function judge(directory: Directory, slots: readonly string[], found: ReadonlySet<number>, text: string, picked?: string | null): Verdict {
  const identity: Identity = picked && directory.entity(picked) ? { kind: 'entity', eid: picked } : directory.identify(text);
  if (identity.kind !== 'entity') return identity;
  const slot = slots.indexOf(identity.eid);
  if (slot < 0) return { kind: 'wrong', eid: identity.eid };
  return found.has(slot) ? { kind: 'repeat', slot, eid: identity.eid } : { kind: 'right', slot, eid: identity.eid };
}
