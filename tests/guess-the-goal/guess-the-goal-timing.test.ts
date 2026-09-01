import { describe, expect, it } from 'vitest';
import {
  buildTimings,
  pointsForElapsed,
  revealedMovesAt,
} from '../../src/modules/guess-the-goal/guess-the-goal.timing.js';
import type { ChoreographyStep } from '../../src/modules/guess-the-goal/guess-the-goal.types.js';

const STEPS: ChoreographyStep[] = [
  { kind: 'carry', player: 'a', to: [30, 42], duration: 2.0 },
  { kind: 'pass', player: 'a', to: [10, 46], duration: 1.0 },
  { kind: 'run', player: 'c', to: [50, 84], withPrev: true, duration: 2.5 },
  { kind: 'pass', player: 'b', to: [50, 84], duration: 1.0 },
  { kind: 'shot', player: 'c', to: [34, 105], duration: 0.5 },
];

describe('guess-the-goal timing', () => {
  it('main steps run sequentially; withPrev shares its predecessor start', () => {
    const t = buildTimings(STEPS);
    // The withPrev run starts with the 2.0s pass and lasts 2.5s (until 4.5),
    // pushing the NEXT main step's start to 4.5 — same as the client engine.
    expect(t.mainStarts).toEqual([0, 2.0, 4.5, 5.5]);
    expect(t.duration).toBeCloseTo(6.0);
  });

  it('reveal count follows the server clock, never below 1', () => {
    const t = buildTimings(STEPS);
    expect(revealedMovesAt(t, 0)).toBe(1);
    expect(revealedMovesAt(t, 1.9)).toBe(1);
    expect(revealedMovesAt(t, 2.0)).toBe(2);
    expect(revealedMovesAt(t, 4.4)).toBe(2);
    expect(revealedMovesAt(t, 4.5)).toBe(3);
    expect(revealedMovesAt(t, 99)).toBe(4);
  });

  it('points decay linearly over elapsed seconds and clamp at both ends', () => {
    expect(pointsForElapsed(0, 100, 40, 10)).toBe(100);
    expect(pointsForElapsed(2.5, 100, 40, 10)).toBe(85);
    expect(pointsForElapsed(5, 100, 40, 10)).toBe(70);
    expect(pointsForElapsed(10, 100, 40, 10)).toBe(40);
    expect(pointsForElapsed(99, 100, 40, 10)).toBe(40);
    expect(pointsForElapsed(-3, 100, 40, 10)).toBe(100);
  });

  it('decay is a pure function of the clock — no goal-shape input exists', () => {
    // The old move-count decay gave a 2-move goal ~3s of range and a 7-move
    // goal ~9s; time decay takes no timings, so every goal scores the same
    // clock the same. Pinned with exact values.
    expect(pointsForElapsed(1, 100, 40, 10)).toBe(94);
    expect(pointsForElapsed(3, 100, 40, 10)).toBe(82);
    expect(pointsForElapsed(7.5, 100, 40, 10)).toBe(55);
    expect(pointsForElapsed(12, 100, 40, 10)).toBe(40);
  });

  it('a repeat-view clamp (max = min) always scores the floor', () => {
    for (let elapsed = 0; elapsed <= 15; elapsed += 1.5) {
      expect(pointsForElapsed(elapsed, 40, 40, 10)).toBe(40);
    }
  });

  it('degenerate window never divides by zero (span floors at 1s)', () => {
    expect(pointsForElapsed(0, 100, 40, 0)).toBe(100);
    expect(pointsForElapsed(0.5, 100, 40, 0)).toBe(70);
    expect(pointsForElapsed(1, 100, 40, 0)).toBe(40);
  });
});
