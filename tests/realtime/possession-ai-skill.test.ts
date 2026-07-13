import { afterEach, describe, expect, it, vi } from 'vitest';
import { correctnessFromAnchor } from '../../src/modules/ranked/ranked.service.js';
import {
  difficultyAdjustedCorrectness,
  getAiAnswerDelayMs,
} from '../../src/realtime/possession-ai.js';

describe('ranked possession AI skill scaling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps anchor RP to the widened base correctness curve', () => {
    expect(correctnessFromAnchor(150)).toBeCloseTo(0.35);
    expect(correctnessFromAnchor(2700)).toBeCloseTo(0.75);
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
