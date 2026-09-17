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

  it('scales correctness by the measured human accuracy ratio per label (easy 0.702, medium 0.537, hard 0.420)', () => {
    expect(difficultyAdjustedCorrectness(0.5, 'easy')).toBeCloseTo(0.65, 2);
    expect(difficultyAdjustedCorrectness(0.5, 'medium')).toBeCloseTo(0.5, 6);
    expect(difficultyAdjustedCorrectness(0.5, 'hard')).toBeCloseTo(0.39, 2);
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

  it('never plans non-countdown answer delays below the human p10 for that cell', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // normal / easy / correct p10 = 911ms (prod ranked humans, 30d to 2026-09-17).
    expect(getAiAnswerDelayMs({
      questionKind: 'multipleChoice',
      difficulty: 'easy',
      delayProfile: { minMs: 100, maxMs: 100 },
      isCorrect: true,
      questionTimeMs: 30000,
    })).toBe(911);
    // normal / hard / wrong p10 = 1751ms.
    expect(getAiAnswerDelayMs({
      questionKind: 'multipleChoice',
      difficulty: 'hard',
      delayProfile: { minMs: 100, maxMs: 100 },
      isCorrect: false,
      questionTimeMs: 30000,
    })).toBe(1751);
  });

  it('scales the profile delay by the human median for (phase, difficulty, correctness)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter multiplier = 1
    const delayProfile = { minMs: 2441, maxMs: 2441 }; // == normal/medium/correct median → scale 1

    const at = (phaseKind: 'normal' | 'penalty', difficulty: string, isCorrect: boolean) => getAiAnswerDelayMs({
      questionKind: 'multipleChoice', phaseKind, difficulty, delayProfile, isCorrect, questionTimeMs: 30000,
    });
    expect(at('normal', 'medium', true)).toBe(2441);
    expect(at('normal', 'hard', true)).toBe(2477);
    expect(at('normal', 'hard', false)).toBe(5263);
    expect(at('penalty', 'hard', true)).toBe(2492);
    expect(at('normal', 'easy', true)).toBe(1676);
  });
});
