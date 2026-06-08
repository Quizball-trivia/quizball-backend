import type { MatchVariant } from '../socket.types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildForfeitCompletedStatePayload(
  statePayload: unknown,
  variant: MatchVariant
): Record<string, unknown> {
  const base = isRecord(statePayload) ? { ...statePayload } : {};

  if (variant === 'friendly_party_quiz') {
    return {
      ...base,
      winnerDecisionMethod: 'forfeit',
    };
  }

  return {
    ...base,
    phase: 'COMPLETED',
    currentQuestion: null,
    winnerDecisionMethod: 'forfeit',
  };
}
