import type { GapObservation, GapVerdict } from '../content-gaps/content-gaps.buffer.js';

/** Resolver reasons worth a content check; every other reason (accepted, empty, already used) is not a content gap. */
const GAP_OF: Record<string, GapVerdict> = {
  no_matching_alias: 'unknown', recognized_not_in_cell: 'miss',
  multiple_cell_candidates: 'ambiguous', multiple_typo_candidates: 'ambiguous', nearest_typo_not_on_board: 'ambiguous',
};

/**
 * A refused or ambiguous Grid name as a content-gap observation, keyed by board cell (`<board id>#<cell>`): the Content
 * Fixer reads the cell's two criteria from it. Null when the resolver's reason is not a content question.
 */
export function footballGridGap(input: {
  game: 'football_grid' | 'grid_daily';
  mode: GapObservation['mode'];
  boardId: string;
  cellIndex: number;
  context: string;
  text: string;
  locale?: string | null;
  reason: string;
  playerId: string | null;
  candidatePlayerIds: readonly string[];
}): GapObservation | null {
  const verdict = GAP_OF[input.reason];
  if (!verdict) return null;
  return {
    game: input.game, mode: input.mode, boardKey: `${input.boardId}#${input.cellIndex}`, context: input.context, verdict,
    text: input.text, locale: input.locale ?? null,
    // A name recognised but not in the cell: the matcher's own reading of who it is.
    resolvedId: input.playerId ?? (verdict === 'miss' && input.candidatePlayerIds.length === 1 ? input.candidatePlayerIds[0] : null),
    candidateIds: input.candidatePlayerIds.length > 0 ? input.candidatePlayerIds.slice(0, 10) : null,
  };
}
