import { describe, expect, it } from 'vitest';
import {
  buildTimings,
  pointsForReveal,
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

  it('points decay linearly from max to min and clamp at the floor', () => {
    expect(pointsForReveal(1, 4, 100, 40)).toBe(100);
    expect(pointsForReveal(2, 4, 100, 40)).toBe(80);
    expect(pointsForReveal(3, 4, 100, 40)).toBe(60);
    expect(pointsForReveal(4, 4, 100, 40)).toBe(40);
    expect(pointsForReveal(9, 4, 100, 40)).toBe(40);
  });

  it('a repeat-view clamp (max = min) always scores the floor', () => {
    for (let revealed = 1; revealed <= 6; revealed += 1) {
      expect(pointsForReveal(revealed, 5, 40, 40)).toBe(40);
    }
  });

  it('single-main-step content never divides by zero', () => {
    expect(pointsForReveal(1, 1, 100, 40)).toBe(100);
  });
});
