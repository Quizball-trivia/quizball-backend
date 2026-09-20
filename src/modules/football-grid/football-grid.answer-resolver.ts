import type {
  FootballGridAliasRecord,
  FootballGridResolvedAnswer,
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

function classifyCandidates(input: {
  candidates: FootballGridAliasRecord[];
  validPlayerIds: Set<string>;
  usedPlayerIds: Set<string>;
  normalizedInput: string;
}): FootballGridResolvedAnswer {
  const cellCandidates = [...new Map(
    input.candidates
      .filter((alias) => input.validPlayerIds.has(alias.playerId))
      .map((alias) => [alias.playerId, alias]),
  ).values()];

  if (cellCandidates.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput: input.normalizedInput };
  }
  if (cellCandidates.length > 1) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput: input.normalizedInput };
  }
  const candidate = cellCandidates[0];
  if (input.usedPlayerIds.has(candidate.playerId)) {
    return {
      outcome: 'already_used',
      playerId: candidate.playerId,
      aliasId: candidate.id,
      normalizedInput: input.normalizedInput,
    };
  }
  return {
    outcome: 'correct',
    playerId: candidate.playerId,
    aliasId: candidate.id,
    normalizedInput: input.normalizedInput,
  };
}

export function resolveFootballGridAnswer(input: {
  submittedText: string;
  aliases: FootballGridAliasRecord[];
  validPlayerIds: Iterable<string>;
  boardPlayerIds: Iterable<string>;
  usedPlayerIds: Iterable<string>;
}): FootballGridResolvedAnswer {
  const normalizedInput = normalizeFootballGridAnswer(input.submittedText);
  if (!normalizedInput) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput };
  }
  const validPlayerIds = new Set(input.validPlayerIds);
  const boardPlayerIds = new Set(input.boardPlayerIds);
  const usedPlayerIds = new Set(input.usedPlayerIds);
  const exact = input.aliases.filter((alias) => alias.normalizedAlias === normalizedInput);
  if (exact.length > 0) {
    return classifyCandidates({ candidates: exact, validPlayerIds, usedPlayerIds, normalizedInput });
  }

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput };
  }
  const fuzzy = input.aliases
    // Exact aliases are deliberately exact-only. Only aliases that were
    // individually reviewed as safe typo targets may broaden acceptance.
    .filter((alias) => alias.acceptancePolicy === 'safe_typo')
    .map((alias) => ({ alias, distance: boundedLevenshtein(normalizedInput, alias.normalizedAlias, limit) }))
    .filter((candidate) => candidate.distance <= limit);
  if (fuzzy.length === 0) {
    return { outcome: 'wrong', playerId: null, aliasId: null, normalizedInput };
  }
  const minimumDistance = Math.min(...fuzzy.map((candidate) => candidate.distance));
  const nearestOnBoard = fuzzy
    .filter((candidate) => candidate.distance === minimumDistance)
    .map((candidate) => candidate.alias)
    .filter((alias) => boardPlayerIds.has(alias.playerId));
  const uniqueBoardPlayers = new Set(nearestOnBoard.map((alias) => alias.playerId));
  if (uniqueBoardPlayers.size !== 1) {
    return { outcome: 'ambiguous', playerId: null, aliasId: null, normalizedInput };
  }
  return classifyCandidates({
    candidates: nearestOnBoard,
    validPlayerIds,
    usedPlayerIds,
    normalizedInput,
  });
}
