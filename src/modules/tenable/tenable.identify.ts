import { namesSomeoneElseThan, type FootballerNames } from '../footballers/footballers.names.js';
import { isCyrillicText, normalizeName as normalizeLatin, normalizeNameCyrillic, surnameOf as surnameOfLatin, surnameOfCyrillic, typoBudget, withinEdits } from '../footballers/footballers.text.js';

/**
 * Who a typed text means, decided against every entity of one kind and never against a hidden list: every verdict a
 * player can observe apart from "right" and "wrong" is then the same whatever the list holds (no answer oracle).
 * Bumped whenever a change could identify the same text differently; content records the version it was validated with.
 */
export const TENABLE_MATCHER_VERSION = 1;
/** Bumped with the judge (not the matcher): gap contexts carry it, so misses recorded under an older judge stay apart. */
export const TENABLE_JUDGE_VERSION = 3;

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

/**
 * Words a club or a national team is written with that name no team on their own ("FC Vellmora", "Lissandra Football
 * Club", "équipe de Vestria de football"). Dropped only when the whole text names nothing.
 */
const TEAM_FILLER = new Set([
  'fc', 'cf', 'sc', 'sk', 'ac', 'afc', 'cd', 'cp', 'sv', 'fk', 'nk', 'bk', 'jk', 'ks', 'sd', 'ud', 'rc', 'rcd', 'cs', 'if', 'ik', 'ifk', 'bsc',
  'vfb', 'vfl', 'tsv', 'ssc', 'as', 'us', 'ss', 'spor', 'football', 'futbol', 'futebol', 'fussball', 'calcio', 'soccer', 'club', 'clube', 'klub',
  'kulubu', 'team', 'national', 'nacional', 'men', 'mens', 'selecao', 'seleccion', 'equipe', 'association', 'de', 'of', 'the', 'la', 'el', 'du',
  'da', 'do',
]);
const TEAM_KINDS: ReadonlySet<EntityKind> = new Set(['club', 'nation']);

/**
 * A typo near several entities is read against the list only when it is long enough that its near spellings are
 * genuinely one name misspelt: short surnames (dense in Georgian transliteration) sit within a typo of many people.
 * Letters, spaces ignored. A typo in another script never is: transliterations put many names within a letter or two.
 */
export const TYPO_READ_MIN = { latin: 7, other: Infinity, singleWordLatin: 7, singleWordOther: Infinity } as const;
const LATIN_ONLY = /^[a-z0-9 ]+$/;
function typoReadable(key: string): boolean {
  const letters = compact(key).length;
  const latin = LATIN_ONLY.test(key);
  const single = !key.includes(' ');
  // An initial or a cut-off word ("kelvaro m") narrows nothing: it is an unfinished name, not a typo.
  if (key.split(' ').some((word) => word.length < 3)) return false;
  return letters >= (latin ? TYPO_READ_MIN.latin : TYPO_READ_MIN.other)
    && (!single || letters >= (latin ? TYPO_READ_MIN.singleWordLatin : TYPO_READ_MIN.singleWordOther));
}

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
  /** Every key the matcher reads an answer by: whole names, compact forms, surnames and one-word names. */
  identifyingKeys(): string[];
  /** The release under its Russian names (every entity of it), when the release has them. */
  russian?: Directory;
  /** Diagnostics only (never scoring): who an ambiguous text could be, best known first, at most 10. */
  candidates?(text: string): string[];
  /** Everyone who holds this exact name, word or compact form (not typos): the namesakes `onBoard` chooses between. */
  namesakes(text: string): readonly string[];
  /** A typo near several entities (no exact holder): all of them, best known first. Empty otherwise. */
  nearby(text: string): readonly string[];
}

/**
 * Refuses a typo reading: true when the text must not be read as a misspelling of this entity (it is, as typed, the
 * name of somebody else). Decided from the text and the entity only, never from a list.
 */
export type TypoVeto = (text: string, entity: TenableEntity) => boolean;

const vetoes = new WeakMap<FootballerNames, TypoVeto>();
/**
 * For a kind whose people are also footballers (managers): a footballer's own name is never a typo of another person.
 * One veto per names index, so a directory can tell when the index it judged with has changed.
 */
