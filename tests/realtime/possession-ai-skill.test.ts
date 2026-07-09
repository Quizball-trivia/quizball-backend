import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  correctnessFromAnchor,
  delayProfileFromAnchor,
} from '../../src/modules/ranked/ranked.service.js';
import {
  difficultyAdjustedCorrectness,
  getAiAnswerDelayMs,
} from '../../src/realtime/possession-ai.js';

describe('ranked possession AI skill scaling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matches ranked AI calibration knots exactly', () => {
    expect(correctnessFromAnchor(10000)).toBe(0.741);
    expect(delayProfileFromAnchor(10000)).toEqual({ minMs: 1080, maxMs: 4340 });
    expect(correctnessFromAnchor(325)).toBe(0.387);
    expect(delayProfileFromAnchor(325)).toEqual({ minMs: 1850, maxMs: 6675 });
  });

  it('interpolates ranked AI calibration between knots', () => {
    const delayProfile = delayProfileFromAnchor(8000);

    expect(correctnessFromAnchor(8000)).toBeCloseTo(0.683, 3);
    expect(delayProfile.minMs).toBe(1140);
    expect(delayProfile.maxMs).toBe(4533);
  });

  it('clamps ranked AI calibration outside the measured anchor range', () => {
    expect(correctnessFromAnchor(150)).toBe(0.387);
    expect(delayProfileFromAnchor(150)).toEqual({ minMs: 1850, maxMs: 6675 });
    expect(correctnessFromAnchor(25000)).toBe(0.741);
    expect(delayProfileFromAnchor(25000)).toEqual({ minMs: 1080, maxMs: 4340 });
  });

  it('never exceeds the measured top human correctness cohort', () => {
    const anchors = [150, 325, 800, 1900, 2700, 4350, 6000, 10000, 25000];

    for (const anchor of anchors) {
      expect(correctnessFromAnchor(anchor)).toBeLessThanOrEqual(0.741);
    }
  });

  it('keeps base correctness monotonic across the ranked AI anchor range', () => {
    const anchors = [150, 325, 800, 1900, 2700, 4350, 6000, 10000, 25000];

    for (let index = 1; index < anchors.length; index += 1) {
      expect(correctnessFromAnchor(anchors[index])).toBeGreaterThanOrEqual(
        correctnessFromAnchor(anchors[index - 1])
      );
    }
  });

  it('orders adjusted correctness by question difficulty at a fixed rank', () => {
    const base = correctnessFromAnchor(1900);

    expect(difficultyAdjustedCorrectness(base, 'easy')).toBeGreaterThan(
      difficultyAdjustedCorrectness(base, 'medium')
    );
    expect(difficultyAdjustedCorrectness(base, 'medium')).toBeGreaterThan(
      difficultyAdjustedCorrectness(base, 'hard')
    );
  });

  it('clamps adjusted correctness and treats unknown difficulty as medium', () => {
    expect(difficultyAdjustedCorrectness(2, 'easy')).toBe(0.97);
    expect(difficultyAdjustedCorrectness(0, 'hard')).toBe(0.10);
    expect(difficultyAdjustedCorrectness(0.5, 'legendary')).toBe(0.5);
    expect(difficultyAdjustedCorrectness(0.5)).toBe(0.5);
  });

  it('scales non-countdown answer delays by difficulty', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delayProfile = { minMs: 2000, maxMs: 2000 };

    const easyDelayMs = getAiAnswerDelayMs({
      questionKind: 'multipleChoice',
      difficulty: 'easy',
      delayProfile,
      isCorrect: true,
      questionTimeMs: 30000,
    });
    const hardDelayMs = getAiAnswerDelayMs({
      questionKind: 'multipleChoice',
      difficulty: 'hard',
      delayProfile,
      isCorrect: true,
      questionTimeMs: 30000,
    });

    expect(easyDelayMs).toBeLessThan(hardDelayMs);
  });

  it('makes planned wrong answers slower than correct answers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const delayProfile = { minMs: 4000, maxMs: 4000 };

    const correctDelayMs = getAiAnswerDelayMs({
      questionKind: 'putInOrder',
      difficulty: 'medium',
      delayProfile,
      isCorrect: true,
      questionTimeMs: 30000,
    });
    const wrongDelayMs = getAiAnswerDelayMs({
      questionKind: 'putInOrder',
      difficulty: 'medium',
      delayProfile,
      isCorrect: false,
      questionTimeMs: 30000,
    });

    expect(wrongDelayMs).toBeGreaterThan(correctDelayMs);
  });

  it('never plans non-countdown answer delays below 800ms', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    expect(getAiAnswerDelayMs({
      questionKind: 'multipleChoice',
      difficulty: 'easy',
      delayProfile: { minMs: 100, maxMs: 100 },
      isCorrect: true,
      questionTimeMs: 30000,
    })).toBe(800);
  });
});
