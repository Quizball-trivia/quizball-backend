import { boundedLevenshtein, footballGridTypoDistanceLimit, normalizeFootballGridAnswer } from '../football-grid/football-grid.answer-resolver.js';
import type { SquadSpinAliasRow } from './squad-spin.types.js';

/**
 * Resolves typed text against the aliases of the combo's VALID answers only, so
 * any match is a correct answer. Exact (normalised) matches accept every alias;
 * typos are tolerated only through aliases reviewed as `safe_typo`, with the
 * same length-scaled distance limit the live Grid uses. Several valid players
 * sharing a surname resolve to the nearest one — all of them are right anyway.
 */
export function resolveSquadSpinAnswer(submittedText: string, aliases: SquadSpinAliasRow[]): { playerId: string | null; normalizedInput: string } {
  const normalizedInput = normalizeFootballGridAnswer(submittedText);
  if (!normalizedInput) return { playerId: null, normalizedInput };

  const exact = aliases.find((alias) => alias.normalized_alias === normalizedInput);
  if (exact) return { playerId: exact.player_id, normalizedInput };

  const limit = footballGridTypoDistanceLimit(normalizedInput);
  if (limit === 0) return { playerId: null, normalizedInput };
  let best: { playerId: string; distance: number } | null = null;
  for (const alias of aliases) {
    if (alias.acceptance_policy !== 'safe_typo') continue;
    const distance = boundedLevenshtein(normalizedInput, alias.normalized_alias, limit);
    if (distance <= limit && (!best || distance < best.distance)) best = { playerId: alias.player_id, distance };
  }
  return { playerId: best?.playerId ?? null, normalizedInput };
}
