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

  it('keeps the normal-band base correctness curve unchanged', () => {
    expect(correctnessFromAnchor(150)).toBe(0.35);
    expect(correctnessFromAnchor(1900)).toBeCloseTo(0.6245098039215686);
    expect(correctnessFromAnchor(2700)).toBe(0.75);
  });

  it('extends base correctness through the high band and caps at 6000 RP', () => {
    expect(correctnessFromAnchor(4350)).toBeCloseTo(0.80);
    expect(correctnessFromAnchor(6000)).toBeCloseTo(0.85);
    expect(correctnessFromAnchor(25000)).toBeCloseTo(0.85);
  });

  it('keeps base correctness monotonic across the ranked AI anchor range', () => {
    const anchors = [150, 800, 1900, 2700, 4350, 6000, 25000];

    for (let index = 1; index < anchors.length; index += 1) {
      expect(correctnessFromAnchor(anchors[index])).toBeGreaterThanOrEqual(
        correctnessFromAnchor(anchors[index - 1])
      );
    }
  });

  it('keeps the normal-band delay profile unchanged', () => {
    expect(delayProfileFromAnchor(150)).toEqual({ minMs: 900, maxMs: 5000 });
    expect(delayProfileFromAnchor(1900)).toEqual({ minMs: 625, maxMs: 4108 });
    expect(delayProfileFromAnchor(2700)).toEqual({ minMs: 500, maxMs: 3700 });
  });

  it('tightens the high-band delay profile through 6000 RP', () => {
    expect(delayProfileFromAnchor(4350)).toEqual({ minMs: 500, maxMs: 2950 });
    expect(delayProfileFromAnchor(6000)).toEqual({ minMs: 500, maxMs: 2200 });
    expect(delayProfileFromAnchor(25000)).toEqual({ minMs: 500, maxMs: 2200 });
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
