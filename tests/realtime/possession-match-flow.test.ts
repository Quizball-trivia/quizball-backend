import { describe, expect, it } from 'vitest';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const {
  applyNormalResolution,
  shotReboundPossession,
  decideWinner,
  penaltyWinnerSeat,
} = __possessionInternals;

describe('possession-match-flow internals', () => {
  it('moves possession toward midfield by 2 when both players are wrong', () => {
    const aboveMid = createInitialPossessionState();
    aboveMid.sharedPossession = 58;
    applyNormalResolution(
      aboveMid,
      { isCorrect: false, timeMs: 10000 },
      { isCorrect: false, timeMs: 10000 }
    );
    expect(aboveMid.sharedPossession).toBe(56);

    const belowMid = createInitialPossessionState();
    belowMid.sharedPossession = 42;
    applyNormalResolution(
      belowMid,
      { isCorrect: false, timeMs: 10000 },
      { isCorrect: false, timeMs: 10000 }
    );
    expect(belowMid.sharedPossession).toBe(44);

    const exactMid = createInitialPossessionState();
    exactMid.sharedPossession = 50;
    applyNormalResolution(
      exactMid,
      { isCorrect: false, timeMs: 10000 },
      { isCorrect: false, timeMs: 10000 }
    );
    expect(exactMid.sharedPossession).toBe(50);
  });

  it('applies fixed defensive rebound after missed shot by attacker seat', () => {
    expect(shotReboundPossession(1)).toBe(60);
    expect(shotReboundPossession(2)).toBe(40);
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