export function footballerTypoVeto(names: FootballerNames | null): TypoVeto | undefined {
  if (!names) return undefined;
  let veto = vetoes.get(names);
  if (!veto) vetoes.set(names, (veto = (text, entity) => namesSomeoneElseThan(names, text, () => [entity.name, entity.known, ...entity.aliases], { person: true })));
  return veto;
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

/**
 * `typoVeto` is asked on every uncached reading: the veto in force (none before the names load) is part of what a cached
 * reading was decided with, and a reading decided under another one is read again.
 */
export function buildDirectory(kind: EntityKind, releaseId: string, rows: readonly TenableEntity[], alphabet: DirectoryAlphabet = 'latin', typoVeto?: () => TypoVeto | undefined): Directory {
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
    // A translated full-name alias must also be discoverable by surname or
    // first name. These keys are suggestions only: typed-answer identity and
    // the pinned matcher's ambiguity rules stay unchanged. A picked ID is
    // already judged by the normal, list-independent path.
    for (const alias of e.aliases) {
      const translated = normalizeName(alias);
      if (/[ა-ჰ]/u.test(translated)) {
        for (const word of translated.split(' ')) if (!particles.has(word)) visible.add(word);
      }
    }
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

  /**
   * Who a text can mean, by the strongest tier that knows it: the holders of a whole name, word or compact form, or the
   * near spellings of a typo. Null: nobody (too short, a particle, no typo budget). `identify` decides from it and the
   * diagnostics list it, so the two can never read a text differently.
   */
  type Lookup = { tier: 'held'; holders: readonly number[] } | { tier: 'near'; near: ReadonlySet<number> } | null;
  /** The holders of the text itself (whole name, word or compact form); 'none' = too short or a particle. */
  const held = (key: string): readonly number[] | 'none' | undefined => {
    if (!key || compact(key).length < 2) return 'none';
    // The strongest tier that knows the text decides; an ambiguity there never falls through to a weaker tier.
    if (key.includes(' ')) {
      const exact = names.get(key);
      if (exact) return exact;
    } else {
      if (particles.has(key) || key.length < MIN_WORD) return 'none';
      const holders = words.get(key) ?? names.get(key);
      if (holders) return holders;
    }
    // Typed without spaces ("vanbasten"): the compact form of a name of several words.
    return names.get(compact(key));
  };
  const lookupKey = (key: string, text: string, veto: TypoVeto | undefined): Lookup => {
    const holders = held(key);
    if (holders === 'none') return null;
    if (holders) return { tier: 'held', holders };
    const target = compact(key);
    const budget = typoBudget(target.length);
    if (budget === 0) return null;
    const near = new Set<number>();
    for (let length = target.length - budget; length <= target.length + budget; length += 1) {
      for (const [candidate, i] of typoBuckets.get(`${target.charAt(0)}${length}`) ?? []) {
        if (candidate.length >= 5 && withinEdits(target, candidate, budget)) near.add(i);
      }
    }
    if (veto) for (const i of [...near]) if (veto(text, all[i])) near.delete(i);
    return { tier: 'near', near };
  };
  const stripFiller = (key: string): string | null => {
    if (alphabet !== 'latin' || !TEAM_KINDS.has(kind)) return null;
    // Initials written apart ("s k" from "S.K.") are one word; a lone letter ("B", a reserve side) is kept.
    const joined: string[] = [];
    let initials = '';
    // "men's" is one generic word, never the initial "s" of a side ("men s b").
    for (const word of key.replace(/\bmen s\b/g, 'mens').split(' ')) {
      if (word.length === 1) { initials += word; continue; }
      if (initials) joined.push(initials);
      initials = '';
      joined.push(word);
    }
    if (initials) joined.push(initials);
    const words = joined.filter((word) => !TEAM_FILLER.has(word));
    const stripped = words.join(' ');
    return words.some((word) => word.length >= MIN_WORD) && stripped !== key ? stripped : null;
  };
  const lookup = (text: string, veto = typoVeto?.()): Lookup => {
    const key = normalizeName(text);
    const found = lookupKey(key, text, veto);
    if (found?.tier === 'held' || (found?.tier === 'near' && found.near.size > 0)) return found;
    const stripped = stripFiller(key);
    if (!stripped) return found;
    const again = lookupKey(stripped, stripped, veto);
    // A lone letter ("vellmora b") is a team of its own: never a typo of the team without it.
    if (again?.tier === 'near' && stripped.split(' ').some((word) => word.length === 1)) return found;
    return again ?? found;
  };

  /**
   * The identity, the holders of the name (namesakes), and for a typo near several entities all of them (best known
   * first): one lookup, cached together.
   */
  type Reading = { identity: Identity; held: readonly string[]; nearby: readonly string[]; veto: TypoVeto | undefined };
  const readUncached = (text: string, veto: TypoVeto | undefined): Reading => {
    const found = lookup(text, veto);
    if (!found) return { identity: { kind: 'unknown' }, held: [], nearby: [], veto };
    if (found.tier === 'held') return { identity: decide(found.holders), held: [...new Set(found.holders)].map((i) => all[i].eid), nearby: [], veto };
    // A typo is forgiven only towards exactly one entity: no fame tie-break between near spellings.
    const [only] = found.near;
    if (found.near.size === 1) return { identity: { kind: 'entity', eid: all[only].eid }, held: [], nearby: [], veto };
    if (found.near.size === 0) return { identity: { kind: 'unknown' }, held: [], nearby: [], veto };
    const nearby = typoReadable(normalizeName(text)) ? [...found.near].sort((x, y) => x - y).map((i) => all[i].eid) : [];
    return { identity: { kind: 'ambiguous' }, held: [], nearby, veto };
  };

  /** Diagnostics only: everyone the lookup holds for this text, best known first, at most 10. */
  const candidates = (text: string): string[] => {
    const found = lookup(text.slice(0, 80));
    if (!found) return [];
    const ids = found.tier === 'held' ? [...new Set(found.holders)] : [...found.near];
    return ids.sort((x, y) => x - y).slice(0, 10).map((i) => all[i].eid);
  };

  const cache = new Map<string, Reading>();
  let lastVeto: TypoVeto | undefined;
  const read = (text: string): Reading => {
    const key = text.slice(0, 80);
    const veto = typoVeto?.();
    // Readings decided under another names index are dropped together, so no old index stays referenced.
    if (veto !== lastVeto) { cache.clear(); lastVeto = veto; }
    const hit = cache.get(key);
    if (hit && hit.veto === veto) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    if (hit) cache.delete(key);
    const found = readUncached(key, veto);
    cache.set(key, found);
    if (cache.size > IDENTITY_CACHE) cache.delete(cache.keys().next().value!);
    return found;
  };
  const identify = (text: string): Identity => read(text).identity;
  const nearby = (text: string): readonly string[] => read(text).nearby;
  const namesakes = (text: string): readonly string[] => read(text).held;

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
    identifyingKeys: () => [...new Set([...names.keys(), ...words.keys()])],
    candidates,
    namesakes,
    nearby,
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
    identifyingKeys: () => [...new Set([...latin.identifyingKeys(), ...russian.identifyingKeys()])],
    candidates: (text) => (isCyrillicText(text) ? russian.candidates?.(text) ?? [] : latin.candidates?.(text) ?? []),
    namesakes: (text) => (isCyrillicText(text) ? russian.namesakes(text) : latin.namesakes(text)),
    nearby: (text) => (isCyrillicText(text) ? russian.nearby(text) : latin.nearby(text)),
    russian,
  };
}

