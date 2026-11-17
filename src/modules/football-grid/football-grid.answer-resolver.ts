import type {
  FootballGridAliasRecord,
  FootballGridResolvedAnswer,
  FootballGridResolutionDiagnostics,
} from './football-grid.types.js';

export function normalizeFootballGridAnswer(input: string): string {
  return input
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[’'`´]/g, '')
    .replace(/[._,;:!?()[\]{}\-/\\]+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

export function footballGridTypoDistanceLimit(normalizedInput: string): number {
  if (normalizedInput.length < 4) return 0;
  if (normalizedInput.length <= 7) return 1;
  return 2;
}

/** Keyboard/case equivalence, separate from immutable stored alias keys. */
export function footballGridOrthographicKey(normalized: string): string {
  return normalized.replace(/ı/g, 'i').replace(/ß/g, 'ss').replace(/œ/g, 'oe');
}

/** Letters NFD cannot strip to a base letter, as players type them on a plain keyboard. */
const GRID_LETTER_FOLDS: Record<string, string> = {
  ı: 'i', ß: 'ss', œ: 'oe', æ: 'ae', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ħ: 'h', ŧ: 't', ŋ: 'n', ſ: 's',
};

/**
 * The Grid's comparison key: the keyboard key plus the Nordic/Slavic/Icelandic letters ("Ødvik" typed
 * "Odvik"), with typographic dashes and apostrophes the stored keys keep read as plain ones. Applied to the
 * input and to every stored key alike, so stored keys stay byte-for-byte as published.
 */
export function footballGridMatchKey(normalized: string): string {
  return normalized
    .replace(/[ıßœæøłđðþħŧŋſ]/g, (letter) => GRID_LETTER_FOLDS[letter] ?? letter)
    // Greek final sigma is the same letter as σ (typed either way at a word's end).
    .replace(/ς/g, 'σ')
    .replace(/[‘ʻʼ]/g, '')
    .replace(/[‐‑‒–—―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FootballGridPlayerNameRecord {
  playerId: string;
  nameEn: string;
  nameKa: string | null;
  nameRu?: string | null;
  nameEl?: string | null;
}

/** Suffix forms a name is reasonably typed as: the full normalised name plus
 *  every token suffix ("ramiro funes mori" → "funes mori" → "mori"). Shared by
 *  the Grid and Squad Spin resolvers so the acceptance rule cannot drift. */
export function nameSuffixForms(name: string): string[] {
  const normalized = normalizeFootballGridAnswer(name);
  if (!normalized) return [];
  const tokens = normalized.split(' ');
  const forms: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const form = tokens.slice(i).join(' ');
    if (form.length >= 2) forms.push(form);
  }
  return forms;
}

/** Only name forms long enough that a one-edit neighbour is overwhelmingly a
 *  misspelling of this very name may absorb typos; short forms ("mori", "min")
 *  sit one edit from unrelated real players ("mari", "mina") and stay
 *  exact-only. */
const NAME_FORM_TYPO_MIN_LENGTH = 5;

/**
 * Name forms of a valid answer, en and ka. The alias releases are missing
 * surname aliases for many players (and compound surnames never got one), so
 * typed surnames of valid answers were marked wrong even though the cell's
 * reveal then showed exactly that name. Synthetic candidates carry an empty
 * alias id, persisted as NULL on the claim.
 */
export function footballGridNameFormCandidates(players: FootballGridPlayerNameRecord[]): FootballGridAliasRecord[] {
  const forms: FootballGridAliasRecord[] = [];
  for (const player of players) {
    for (const [name, locale] of [[player.nameEn, 'en'], [player.nameKa, 'ka'], [player.nameRu ?? null, 'ru'], [player.nameEl ?? null, 'el']] as Array<[string | null, 'en' | 'ka' | 'ru' | 'el']>) {
      if (!name) continue;
      for (const form of nameSuffixForms(name)) {
        forms.push({ id: '', playerId: player.playerId, alias: form, normalizedAlias: form, locale, acceptancePolicy: 'exact' });
      }
    }
  }
  return forms;
}

export function boundedLevenshtein(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

/** boundedLevenshtein that also counts two swapped neighbouring letters ("Taiosn") as one slip. */
export function boundedTypoDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let previousMin = 0;
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j += 1) {
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        value = Math.min(value, beforePrevious[j - 2] + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    // A swap reaches back two rows, so only two rows over the limit end the search.
    if (rowMin > limit && previousMin > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
    previousMin = rowMin;
  }
  return Math.min(previous[right.length], limit + 1);
}

const PATRONYMIC = /(ович|евич|ьич|овна|евна|ична|инична)$/;

/** One word left out at a time (a surname can look like a patronymic too), then the middle word of three. */
function withoutMiddleName(normalized: string): string[] {
  if (!/\p{Script=Cyrillic}/u.test(normalized)) return [];
  const words = normalized.split(' ');
  if (words.length < 3) return [];
  const without = (skip: number) => words.filter((_, i) => i !== skip).join(' ');
  const readings = words.flatMap((word, i) => (i > 0 && PATRONYMIC.test(word) ? [without(i)] : []));
  if (words.length === 3) readings.push(without(1));
  return [...new Set(readings)];
}

/** Words in a fixed order, so "Surname Name" (the usual order in Russian and Georgian) meets "Name Surname". */
const wordSetKey = (key: string): string | null => {
  const words = key.split(' ');
  return words.length < 2 ? null : [...words].sort().join(' ');
};

/** The text's words in every other order, up to five words (120 lookups); longer texts keep their order only. */
function otherWordOrders(key: string): string[] {
  const words = key.split(' ');
  if (words.length < 2 || words.length > 5) return [];
  const orders = new Set<string>();
  const permute = (rest: string[], taken: string[]): void => {
    if (rest.length === 0) { orders.add(taken.join(' ')); return; }
    rest.forEach((word, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...taken, word]));
  };
  permute(words, []);
  orders.delete(key);
  return [...orders];
}

/** A footballer's name as some universe knows it: `raw` is the normalised name, before footballGridMatchKey folding. */
export interface FootballGridNamesake {
  playerId: string;
  raw: string;
}

/**
 * Footballers beyond the board, by name. Their names take part in the exact and folded readings like the board's own,
 * so a text that is, as typed, another footballer's name is read as that footballer and never forgiven as a typo of a
 * right answer (a sibling one letter from the answer is a different player, not a slip): the word games' tier-2 veto
 * (footballers.universe.ts pickAmong).
 */
export interface FootballGridNameUniverse {
  holders(matchKey: string): readonly FootballGridNamesake[];
}

export type FootballGridNameIndex = Map<string, FootballGridNamesake[]>;

export function footballGridNameIndex(names: Iterable<{ playerId: string; normalized: string }>): FootballGridNameIndex {
  return footballGridAddNames(new Map(), names);
}

export function footballGridAddNames(index: FootballGridNameIndex, names: Iterable<{ playerId: string; normalized: string }>): FootballGridNameIndex {
  for (const { playerId, normalized } of names) {
    const key = footballGridMatchKey(normalized);
    if (!key) continue;
    const holders = index.get(key);
    if (!holders) index.set(key, [{ playerId, raw: normalized }]);
    else if (!holders.some((holder) => holder.playerId === playerId && holder.raw === normalized)) holders.push({ playerId, raw: normalized });
  }
  return index;
}

type AliasesByPlayer = ReadonlyMap<string, readonly FootballGridAliasRecord[]>;
const releaseIndexes = new WeakMap<AliasesByPlayer, FootballGridNameIndex>();

function releaseIndex(aliasesByPlayer: AliasesByPlayer): FootballGridNameIndex {
  let index = releaseIndexes.get(aliasesByPlayer);
  if (!index) {
    index = footballGridNameIndex([...aliasesByPlayer].flatMap(([playerId, aliases]) =>
      aliases.map((alias) => ({ playerId, normalized: alias.normalizedAlias }))));
    releaseIndexes.set(aliasesByPlayer, index);
  }
  return index;
}

/** The universe as it stands now, kept for one command: a background reload cannot change a re-reading of the same answer. */
export function footballGridUniverseSnapshot(universe: FootballGridNameUniverse): FootballGridNameUniverse {
  const seen = new Map<string, readonly FootballGridNamesake[]>();
  return {
    holders(matchKey) {
      let holders = seen.get(matchKey);
      if (!holders) seen.set(matchKey, (holders = universe.holders(matchKey)));
      return holders;
    },
  };
}

/**
 * Every footballer of the Grid alias releases a board reads (indexed once per release map, cached by identity), plus
 * `more` (football-grid-namesakes.ts: every footballer's name).
 */
export function footballGridNameUniverse(
  releases: Iterable<AliasesByPlayer>,
  more?: FootballGridNameUniverse | null,
): FootballGridNameUniverse {
  const indexes = [...new Set(releases)].map(releaseIndex);
  return {
    holders(matchKey) {
      const found = indexes.flatMap((index) => index.get(matchKey) ?? []);
      return more ? [...found, ...more.holders(matchKey)] : found;
    },
  };
}

interface Entry {
  alias: FootballGridAliasRecord;
  key: string;
}

interface EntryIndex {
  byKey: Map<string, Entry[]>;
  byWordSet: Map<string, Entry[]>;
  /** By key length, then by key: a typo distance is computed once per distinct key. */
  byLength: Map<number, Map<string, Entry[]>>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexEntries(aliases: readonly FootballGridAliasRecord[]): EntryIndex {
  const index: EntryIndex = { byKey: new Map(), byWordSet: new Map(), byLength: new Map() };
  for (const alias of aliases) {
    const key = footballGridMatchKey(alias.normalizedAlias);
    if (!key) continue;
    const entry = { alias, key };
    push(index.byKey, key, entry);
    const wordSet = wordSetKey(key);
    if (wordSet) push(index.byWordSet, wordSet, entry);
    let sameLength = index.byLength.get(key.length);
    if (!sameLength) index.byLength.set(key.length, (sameLength = new Map()));
    push(sameLength, key, entry);
  }
  return index;
}

// Board content (its alias array and its names array) is cached per board/match: the index work runs once per board.
const aliasIndexes = new WeakMap<readonly FootballGridAliasRecord[], EntryIndex>();
const formIndexes = new WeakMap<readonly FootballGridPlayerNameRecord[], EntryIndex>();

function cachedIndex<T extends object>(cache: WeakMap<T, EntryIndex>, source: T, build: () => readonly FootballGridAliasRecord[]): EntryIndex {
  let index = cache.get(source);
  if (!index) cache.set(source, (index = indexEntries(build())));
  return index;
}

function diagnostics(
  reason: FootballGridResolutionDiagnostics['reason'],
  method: FootballGridResolutionDiagnostics['method'],
  candidates: Array<{ playerId: string }> = [],
  cellCandidateCount = 0,
): FootballGridResolvedAnswer['diagnostics'] {
  const ids = [...new Set(candidates.map((candidate) => candidate.playerId))].sort();
  return {
    version: 1, reason, method, candidatePlayerIds: ids.slice(0, 20),
    candidateCount: ids.length, candidatesTruncated: ids.length > 20, cellCandidateCount,
  };
}

type Method = Exclude<FootballGridResolutionDiagnostics['method'], 'none'>;

/**
 * Several footballers right for the cell answer to the typed name (a surname two qualifying players share): every one of
 * them is right, so the best known (the cell's answer order) is credited, as Squad Spin does. Only while none of them
 * is used yet: once one is, the name may well mean that one again, and the player is asked for more (free) instead
 * of being handed the other.
 */
function classifyCandidates(input: {
  candidates: FootballGridAliasRecord[];
  validRank: Map<string, number>;
  usedPlayerIds: Set<string>;
  normalizedInput: string;
  method: Method;
}): FootballGridResolvedAnswer {
  // One record per player, a published alias (it has an id) over a name form or a universe name.
  const byPlayer = new Map<string, FootballGridAliasRecord>();
  for (const alias of input.candidates) {
    if (!input.validRank.has(alias.playerId)) continue;
    const kept = byPlayer.get(alias.playerId);
    if (!kept || (!kept.id && alias.id)) byPlayer.set(alias.playerId, alias);
  }
  const cellCandidates = [...byPlayer.values()].sort((a, b) => input.validRank.get(a.playerId)! - input.validRank.get(b.playerId)!);

  if (cellCandidates.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('recognized_not_in_cell', input.method, input.candidates) };
  }
  const usedCount = cellCandidates.filter((alias) => input.usedPlayerIds.has(alias.playerId)).length;
  if (usedCount > 0 && usedCount < cellCandidates.length) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('multiple_cell_candidates', input.method, input.candidates, cellCandidates.length) };
  }
  const candidate = cellCandidates[0];
  const method = !candidate.id && (input.method === 'exact' || input.method === 'orthographic') ? 'name_form' : input.method;
  if (usedCount > 0) {
    return { outcome: 'already_used', playerId: candidate.playerId, aliasId: candidate.id || null, normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('player_already_used', method, input.candidates, cellCandidates.length) };
  }
  return { outcome: 'correct', playerId: candidate.playerId, aliasId: candidate.id || null, normalizedInput: input.normalizedInput,
    diagnostics: diagnostics('accepted', method, input.candidates, cellCandidates.length) };
}

const universeRecord = (holder: FootballGridNamesake): FootballGridAliasRecord =>
  ({ id: '', playerId: holder.playerId, alias: holder.raw, normalizedAlias: holder.raw, locale: 'en', acceptancePolicy: 'exact' });

export function resolveFootballGridAnswer(input: {
  submittedText: string;
  /** The board's aliases. Keep the array's identity stable per board: its index is cached on it. */
  aliases: readonly FootballGridAliasRecord[];
  /** Best known first: when several of them answer to the typed name, the first is credited. */
  validPlayerIds: Iterable<string>;
  boardPlayerIds: Iterable<string>;
  usedPlayerIds: Iterable<string>;
  validPlayerNames: FootballGridPlayerNameRecord[];
  /**
   * Every board player's names (stable identity per board, its index is cached on it): other board players' name forms
   * then compete with the right answers' in the exact and typo readings. Without it only the valid names are read.
   */
  boardPlayerNames?: readonly FootballGridPlayerNameRecord[];
  /** Footballers beyond the board. Without it a typo is judged against the board only. */
  universe?: FootballGridNameUniverse;
  /** Internal: a re-reading of a shortened text never forgives typos on top. */
  exactOnly?: boolean;
}): FootballGridResolvedAnswer {
  const normalizedInput = normalizeFootballGridAnswer(input.submittedText);
  if (!normalizedInput) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput, diagnostics: diagnostics('empty_input', 'none') };
  }
  const validRank = new Map<string, number>();
  for (const playerId of input.validPlayerIds) if (!validRank.has(playerId)) validRank.set(playerId, validRank.size);
  const usedPlayerIds = new Set(input.usedPlayerIds);
  const matchKey = footballGridMatchKey(normalizedInput);
  const indexes = [
    cachedIndex(aliasIndexes, input.aliases, () => input.aliases),
    input.boardPlayerNames
      ? cachedIndex(formIndexes, input.boardPlayerNames, () => footballGridNameFormCandidates([...input.boardPlayerNames!]))
      : indexEntries(footballGridNameFormCandidates(input.validPlayerNames)),
  ];
  const classify = (candidates: FootballGridAliasRecord[], method: Method) =>
    classifyCandidates({ candidates, validRank, usedPlayerIds, normalizedInput, method });

  // Exact identity first, then keyboard-folded variants (Turkish ı, ß, ø, æ, ł…): a weaker fidelity never reinterprets
  // a stronger one. At each fidelity the board's aliases, the board players' name forms and the universe's footballers
  // are read together and the cell decides: a surname naming another cell's player and this cell's (by his name
  // form alone) is this cell's; a text that only names footballers outside the cell is refused, never read as a typo.
  const folded = [
    ...indexes.flatMap((index) => (index.byKey.get(matchKey) ?? []).map((entry) => entry.alias)),
    ...(input.universe?.holders(matchKey) ?? []).map(universeRecord),
  ];
  const exactHits = folded.filter((alias) => alias.normalizedAlias === normalizedInput);
  if (exactHits.length > 0) return classify(exactHits, 'exact');
  if (folded.length > 0) return classify(folded, 'orthographic');

  const wordSet = wordSetKey(matchKey);
  // The universe is keyed by exact name, so its footballers are looked up in each other word order ("Bellingham Jobe").
  const reordered = wordSet === null ? [] : [
    ...indexes.flatMap((index) => (index.byWordSet.get(wordSet) ?? []).map((entry) => entry.alias)),
    ...(input.universe ? otherWordOrders(matchKey).flatMap((key) => input.universe!.holders(key)).map(universeRecord) : []),
  ];
  if (reordered.length > 0) {
    // As above, the spelling as typed before its folded variant.
    const rawWordSet = wordSetKey(normalizedInput);
    const rawHits = reordered.filter((alias) => wordSetKey(alias.normalizedAlias) === rawWordSet);
    return classify(rawHits.length > 0 ? rawHits : reordered, 'word_order');
  }

  // A Russian full name as in a passport: "Name Patronymic Surname" (or surname first). Read again without the middle
  // name — the patronymic, or the one middle word of three — at exact fidelity only.
  if (!input.exactOnly) {
    const rereads = withoutMiddleName(normalizedInput)
      .map((shortened) => resolveFootballGridAnswer({ ...input, submittedText: shortened, exactOnly: true }))
      .filter((reread) => reread.diagnostics.reason !== 'no_matching_alias');
    // The readings are read together, as one: a used and an unused right answer between them is ambiguous, as for a
    // shared name; otherwise the best-known right answer (validPlayerIds order) wins, as everywhere.
    const mixed = rereads.find((candidate) => candidate.outcome === 'ambiguous')
      ?? (rereads.some((candidate) => candidate.outcome === 'already_used') && rereads.some((candidate) => candidate.outcome === 'correct')
        ? { outcome: 'ambiguous' as const, playerId: null, aliasId: null, normalizedInput,
          diagnostics: diagnostics('multiple_cell_candidates', 'exact', rereads.flatMap((r) => (r.playerId ? [{ playerId: r.playerId }] : [])), rereads.filter((r) => r.playerId).length) }
        : undefined);
    if (mixed) return { ...mixed, normalizedInput };
    const correct = rereads.filter((candidate) => candidate.outcome === 'correct')
      .sort((a, b) => (validRank.get(a.playerId!) ?? Infinity) - (validRank.get(b.playerId!) ?? Infinity));
    // Failing that, a right answer already played names the cell's player better than a reading outside the cell.
    const reread = correct[0] ?? rereads.find((candidate) => candidate.outcome === 'already_used') ?? rereads[0];
    if (reread) return { ...reread, normalizedInput };
  }

  const limit = input.exactOnly ? 0 : footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput, diagnostics: diagnostics('no_matching_alias', 'none') };
  }
  // A typo is credited only to a right answer's name: a safe_typo alias of any length, otherwise (input and name both
  // from NAME_FORM_TYPO_MIN_LENGTH) any published alias — ka/ru transliterations and nicknames included — or name form.
  // Every other board player's names, short ones included, compete for the nearest spot, so a slip on one of THEIR
  // names is never read as a right answer that happens to be as near or a letter further away.
  const longEnough = normalizedInput.length >= NAME_FORM_TYPO_MIN_LENGTH;
  const receives = (entry: Entry) => validRank.has(entry.alias.playerId)
    && (entry.alias.acceptancePolicy === 'safe_typo' || (longEnough && entry.key.length >= NAME_FORM_TYPO_MIN_LENGTH));
  // Nearest over every board name first (one distance per distinct key); who may be credited is decided after.
  const byKey = new Map<string, Entry[]>();
  for (let length = matchKey.length - limit; length <= matchKey.length + limit; length += 1) {
    for (const index of indexes) {
      for (const [key, entries] of index.byLength.get(length) ?? []) {
        const same = byKey.get(key);
        if (same) same.push(...entries);
        else byKey.set(key, [...entries]);
      }
    }
  }
  let minimumDistance = limit + 1;
  let nearest: Entry[] = [];
  for (const [key, entries] of byKey) {
    const distance = boundedTypoDistance(matchKey, key, Math.min(limit, minimumDistance));
    if (distance > limit) continue;
    if (distance < minimumDistance) {
      minimumDistance = distance;
      nearest = [...entries];
    } else if (distance === minimumDistance) {
      nearest.push(...entries);
    }
  }
  const credited = nearest.filter(receives);
  const creditedPlayers = new Set(credited.map((entry) => entry.alias.playerId));
  // A nearest name that cannot take the credit (another board player's, or a right answer's too short to absorb a
  // typo) blocks it: the text may well be that one.
  const blockers = nearest.filter((entry) => !creditedPlayers.has(entry.alias.playerId));
  const nearestAliases = nearest.map((entry) => entry.alias);
  const method: Method = credited.some((entry) => entry.alias.id === '') ? 'name_form' : 'safe_typo';
  if (credited.length === 0) {
    // Only near another name: a suggestion, not an identification (the gap log and reports must not read it as one).
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics(nearest.length === 0 ? 'no_matching_alias' : 'nearest_typo_not_in_cell', nearest.length === 0 ? 'none' : method, nearestAliases) };
  }
  if (blockers.length > 0) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('multiple_typo_candidates', method, nearestAliases, creditedPlayers.size) };
  }
  return classify(credited.map((entry) => entry.alias), method);
}
