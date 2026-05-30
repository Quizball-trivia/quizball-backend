import { describe, expect, it } from 'vitest';
import {
  resolveSpeedStreak,
  beginSecondHalf,
  transitionAfterHalfBoundary,
} from '../../src/realtime/possession-resolution.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';

// Helper: one seat's answer.
const ans = (correct: boolean, timeMs: number) => ({ correct, timeMs });

describe('resolveSpeedStreak', () => {
  it('earns the streak for the correct + strictly faster seat (no boost yet this round)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: null,
      seat1: ans(true, 2000),
      seat2: ans(true, 5000),
      goalScoredBySeat: null,
    });
    expect(r.boostedSeat).toBeNull(); // no prior holder → nothing doubled this round
    expect(r.nextHolderSeat).toBe(1); // seat1 holds it going into next round
  });

  it('reports the previous holder as boostedSeat (the seat doubled this round)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      seat1: ans(true, 2000),
      seat2: ans(true, 5000),
      goalScoredBySeat: null,
    });
    expect(r.boostedSeat).toBe(1);
    expect(r.nextHolderSeat).toBe(1); // still correct + faster → keeps it
  });

  it('clears the streak when a goal is scored (even if holder was correct + faster)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      seat1: ans(true, 1000),
      seat2: ans(false, 9000),
      goalScoredBySeat: 1,
    });
    expect(r.boostedSeat).toBe(1); // boost still applied this round
    expect(r.nextHolderSeat).toBeNull(); // goal always resets
  });

  it('clears the streak when the holder answers slower (opponent steals it)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      seat1: ans(true, 6000),
      seat2: ans(true, 3000),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBe(2); // seat2 was correct + strictly faster
  });

  it('clears the streak when the holder answers wrong', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      seat1: ans(false, 2000),
      seat2: ans(false, 5000),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull(); // both wrong → no holder
  });

  it('clears on a tie (both correct, equal time) — strictly faster required', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      seat1: ans(true, 3000),
      seat2: ans(true, 3000),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull();
  });

  it('a sole correct answerer holds it even without a speed comparison', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: null,
      seat1: ans(true, 8000),
      seat2: ans(false, 1000),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBe(1); // correct beats wrong regardless of time
  });

  it('treats timeout (max time, wrong) as not earning the streak', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 2,
      seat1: ans(true, 4000),
      seat2: ans(false, Number.MAX_SAFE_INTEGER),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBe(1); // seat1 correct, seat2 timed out
  });
});

describe('speed streak clears on phase transitions', () => {
  it('clears the holder when starting the second half', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.speedStreakHolderSeat = 1;
    beginSecondHalf(state);
    expect(state.speedStreakHolderSeat).toBeNull();
  });

  it('clears the holder at the half boundary (into halftime / penalties / completed)', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.speedStreakHolderSeat = 2;
    transitionAfterHalfBoundary(state); // half 1 → HALFTIME
    expect(state.speedStreakHolderSeat).toBeNull();
  });
});
