import type { QuizballServer } from './socket-server.js';
import { matchesRepo } from '../modules/matches/matches.repo.js';
import { logger } from '../core/logger.js';
import { resolveMatchVariant } from '../modules/matches/matches.service.js';
import {
  cancelPossessionQuestionTimer,
  resolvePossessionRound,
  sendPossessionMatchQuestion,
} from './possession-match-flow.js';
import {
  cancelPartyQuizQuestionTimer,
  resolvePartyQuizRound,
  sendPartyQuizQuestion,
} from './party-quiz-match-flow.js';

export const QUESTION_TIME_MS = 10000;

export function cancelMatchQuestionTimer(matchId: string, qIndex: number): void {
  cancelPossessionQuestionTimer(matchId, qIndex);
  cancelPartyQuizQuestionTimer(matchId, qIndex);
}

export async function sendMatchQuestion(
  io: QuizballServer,
  matchId: string,
  qIndex: number
): Promise<{ correctIndex: number } | null> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) {
    logger.warn({ matchId, qIndex }, 'Match not found for question');
    return null;
  }

  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (variant === 'friendly_party_quiz') {
    return sendPartyQuizQuestion(io, matchId, qIndex);
  }

  return sendPossessionMatchQuestion(io, matchId, qIndex);
}

export async function resolveRound(
  io: QuizballServer,
  matchId: string,
  qIndex: number,
  fromTimeout = false
): Promise<void> {
  const match = await matchesRepo.getMatch(matchId);
  if (!match) {
    logger.warn({ matchId, qIndex }, 'Match not found for round resolution');
    return;
  }

  const variant = resolveMatchVariant(match.state_payload, match.mode);
  if (variant === 'friendly_party_quiz') {
    await resolvePartyQuizRound(io, matchId, qIndex, fromTimeout);
    return;
  }

  await resolvePossessionRound(io, matchId, qIndex, fromTimeout);
}
