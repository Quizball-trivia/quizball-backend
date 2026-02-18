import { describe, expect, it } from 'vitest';
import { calculatePoints } from '../../src/realtime/scoring.js';
import { __possessionInternals } from '../../src/realtime/possession-match-flow.js';

const { effectiveAnswerTimeMs } = __possessionInternals;

describe('possession timer fix', () => {
  it('awards 100 points for earliest post-reveal answer', () => {
    const effective = effectiveAnswerTimeMs(2000);
    expect(calculatePoints(true, effective, 10000)).toBe(100);
  });

  it('applies reveal offset for mid-speed answers', () => {
    const effective = effectiveAnswerTimeMs(5000);
    expect(calculatePoints(true, effective, 10000)).toBe(70);
  });

  it('times out at zero points after reveal offset', () => {
    const effective = effectiveAnswerTimeMs(12000);
    expect(calculatePoints(true, effective, 10000)).toBe(0);
  });

  it('applies the same offset model to AI delays', () => {
    const effective = effectiveAnswerTimeMs(3000);
    expect(calculatePoints(true, effective, 10000)).toBe(90);
  });
});
