import { describe, expect, it } from 'vitest';
import {
  resolveSpeedStreak,
  beginSecondHalf,
  transitionAfterHalfBoundary,
} from '../../src/realtime/possession-resolution.js';
import { parsePossessionState } from '../../src/realtime/possession-state.js';
import { createInitialPossessionState } from '../../src/modules/matches/matches.service.js';

// Helper: one seat's displayed/base score before any 2x possession boost.
const ans = (basePoints: number) => ({ basePoints });

describe('resolveSpeedStreak', () => {
  it('starts qualification after one higher displayed-score round, without activating 2x yet', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: null,
      previousCandidateSeat: null,
      previousCandidateCount: 0,
      seat1: ans(90),
      seat2: ans(80),
      goalScoredBySeat: null,
    });
    expect(r.boostedSeat).toBeNull(); // no prior holder → nothing doubled this round
    expect(r.nextHolderSeat).toBeNull(); // first qualifying round is not enough
    expect(r.nextCandidateSeat).toBe(1);
    expect(r.nextCandidateCount).toBe(1);
  });

  it('activates the streak after the same seat qualifies twice in a row', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: null,
      previousCandidateSeat: 1,
      previousCandidateCount: 1,
      seat1: ans(90),
      seat2: ans(80),
      goalScoredBySeat: null,
    });
    expect(r.boostedSeat).toBeNull();
    expect(r.nextHolderSeat).toBe(1);
    expect(r.nextCandidateSeat).toBe(1);
    expect(r.nextCandidateCount).toBe(2);
  });

  it('reports the previous holder as boostedSeat (the seat doubled this round)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(90),
      seat2: ans(80),
      goalScoredBySeat: null,
    });
    expect(r.boostedSeat).toBe(1);
    expect(r.nextHolderSeat).toBe(1); // still higher base score -> keeps it
  });

  it('clears the streak when a goal is scored (even if holder had higher base points)', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(100),
      seat2: ans(0),
      goalScoredBySeat: 1,
    });
    expect(r.boostedSeat).toBe(1); // boost still applied this round
    expect(r.nextHolderSeat).toBeNull(); // goal always resets
    expect(r.nextCandidateSeat).toBeNull();
    expect(r.nextCandidateCount).toBe(0);
  });

  it('clears the holder and starts opponent qualification when the opponent earns more base points', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(80),
      seat2: ans(90),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull(); // seat2 must do it twice before holding 2x
    expect(r.nextCandidateSeat).toBe(2);
    expect(r.nextCandidateCount).toBe(1);
  });

  it('clears the streak when the holder answers wrong', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(0),
      seat2: ans(0),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull(); // both wrong → no holder
    expect(r.nextCandidateSeat).toBeNull();
    expect(r.nextCandidateCount).toBe(0);
  });

  it('clears on a displayed-score tie', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(80),
      seat2: ans(80),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull();
    expect(r.nextCandidateSeat).toBeNull();
    expect(r.nextCandidateCount).toBe(0);
  });

  it('ignores hidden raw speed when displayed points tie', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 1,
      previousCandidateSeat: 1,
      previousCandidateCount: 2,
      seat1: ans(80),
      seat2: ans(80),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull();
    expect(r.nextCandidateSeat).toBeNull();
    expect(r.nextCandidateCount).toBe(0);
  });

  it('a one-sided displayed score starts qualification', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: null,
      previousCandidateSeat: null,
      previousCandidateCount: 0,
      seat1: ans(80),
      seat2: ans(0),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull();
    expect(r.nextCandidateSeat).toBe(1);
    expect(r.nextCandidateCount).toBe(1);
  });

  it('starts opponent qualification when the previous holder earns zero base points', () => {
    const r = resolveSpeedStreak({
      previousHolderSeat: 2,
      previousCandidateSeat: 2,
      previousCandidateCount: 2,
      seat1: ans(80),
      seat2: ans(0),
      goalScoredBySeat: null,
    });
    expect(r.nextHolderSeat).toBeNull(); // seat1 needs a second qualifying round
    expect(r.nextCandidateSeat).toBe(1);
    expect(r.nextCandidateCount).toBe(1);
  });
});

describe('speed streak clears on phase transitions', () => {
  it('clears the holder when starting the second half', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.speedStreakHolderSeat = 1;
    state.speedStreakCandidateSeat = 1;
    state.speedStreakCandidateCount = 2;
    beginSecondHalf(state);
    expect(state.speedStreakHolderSeat).toBeNull();
    expect(state.speedStreakCandidateSeat).toBeNull();
    expect(state.speedStreakCandidateCount).toBe(0);
  });

  it('clears the holder at the half boundary (into halftime / penalties / completed)', () => {
    const state = createInitialPossessionState('ranked_sim');
    state.speedStreakHolderSeat = 2;
    state.speedStreakCandidateSeat = 2;
    state.speedStreakCandidateCount = 2;
    transitionAfterHalfBoundary(state); // half 1 → HALFTIME
    expect(state.speedStreakHolderSeat).toBeNull();
    expect(state.speedStreakCandidateSeat).toBeNull();
    expect(state.speedStreakCandidateCount).toBe(0);
  });
});

describe('speed streak state parsing', () => {
  it('clears legacy one-round holders that do not have two-round qualification progress', () => {
    const legacy = {
      ...createInitialPossessionState('ranked_sim'),
      speedStreakHolderSeat: 1,
    };

    const parsed = parsePossessionState(legacy);

    expect(parsed.speedStreakHolderSeat).toBeNull();
    expect(parsed.speedStreakCandidateSeat).toBeNull();
    expect(parsed.speedStreakCandidateCount).toBe(0);
  });

  it('keeps active holders that have completed two-round qualification', () => {
    const qualified = {
      ...createInitialPossessionState('ranked_sim'),
      speedStreakHolderSeat: 2,
      speedStreakCandidateSeat: 2,
      speedStreakCandidateCount: 2,
    };

    const parsed = parsePossessionState(qualified);

    expect(parsed.speedStreakHolderSeat).toBe(2);
    expect(parsed.speedStreakCandidateSeat).toBe(2);
    expect(parsed.speedStreakCandidateCount).toBe(2);
  });
});
