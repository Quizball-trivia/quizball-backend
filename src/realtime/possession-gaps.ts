import type { GapObservation } from '../modules/content-gaps/content-gaps.buffer.js';
import { revisionOf } from '../modules/content-gaps/content-gaps.context.js';

/**
 * A Ranked typed answer the matcher refused, as a content-gap observation for the Content Fixer. Keyed by question, with
 * the accepted set it was judged against as the context (an edited question is a new context). Only real players'
 * guesses on our own questions: AI opponents, partner pools, give-ups and questions without an id are not gaps.
 */
export function rankedGap(input: {
  game: 'clue_chain' | 'countdown_list';
  questionId: string | null | undefined;
  accepted: object;
  guess: string;
  isAi: boolean;
  partnerPool: unknown;
}): GapObservation | null {
  if (input.isAi || input.partnerPool || !input.questionId || !input.guess.trim()) return null;
  return {
    game: input.game, mode: 'realtime', boardKey: input.questionId, context: revisionOf(input.accepted),
    verdict: 'miss', text: input.guess, locale: null,
  };
}