/** The name to show for an entity: its Russian name to a Russian player when the release has one. */
export function displayName(directory: Directory, eid: string, russian: boolean): string | null {
  return (russian ? directory.russian?.entity(eid)?.name : undefined) ?? directory.entity(eid)?.name ?? null;
}

/**
 * The board's holder of a typed name, when the release reads the name as someone else and that reading would cost the
 * player (a life, a dart): exactly one other holder of that very name is on the board ("Alvo" on a list holding
 * Alvo Carrel, not the better-known Alvo Bressan). Null otherwise, and the release's reading stands. Only a costly reading is ever replaced,
 * so a failed rescue costs what it always did: no verdict becomes a free probe of the board, and a text the release
 * cannot decide stays undecided (a vague surname never becomes a free guess).
 */
export function boardNamesake(directory: Directory, text: string, released: string, onBoard: (eid: string) => boolean): string | null {
  if (onBoard(released)) return null;
  const there = boardableNamesakes(directory, text).filter((eid) => eid !== released && onBoard(eid));
  return there.length === 1 ? there[0] : null;
}

/**
 * The namesakes a board may choose between. A name in another script is one only when every holder has the same Latin
 * name: a transliteration can merge two names ("Herrano" and "Herrana" may be spelt alike in Georgian), and a board
 * reading would then turn one footballer into another. Decided from the release only.
 */
