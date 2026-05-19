/**
 * Possession-mode realtime orchestration core.
 *
 * This file wires together the AI, halftime, and round-resolution flows for
 * possession-variant matches. It owns the module-scoped state that the wiring
 * depends on (active question timers, ready-ack gates) and the factory-bound
 * helpers (AI + halftime sub-modules), so it cannot be flattened into pure
 * re-exports without a deeper architectural refactor.
 *
 * The pure helpers (matching, timing, payload mappers, resolution, completion)
 * live in their own sibling modules; the answer handlers and answer-lock
 * utilities also live in dedicated files. This file re-exports those public
 * symbols so external consumers see a single import surface.
 */
import { logger } from '../core/logger.js';
import type { QuizballServer } from './socket-server.js';
import {
  buildPlayableQuestionTiming,
  parsePossessionState,
} from './possession-state.js';

import { createPossessionAi } from './possession-ai.js';
import { resolvePossessionRound } from './possession-round-resolver.js';
import { createPossessionHalftime } from './possession-halftime.js';
import {
  clueIndexForTimeMs,
  countdownMatch,
  normalizeAnswer,
} from './possession-answer-matching.js';
import {
  computeAuthoritativeTimeMs,
  computeResumedPossessionTiming,
} from './possession-timing.js';
import {
  questionTypeForState,
  selectedIndexForAnswerPersistence,
} from './possession-payload-mappers.js';
import {
  applyDeltaAndGoalCheck,
  applyLastAttackResolution,
  applyNormalResolution,
  categoryIdsForCurrentHalf,
  penaltyWinnerSeat,
} from './possession-resolution.js';
import { decideWinner } from './possession-completion.js';
import {
  clearQuestionTimer,
  sendPossessionMatchQuestion,
} from './possession-question-dispatch.js';
export {
  clearQuestionTimer,
  emitMatchState,
  emitPossessionStateToSocket,
  ensurePossessionActiveTimers,
  handlePossessionReadyForNextQuestion,
  resumePossessionMatchQuestion,
  scheduleNextPossessionQuestion,
  sendPossessionMatchQuestion,
} from './possession-question-dispatch.js';

export async function handlePossessionHalftimeUiReady(
  io: QuizballServer,
  userId: string,
  matchId: string
): Promise<void> {
  await handlePossessionHalftimeUiReadyInternal(io, userId, matchId);
}

// ── Initialize AI sub-module ──
// Forward declaration resolved: resolvePossessionRound is defined below and passed as callback.
const possessionAi = createPossessionAi(
  (io, matchId, qIndex, isTimeout) => resolvePossessionRound(io, matchId, qIndex, isTimeout)
);
const {
  resolveAiUserIdForMatch,
  runPossessionAiAnswer,
  schedulePossessionAiAnswer,
  clearAiAnswerTimer,
  clearAiMaps,
} = possessionAi;

// ── Initialize Halftime sub-module ──
const possessionHalftime = createPossessionHalftime({
  sendQuestion: (io, matchId, qIndex, opts) => sendPossessionMatchQuestion(io, matchId, qIndex, opts),
  resolveAiUserId: (matchId) => resolveAiUserIdForMatch(matchId),
});
const {
  clearHalftimeTimer,
  getHalftimeTurnSeat,
  ensureHalftimeCategories,
  resolveHalftimeResult,
  finalizeHalftime,
  scheduleFinalizeHalftime,
  scheduleHalftimeTimeout,
  schedulePossessionAiHalftimeBan,
  handlePossessionHalftimeUiReady: handlePossessionHalftimeUiReadyInternal,
} = possessionHalftime;

export {
  clearAiAnswerTimer,
  clearAiMaps,
  clearHalftimeTimer,
  ensureHalftimeCategories,
  finalizeHalftime,
  getHalftimeTurnSeat,
  resolveAiUserIdForMatch,
  runPossessionAiAnswer,
  scheduleFinalizeHalftime,
  scheduleHalftimeTimeout,
  schedulePossessionAiAnswer,
  schedulePossessionAiHalftimeBan,
};


export function fireAndForget(label: string, fn: () => Promise<unknown>): void {
  fn().catch((error) => {
    logger.error({ error, label }, 'Fire-and-forget DB write failed');
  });
}

export {
  handlePossessionAnswer,
  handlePossessionCluesAnswer,
  handlePossessionCountdownGuess,
  handlePossessionPutInOrderAnswer,
} from './possession-answer-handlers.js';

export { devSkipToPossessionPhase } from './possession-dev-skip.js';
export { handlePossessionHalftimeBan } from './possession-halftime-ban.js';
export { resolvePossessionRound };

export function cancelPossessionQuestionTimer(matchId: string, qIndex: number): void {
  clearQuestionTimer(matchId, qIndex);
  clearAiAnswerTimer(matchId, qIndex);
}

export function cancelPossessionHalftimeTimer(matchId: string): void {
  clearHalftimeTimer(matchId);
  clearAiMaps(matchId);
}

export const __possessionInternals = {
  parsePossessionState,
  categoryIdsForCurrentHalf,
  questionTypeForState,
  buildPlayableQuestionTiming,
  computeResumedPossessionTiming,
  clueIndexForTimeMs,
  computeAuthoritativeTimeMs,
  applyDeltaAndGoalCheck,
  applyNormalResolution,
  applyLastAttackResolution,
  resolveHalftimeResult,
  penaltyWinnerSeat,
  decideWinner,
  normalizeAnswer,
  countdownMatch,
  selectedIndexForAnswerPersistence,
};
