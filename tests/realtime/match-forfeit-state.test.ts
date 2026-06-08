import { describe, expect, it } from 'vitest';
import { buildForfeitCompletedStatePayload } from '../../src/realtime/services/match-forfeit-state.js';

describe('buildForfeitCompletedStatePayload', () => {
  it('marks possession forfeits as terminal and clears the active question', () => {
    const payload = buildForfeitCompletedStatePayload(
      {
        version: 1,
        variant: 'ranked_sim',
        phase: 'PENALTY_SHOOTOUT',
        currentQuestion: {
          qIndex: 13,
          phaseKind: 'penalty',
          phaseRound: 1,
          shooterSeat: 2,
          attackerSeat: null,
        },
        penalty: {
          round: 2,
          shooterSeat: 2,
        },
      },
      'ranked_sim'
    );

    expect(payload).toMatchObject({
      variant: 'ranked_sim',
      phase: 'COMPLETED',
      currentQuestion: null,
      winnerDecisionMethod: 'forfeit',
      penalty: {
        round: 2,
        shooterSeat: 2,
      },
    });
  });

  it('does not add possession-only phase fields to party quiz state', () => {
    const payload = buildForfeitCompletedStatePayload(
      {
        version: 1,
        variant: 'friendly_party_quiz',
        currentQuestion: null,
      },
      'friendly_party_quiz'
    );

    expect(payload).toEqual({
      version: 1,
      variant: 'friendly_party_quiz',
      currentQuestion: null,
      winnerDecisionMethod: 'forfeit',
    });
    expect(payload).not.toHaveProperty('phase');
  });
});
