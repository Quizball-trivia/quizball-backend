import { logger } from '../../core/logger.js';
import { contentGaps } from '../content-gaps/content-gaps.recorder.js';
import { footballGridGap } from './football-grid-gaps.js';
import { footballGridSoloService } from './football-grid-solo.service.js';

const DEDUPE_MS = 2 * 60_000;
const seen = new Map<string, number>();

/** True the first time (board, cell, text) is seen in the window: a retried or repeated request counts once. */
function fresh(boardId: string, cellIndex: number, text: string, now = Date.now()): boolean {
  const key = `${boardId}#${cellIndex}|${text.trim().toLowerCase()}`;
  const at = seen.get(key);
  if (at !== undefined && now - at < DEDUPE_MS) return false;
  if (seen.size >= 5_000) {
    for (const [k, t] of seen) if (now - t >= DEDUPE_MS) seen.delete(k);
    if (seen.size >= 5_000) seen.clear();
  }
  seen.set(key, now);
  return true;
}

/**
 * Same-phone (solo) Tic Tac Toe has no game write to wait for: a refused typed name is logged after the verdict was sent,
 * as game football_grid in practice mode. Never delays or fails the answer.
 */
export function noteSoloGap(input: { boardId: string; cellIndex: number; text: string; locale?: string | null }): void {
  if (!input.text.trim() || !fresh(input.boardId, input.cellIndex, input.text)) return;
  void footballGridSoloService.diagnose(input).then((d) => {
    const gap = footballGridGap({
      game: 'football_grid', mode: 'practice', boardId: input.boardId, cellIndex: input.cellIndex, context: `${input.boardId}|${d.revision}`,
      text: input.text, locale: input.locale ?? null, reason: d.reason, playerId: d.playerId, candidatePlayerIds: d.candidatePlayerIds,
    });
    if (gap) contentGaps.record(gap);
  }).catch((error: unknown) => logger.warn({ err: error }, 'Solo grid gap diagnosis failed'));
}

export const __test = { fresh, reset: () => seen.clear() };