function boardableNamesakes(directory: Directory, text: string): readonly string[] {
  const holders = directory.namesakes(text);
  if (holders.length < 2 || LATIN_TEXT.test(text)) return holders;
  const latin = new Set(holders.map((eid) => normalizeLatin(directory.entity(eid)?.known ?? eid)));
  return latin.size === 1 ? holders : [];
}
const LATIN_TEXT = /^[\p{Script=Latin}\P{L}]*$/u;
/** True when the text is written in Latin letters only (digits and punctuation aside). */
export const isLatinText = (text: string): boolean => LATIN_TEXT.test(text);

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
/**
 * The people a text the release cannot pin on one person may mean: the holders of the name, word or compact form, or,
 * for a typo, every entity it is near. Best known first.
 */
/** True when the shared readings of a text are a typo's near spellings, not holders of the name itself. */
export const isTypoReading = (directory: Directory, text: string): boolean => directory.namesakes(text).length === 0;


/** A typo is right only when exactly one of its near spellings is on the board; two is still a guess. */
export const onlyOne = (onBoard: readonly string[]): readonly string[] => (onBoard.length === 1 ? onBoard : []);

export function sharedReadings(directory: Directory, text: string): readonly string[] {
  return directory.namesakes(text).length > 0 ? boardableNamesakes(directory, text) : directory.nearby(text);
}

/**
 * A name (or typo) the release cannot pin on one person, read against the list: its best-known reading still open on the
 * list is right; otherwise it is a wrong that costs like any other, named by its best-known reading (so the daily's
 * repeatWrong keeps a second try free). Either way the verdict is right or a costly wrong, whatever else the list holds:
 * no free answer tells what is on it.
 */
function judgeShared(directory: Directory, slots: readonly string[], found: ReadonlySet<number>, text: string, paid?: ReadonlySet<string>): Verdict | null {
  const holders = sharedReadings(directory, text);
  if (holders.length < 2) return null;
  // Already paid for its best-known holder: the same wrong again (the daily's free repeatWrong), whatever the list holds.
  if (paid?.has(holders[0])) return { kind: 'wrong', eid: holders[0] };
  const listed = isTypoReading(directory, text) ? onlyOne(holders.filter((eid) => slots.includes(eid))) : holders;
  const open = listed.find((eid) => { const slot = slots.indexOf(eid); return slot >= 0 && !found.has(slot); });
  return open ? { kind: 'right', slot: slots.indexOf(open), eid: open } : { kind: 'wrong', eid: holders[0] };
}

export function judge(directory: Directory, slots: readonly string[], found: ReadonlySet<number>, text: string, picked?: string | null, paid?: ReadonlySet<string>): Verdict {
  const byPick = Boolean(picked && directory.entity(picked));
  const identity: Identity = byPick ? { kind: 'entity', eid: picked! } : directory.identify(text);
  if (identity.kind === 'ambiguous') return judgeShared(directory, slots, found, text, paid) ?? identity;
  if (identity.kind !== 'entity') return identity;
  let eid = identity.eid;
  // Only a costly wrong is rescued, and only to an open slot: a wrong already paid for (the daily's repeatWrong) or a
  // namesake already found keeps the costly reading, so no rescue ever turns into a free verdict.
  if (!byPick && !slots.includes(eid) && !paid?.has(eid)) {
    const there = boardNamesake(directory, text, eid, (e) => slots.includes(e));
    if (there && !found.has(slots.indexOf(there))) eid = there;
  }
  const slot = slots.indexOf(eid);
  if (slot < 0) return { kind: 'wrong', eid };
  return found.has(slot) ? { kind: 'repeat', slot, eid } : { kind: 'right', slot, eid };
}
