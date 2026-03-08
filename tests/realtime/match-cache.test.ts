import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import {
  answerCount,
  buildInitialCache,
  getCachedPlayer,
  getCachedPlayerBySeat,
  getExpectedUserIds,
  hasUserAnswered,
  type MatchCache,
} from '../../src/realtime/match-cache.js';

function createCache(): MatchCache {
  const state = createInitialPossessionState();
  return buildInitialCache({
    match: {
      id: 'm1',
      status: 'active',
      mode: 'friendly',
      total_questions: 12,
      category_a_id: 'cat-a',
      category_b_id: 'cat-b',
      started_at: new Date().toISOString(),
      current_q_index: 0,
      state_payload: state,
    },
    players: [
      {
        user_id: 'u1',
        seat: 1,
        total_points: 0,
        correct_answers: 0,
        goals: 0,
        penalty_goals: 0,
        avg_time_ms: null,
      },
      {
        user_id: 'u2',
        seat: 2,
        total_points: 0,
        correct_answers: 0,
        goals: 0,
        penalty_goals: 0,
        avg_time_ms: null,
      },
    ],
    state,
  });
}

describe('match-cache helpers', () => {
  it('resolves players by user id and seat', () => {
    const cache = createCache();
    expect(getCachedPlayer(cache, 'u1')?.seat).toBe(1);
    expect(getCachedPlayerBySeat(cache, 2)?.userId).toBe('u2');
  });

  it('tracks answer count and duplicate check', () => {
    const cache = createCache();
    cache.answers.u1 = {
      userId: 'u1',
      selectedIndex: 0,
      isCorrect: true,
      timeMs: 1500,
      pointsEarned: 80,
      phaseKind: 'normal',
      phaseRound: 1,
      shooterSeat: null,
      answeredAt: new Date().toISOString(),
    };

    expect(hasUserAnswered(cache, 'u1')).toBe(true);
    expect(hasUserAnswered(cache, 'u2')).toBe(false);
    expect(answerCount(cache)).toBe(1);
  });

  it('returns shooter+keeper as expected users in penalties', () => {
    const cache = createCache();
    cache.currentQuestion = {
      qIndex: 0,
      questionId: 'q1',
      correctIndex: 2,
      phaseKind: 'penalty',
      phaseRound: 1,
      shooterSeat: 2,
      attackerSeat: null,
      shownAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10000).toISOString(),
      questionDTO: {
        id: 'q1',
        prompt: { en: 'prompt' },
        options: [{ en: 'a' }, { en: 'b' }, { en: 'c' }, { en: 'd' }],
      },
    };

    expect(getExpectedUserIds(cache)).toEqual(['u2', 'u1']);
  });

  it('falls back to ranked_sim when rebuilding a ranked cache without an explicit variant', () => {
    const cache = buildInitialCache({
      match: {
        id: 'ranked-1',
        status: 'active',
        mode: 'ranked',
        total_questions: 12,
        category_a_id: 'cat-a',
        category_b_id: 'cat-b',
        started_at: new Date().toISOString(),
        current_q_index: 0,
        state_payload: {
          version: 1,
          half: 1,
          currentQuestion: { qIndex: 0 },
        },
      },
      players: [
        {
          user_id: 'u1',
          seat: 1,
          total_points: 0,
          correct_answers: 0,
          goals: 0,
          penalty_goals: 0,
          avg_time_ms: null,
        },
        {
          user_id: 'u2',
          seat: 2,
          total_points: 0,
          correct_answers: 0,
          goals: 0,
          penalty_goals: 0,
          avg_time_ms: null,
        },
      ],
    });

    expect(cache.statePayload.variant).toBe('ranked_sim');
  });
});
