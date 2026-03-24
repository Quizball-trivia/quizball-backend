import { describe, expect, it, vi } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const {
  categoryIdsForCurrentHalf,
  buildPlayableQuestionTiming,
  computeAuthoritativeTimeMs,
  applyDeltaAndGoalCheck,
  applyNormalResolution,
  applyLastAttackResolution,
  decideWinner,
  penaltyWinnerSeat,
} = __possessionInternals;

describe('possession-match-flow internals', () => {
  it('uses authoritative timing instead of client fallback when shownAt is available', () => {
    const elapsed = computeAuthoritativeTimeMs(
      {
        shownAt: '2026-03-24T12:00:00.000Z',
        deadlineAt: '2026-03-24T12:00:10.000Z',
      },
      new Date('2026-03-24T12:00:04.200Z').getTime(),
      9500
    );

    expect(elapsed).toBe(4200);
  });

  it('builds halftime restart timing without carrying old transition delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00.000Z'));

    const timing = buildPlayableQuestionTiming({
      qIndex: 6,
      state: {
        half: 2,
        normalQuestionsAnsweredInHalf: 0,
      },
    });

    expect(timing.playableAt.toISOString()).toBe('2026-03-24T12:00:03.000Z');
    expect(timing.deadlineAt.toISOString()).toBe('2026-03-24T12:00:13.000Z');

    vi.useRealTimers();
  });

  it('checks goals on raw nextDiff before clamping', () => {
    const state = createInitialPossessionState();
    state.possessionDiff = 99;
    const result = applyDeltaAndGoalCheck(state, 51, 50);
    expect(result.delta).toBe(1);
    expect(result.goalScoredBySeat).toBe(1);
    expect(state.possessionDiff).toBe(0);
    expect(state.goals.seat1).toBe(1);
  });

  it('enters last attack at exact +50 / -50 after Q6', () => {
    const seat1Lead = createInitialPossessionState();
    seat1Lead.normalQuestionsAnsweredInHalf = 5;
    seat1Lead.normalQuestionsAnsweredTotal = 5;
    seat1Lead.possessionDiff = 40;
    applyNormalResolution(seat1Lead, 60, 50, true, false);
    expect(seat1Lead.phase).toBe('LAST_ATTACK');
    expect(seat1Lead.lastAttack.attackerSeat).toBe(1);
    expect(seat1Lead.normalQuestionsAnsweredInHalf).toBe(6);

    const seat2Lead = createInitialPossessionState();
    seat2Lead.normalQuestionsAnsweredInHalf = 5;
    seat2Lead.normalQuestionsAnsweredTotal = 5;
    seat2Lead.possessionDiff = -40;
    applyNormalResolution(seat2Lead, 50, 60, false, true);
    expect(seat2Lead.phase).toBe('LAST_ATTACK');
    expect(seat2Lead.lastAttack.attackerSeat).toBe(2);
  });

  it('skips last attack when abs(possessionDiff) < 50 at Q6', () => {
    const state = createInitialPossessionState();
    state.normalQuestionsAnsweredInHalf = 5;
    state.normalQuestionsAnsweredTotal = 5;
    state.possessionDiff = 20;

    applyNormalResolution(state, 50, 50, true, true);
    expect(state.phase).toBe('HALFTIME');
    expect(state.lastAttack.attackerSeat).toBeNull();
  });

  it('last attack resolution does not increment normal question counters', () => {
    const state = createInitialPossessionState();
    state.half = 1;
    state.phase = 'LAST_ATTACK';
    state.normalQuestionsAnsweredInHalf = 6;
    state.normalQuestionsAnsweredTotal = 6;
    state.possessionDiff = 70;

    applyLastAttackResolution(state, 55, 45);
    expect(state.normalQuestionsAnsweredInHalf).toBe(6);
    expect(state.normalQuestionsAnsweredTotal).toBe(6);
    expect(state.phase).toBe('HALFTIME');
  });

  it('uses category A as half 2 fallback when category B is null', () => {
    expect(
      categoryIdsForCurrentHalf(
        { half: 1 },
        { categoryAId: 'cat-a', categoryBId: null }
      )
    ).toEqual(['cat-a']);

    expect(
      categoryIdsForCurrentHalf(
        { half: 2 },
        { categoryAId: 'cat-a', categoryBId: 'cat-b' }
      )
    ).toEqual(['cat-b']);

    expect(
      categoryIdsForCurrentHalf(
        { half: 2 },
        { categoryAId: 'cat-a', categoryBId: null }
      )
    ).toEqual(['cat-a']);
  });

  it('detects penalty winner when mathematically unreachable', () => {
    const state = createInitialPossessionState();
    state.penaltyGoals = { seat1: 3, seat2: 0 };
    state.penalty.kicksTaken = { seat1: 3, seat2: 3 };

    // Seat2 has at most 2 kicks left in regulation, cannot catch 3-goal deficit.
    expect(penaltyWinnerSeat(state)).toBe(1);
  });

  it('falls back to total points when goals and penalties are tied', () => {
    const state = createInitialPossessionState();
    state.goals = { seat1: 1, seat2: 1 };
    state.penaltyGoals = { seat1: 2, seat2: 2 };

    const decision = decideWinner(
      [
        { user_id: 'u1', seat: 1, total_points: 910 },
        { user_id: 'u2', seat: 2, total_points: 870 },
      ],
      state
    );

    expect(decision.method).toBe('total_points_fallback');
    expect(decision.totalPointsFallbackUsed).toBe(true);
    expect(decision.winnerId).toBe('u1');
  });
});
