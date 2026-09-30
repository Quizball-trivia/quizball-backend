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
  return normalized.replace(/ı/g, 'i').replace(/ß/g, 'ss');
}

export interface FootballGridPlayerNameRecord {
  playerId: string;
  nameEn: string;
  nameKa: string | null;
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
    for (const [name, locale] of [[player.nameEn, 'en'], [player.nameKa, 'ka']] as Array<[string | null, 'en' | 'ka']>) {
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

function diagnostics(
  reason: FootballGridResolutionDiagnostics['reason'],
  method: FootballGridResolutionDiagnostics['method'],
  candidates: FootballGridAliasRecord[] = [],
  cellCandidateCount = 0,
): FootballGridResolutionDiagnostics {
  const ids = [...new Set(candidates.map((candidate) => candidate.playerId))].sort();
  return {
    version: 1, reason, method, candidatePlayerIds: ids.slice(0, 20),
    candidateCount: ids.length, candidatesTruncated: ids.length > 20, cellCandidateCount,
  };
}

function classifyCandidates(input: {
  candidates: FootballGridAliasRecord[];
  validPlayerIds: Set<string>;
  usedPlayerIds: Set<string>;
  normalizedInput: string;
  method: 'exact' | 'orthographic' | 'name_form' | 'safe_typo';
}): FootballGridResolvedAnswer {
  const cellCandidates = [...new Map(
    input.candidates
      .filter((alias) => input.validPlayerIds.has(alias.playerId))
      .map((alias) => [alias.playerId, alias]),
  ).values()];

  if (cellCandidates.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('recognized_not_in_cell', input.method, input.candidates) };
  }
  if (cellCandidates.length > 1) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('multiple_cell_candidates', input.method, input.candidates, cellCandidates.length) };
  }
  const candidate = cellCandidates[0];
  if (input.usedPlayerIds.has(candidate.playerId)) {
    return {
      outcome: 'already_used',
      playerId: candidate.playerId,
      aliasId: candidate.id || null,
      normalizedInput: input.normalizedInput,
      diagnostics: diagnostics('player_already_used', input.method, input.candidates, 1),
    };
  }
  return {
    outcome: 'correct',
    playerId: candidate.playerId,
    aliasId: candidate.id || null,
    normalizedInput: input.normalizedInput,
    diagnostics: diagnostics('accepted', input.method, input.candidates, 1),
  };
}

export function resolveFootballGridAnswer(input: {
  submittedText: string;
  aliases: FootballGridAliasRecord[];
  validPlayerIds: Iterable<string>;
  boardPlayerIds: Iterable<string>;
  usedPlayerIds: Iterable<string>;
  validPlayerNames: FootballGridPlayerNameRecord[];
}): FootballGridResolvedAnswer {
  const normalizedInput = normalizeFootballGridAnswer(input.submittedText);
  if (!normalizedInput) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('empty_input', 'none') };
  }
  const validPlayerIds = new Set(input.validPlayerIds);
  const boardPlayerIds = new Set(input.boardPlayerIds);
  const usedPlayerIds = new Set(input.usedPlayerIds);
  const keyboardKey = footballGridOrthographicKey(normalizedInput);
  const nameForms = footballGridNameFormCandidates(input.validPlayerNames);

  // Keep exact identity matches authoritative, then Turkish dotted/dotless i
  // and ß/SS keyboard variants — never letting a weaker fidelity reinterpret a
  // stronger one. Within one fidelity level, a published-alias hit that
  // belongs to another board player must NOT end resolution ("Silva" matching
  // cell B's Bernardo while cell A's valid Thiago Silva lacks a surname alias
  // is the reported bug): the valid answers' own name forms at the SAME
  // fidelity get a chance before recognized_not_in_cell is final.
  for (const fold of ['exact', 'orthographic'] as const) {
    const matches = fold === 'exact'
      ? (text: string) => text === normalizedInput
      : (text: string) => footballGridOrthographicKey(text) === keyboardKey;
    const aliasHits = input.aliases.filter((alias) => matches(alias.normalizedAlias));
    const formHits = nameForms.filter((form) => matches(form.normalizedAlias));
    if (aliasHits.length === 0 && formHits.length === 0) continue;
    if (aliasHits.length > 0) {
      const resolved = classifyCandidates({ candidates: aliasHits, validPlayerIds, usedPlayerIds, normalizedInput, method: fold });
      if (resolved.outcome !== 'wrong' || resolved.diagnostics.reason !== 'recognized_not_in_cell' || formHits.length === 0) {
        return resolved;
      }
    }
    // Either no alias matched at this fidelity, or the alias owner is not in
    // the cell and the cell's own name forms take over.
    return classifyCandidates({ candidates: formHits, validPlayerIds, usedPlayerIds, normalizedInput, method: 'name_form' });
  }

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('no_matching_alias', 'none') };
  }
  const fuzzy = [
    // Exact aliases are deliberately exact-only. Only aliases that were
    // individually reviewed as safe typo targets may broaden acceptance —
    // plus the valid answers' own longer name forms, where a near-miss can
    // only point at a player that is right for the cell anyway.
    ...input.aliases.filter((alias) => alias.acceptancePolicy === 'safe_typo'),
    ...(normalizedInput.length >= NAME_FORM_TYPO_MIN_LENGTH
      ? nameForms.filter((form) => form.normalizedAlias.length >= NAME_FORM_TYPO_MIN_LENGTH)
      : []),
  ]
    .map((alias) => ({ alias, distance: boundedLevenshtein(keyboardKey, footballGridOrthographicKey(alias.normalizedAlias), limit) }))
    .filter((candidate) => candidate.distance <= limit);
  if (fuzzy.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('no_matching_alias', 'none') };
  }
  const minimumDistance = Math.min(...fuzzy.map((candidate) => candidate.distance));
  const nearest = fuzzy.filter((candidate) => candidate.distance === minimumDistance).map((candidate) => candidate.alias);
  const nearestOnBoard = nearest.filter((alias) => boardPlayerIds.has(alias.playerId));
  const fuzzyMethod = nearestOnBoard.some((alias) => alias.id === '') ? 'name_form' : 'safe_typo';
  const uniqueBoardPlayers = new Set(nearestOnBoard.map((alias) => alias.playerId));
  if (uniqueBoardPlayers.size !== 1) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics(uniqueBoardPlayers.size === 0 ? 'nearest_typo_not_on_board' : 'multiple_typo_candidates',
        nearest.some((alias) => alias.id === '') ? 'name_form' : 'safe_typo', nearest,
        new Set(nearestOnBoard.filter((alias) => validPlayerIds.has(alias.playerId)).map((alias) => alias.playerId)).size) };
  }
  return classifyCandidates({
    candidates: nearestOnBoard,
    validPlayerIds,
    usedPlayerIds,
    normalizedInput,
    method: fuzzyMethod,
  });
}
