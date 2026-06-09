import { describe, expect, it } from 'vitest';

import {
  clampDailyChallengeScore,
  computeMaxScoreForSession,
  getCoinsAwardedForCompletion,
  getMaxScoreFromSettings,
} from '../../src/modules/daily-challenges/daily-challenges.scoring.js';

describe('daily-challenges.scoring', () => {
  it('computes max score per session type', () => {
    expect(computeMaxScoreForSession({
      challengeType: 'moneyDrop',
      title: 'Money Drop',
      description: 'desc',
      questionCount: 5,
      secondsPerQuestion: 30,
      startingMoney: 2500,
      questions: [],
    })).toBe(1000);

    expect(computeMaxScoreForSession({
      challengeType: 'countdown',
      title: 'Countdown',
      description: 'desc',
      roundCount: 2,
      secondsPerRound: 30,
      rounds: [
        {
          id: 'round-1',
          category: 'Cat',
          prompt: 'Prompt',
          answerGroups: [
            { id: 'a', display: 'A', acceptedAnswers: ['A'] },
            { id: 'b', display: 'B', acceptedAnswers: ['B'] },
          ],
        },
        {
          id: 'round-2',
          category: 'Cat',
          prompt: 'Prompt',
          answerGroups: [
            { id: 'c', display: 'C', acceptedAnswers: ['C'] },
          ],
        },
      ],
    })).toBe(3);

    expect(computeMaxScoreForSession({
      challengeType: 'highLow',
      title: 'High Low',
      description: 'desc',
      roundCount: 1,
      secondsPerRound: 30,
      rounds: [
        {
          id: 'round-1',
          category: 'Cat',
          difficulty: 'easy',
          prompt: 'Prompt',
          statLabel: 'Goals',
          matchups: [
            {
              id: 'm1',
              leftName: 'A',
              leftValue: 1,
              rightName: 'B',
              rightValue: 2,
            },
            {
              id: 'm2',
              leftName: 'C',
              leftValue: 3,
              rightName: 'D',
              rightValue: 4,
            },
          ],
        },
      ],
    })).toBe(2);
  });

  it('clamps inflated scores to the max', () => {
    expect(clampDailyChallengeScore(999, 5)).toBe(5);
    expect(clampDailyChallengeScore(-3, 5)).toBe(0);
    expect(clampDailyChallengeScore(3.9, 5)).toBe(3);
  });

  it('awards coins from clamped score', () => {
    expect(getCoinsAwardedForCompletion('trueFalse', 3)).toBe(60);
    expect(getCoinsAwardedForCompletion('moneyDrop', 1200)).toBe(1000);
    expect(getCoinsAwardedForCompletion('moneyDrop', 750)).toBe(750);
  });

  it('derives config fallback max scores', () => {
    expect(getMaxScoreFromSettings('trueFalse', {
      challengeType: 'trueFalse',
      categoryIds: [],
      questionCount: 7,
      secondsPerQuestion: 20,
    })).toBe(7);

    expect(getMaxScoreFromSettings('moneyDrop', {
      challengeType: 'moneyDrop',
      categoryIds: [],
      questionCount: 5,
      secondsPerQuestion: 20,
      startingMoney: 1500,
    })).toBe(1000);
  });
});
