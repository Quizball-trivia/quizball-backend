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

/**
 * Name forms of a valid answer: the full normalised name plus every token
 * suffix ("ramiro funes mori" → "funes mori" → "mori"), en and ka. The alias
 * releases are missing surname aliases for many players (and compound
 * surnames never got one), so typed surnames of valid answers were marked
 * wrong even though the cell's reveal then showed exactly that name. Synthetic
 * candidates carry an empty alias id, persisted as NULL on the claim.
 */
export function footballGridNameFormCandidates(players: FootballGridPlayerNameRecord[]): FootballGridAliasRecord[] {
  const forms: FootballGridAliasRecord[] = [];
  for (const player of players) {
    for (const [name, locale] of [[player.nameEn, 'en'], [player.nameKa, 'ka']] as Array<[string | null, 'en' | 'ka']>) {
      const normalized = name ? normalizeFootballGridAnswer(name) : '';
      if (!normalized) continue;
      const tokens = normalized.split(' ');
      for (let i = 0; i < tokens.length; i += 1) {
        const form = tokens.slice(i).join(' ');
        if (form.length < 2) continue;
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
  validPlayerNames?: FootballGridPlayerNameRecord[];
}): FootballGridResolvedAnswer {
  const normalizedInput = normalizeFootballGridAnswer(input.submittedText);
  if (!normalizedInput) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('empty_input', 'none') };
  }
  const validPlayerIds = new Set(input.validPlayerIds);
  const boardPlayerIds = new Set(input.boardPlayerIds);
  const usedPlayerIds = new Set(input.usedPlayerIds);
  const exact = input.aliases.filter((alias) => alias.normalizedAlias === normalizedInput);
  if (exact.length > 0) {
    return classifyCandidates({ candidates: exact, validPlayerIds, usedPlayerIds, normalizedInput, method: 'exact' });
  }

  // Keep exact identity matches authoritative. Then allow Turkish dotted / dotless
  // i keyboard variants and ß/SS case variants against ALL alias owners.
  // Never rewrite published aliases or guess between multiple qualifying players.
  const keyboardKey = footballGridOrthographicKey(normalizedInput);
  const orthographic = input.aliases.filter((alias) => footballGridOrthographicKey(alias.normalizedAlias) === keyboardKey);
  if (orthographic.length > 0) {
    return classifyCandidates({ candidates: orthographic, validPlayerIds, usedPlayerIds, normalizedInput, method: 'orthographic' });
  }

  // Alias releases miss surname forms for many players, so a typed surname of
  // a VALID answer fell through to "wrong" even though the reveal then showed
  // that very name. Name forms are generated only for the cell's valid
  // players: anything else still resolves purely through published aliases.
  const nameForms = footballGridNameFormCandidates(input.validPlayerNames ?? []);
  const nameFormMatches = nameForms.filter((form) => footballGridOrthographicKey(form.normalizedAlias) === keyboardKey);
  if (nameFormMatches.length > 0) {
    return classifyCandidates({ candidates: nameFormMatches, validPlayerIds, usedPlayerIds, normalizedInput, method: 'name_form' });
  }

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('no_matching_alias', 'none') };
  }
  const fuzzy = [
    // Exact aliases are deliberately exact-only. Only aliases that were
    // individually reviewed as safe typo targets may broaden acceptance —
    // plus the valid answers' own name forms, where a near-miss can only
    // point at a player that is right for the cell anyway.
    ...input.aliases.filter((alias) => alias.acceptancePolicy === 'safe_typo'),
    ...nameForms,
  ]
    .map((alias) => ({ alias, distance: boundedLevenshtein(keyboardKey, footballGridOrthographicKey(alias.normalizedAlias), limit) }))
    .filter((candidate) => candidate.distance <= limit);
  if (fuzzy.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics('no_matching_alias', 'none') };
  }
  const minimumDistance = Math.min(...fuzzy.map((candidate) => candidate.distance));
  const nearestOnBoard = fuzzy
    .filter((candidate) => candidate.distance === minimumDistance)
    .map((candidate) => candidate.alias)
    .filter((alias) => boardPlayerIds.has(alias.playerId));
  const uniqueBoardPlayers = new Set(nearestOnBoard.map((alias) => alias.playerId));
  if (uniqueBoardPlayers.size !== 1) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput,
      diagnostics: diagnostics(uniqueBoardPlayers.size === 0 ? 'nearest_typo_not_on_board' : 'multiple_typo_candidates',
        'safe_typo', fuzzy.filter((candidate) => candidate.distance === minimumDistance).map((candidate) => candidate.alias),
        new Set(nearestOnBoard.filter((alias) => validPlayerIds.has(alias.playerId)).map((alias) => alias.playerId)).size) };
  }
  return classifyCandidates({
    candidates: nearestOnBoard,
    validPlayerIds,
    usedPlayerIds,
    normalizedInput,
    method: 'safe_typo',
  });
}
