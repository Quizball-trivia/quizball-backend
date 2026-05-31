import {
  createInitialPartyQuizState,
  type PartyQuizStatePayload,
} from '../modules/matches/matches.service.js';
import type { MatchPlayerRow, MatchRow } from '../modules/matches/matches.types.js';

export function sanitizePartyQuizState(raw: unknown, totalQuestions: number): PartyQuizStatePayload {
  const fallback = createInitialPartyQuizState(totalQuestions);
  if (!raw || typeof raw !== 'object') {
    return fallback;
  }

  const candidate = raw as Partial<PartyQuizStatePayload>;
  return {
    version: 1,
    variant: 'friendly_party_quiz',
    totalQuestions,
    currentQuestion:
      candidate.currentQuestion && typeof candidate.currentQuestion.qIndex === 'number'
        ? {
          qIndex: Math.max(0, candidate.currentQuestion.qIndex),
          ...(typeof candidate.currentQuestion.correctIndex === 'number'
            ? { correctIndex: candidate.currentQuestion.correctIndex }
            : {}),
        }
        : null,
    answeredUserIds: Array.isArray(candidate.answeredUserIds)
      ? candidate.answeredUserIds.filter((userId): userId is string => typeof userId === 'string')
      : [],
    droppedUserIds: Array.isArray(candidate.droppedUserIds)
      ? [...new Set(candidate.droppedUserIds.filter((userId): userId is string => typeof userId === 'string'))]
      : [],
    winnerDecisionMethod:
      candidate.winnerDecisionMethod === 'total_points' || candidate.winnerDecisionMethod === 'forfeit'
        ? candidate.winnerDecisionMethod
        : null,
    stateVersionCounter: Math.max(0, Number(candidate.stateVersionCounter ?? 0)),
  };
}

export function getDroppedUserIds(state: Pick<PartyQuizStatePayload, 'droppedUserIds'>): string[] {
  return state.droppedUserIds;
}

export function isPartyQuizDropped(state: Pick<PartyQuizStatePayload, 'droppedUserIds'>, userId: string): boolean {
  return state.droppedUserIds.includes(userId);
}

export function isUserDroppedFromPartyMatch(match: MatchRow, userId: string): boolean {
  const statePayload = match.state_payload as Partial<PartyQuizStatePayload> | null;
  if (statePayload?.variant !== 'friendly_party_quiz') return false;
  return isPartyQuizDropped(sanitizePartyQuizState(match.state_payload, match.total_questions), userId);
}

export function getActivePartyPlayers(
  players: MatchPlayerRow[],
  droppedUserIds: Iterable<string>
): MatchPlayerRow[] {
  const dropped = new Set(droppedUserIds);
  return players.filter((player) => !dropped.has(player.user_id));
}
