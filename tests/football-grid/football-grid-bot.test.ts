import { describe, expect, it } from 'vitest';
import {
  applyFootballGridBotDifficulty,
  FOOTBALL_GRID_EASY_BOT_CAPS,
  footballGridBotShouldAcceptDraw,
  chooseFootballGridBotCell,
  footballGridBotActionIsOnTime,
  footballGridBotAccuracy,
  footballGridBotDelayMs,
  footballGridBotEffectiveAccuracy,
  footballGridBotRecognizableCandidates,
  footballGridBotScarcityMultiplier,
  footballGridBotTierPolicy,
  footballGridBotTierPolicyForVersion,
  footballGridBotTierPolicyV2,
} from '../../src/modules/football-grid/football-grid-bot.service.js';
import type { FootballGridState } from '../../src/modules/football-grid/football-grid.types.js';

describe('Football Grid bot tier model', () => {
  const tiers = [
    'Academy', 'Youth Prospect', 'Reserve', 'Bench', 'Rotation', 'Starting11',
    'Key Player', 'Captain', 'World-Class', 'Legend', 'GOAT',
  ];

  it('keeps every v1 coefficient exact for historical live/replay compatibility', () => {
    const expected = [
      [0.46, 0.48, 0.34, 3500, 14000],
      [0.508, 0.53, 0.315, 3400, 13150],
      [0.556, 0.58, 0.29, 3300, 12300],
      [0.604, 0.63, 0.265, 3200, 11450],
      [0.652, 0.68, 0.24, 3100, 10600],
      [0.70, 0.73, 0.215, 3000, 9750],
      [0.748, 0.78, 0.19, 2900, 8900],
      [0.796, 0.83, 0.165, 2800, 8050],
      [0.844, 0.88, 0.14, 2700, 7200],
      [0.892, 0.93, 0.115, 2600, 6350],
      [0.94, 0.98, 0.09, 2500, 5500],
    ];
    tiers.forEach((tier, index) => {
      const policy = footballGridBotTierPolicyForVersion(1, 1, tier);
      expect(policy.accuracy).toBeCloseTo(expected[index][0], 12);
      expect(policy.tacticalOptimality).toBeCloseTo(expected[index][1], 12);
      expect(policy.passOnMiss).toBeCloseTo(expected[index][2], 12);
      expect(policy.minDelayMs).toBe(expected[index][3]);
      expect(policy.maxDelayMs).toBe(expected[index][4]);
    });
  });

  it('makes higher Ranked tiers more knowledgeable and tactically consistent', () => {
    const academy = footballGridBotTierPolicy('Academy');
    const goat = footballGridBotTierPolicy('GOAT');
    expect(goat.accuracy).toBeGreaterThan(academy.accuracy);
    expect(goat.tacticalOptimality).toBeGreaterThan(academy.tacticalOptimality);
    expect(goat.passOnMiss).toBeLessThan(academy.passOnMiss);
    expect(footballGridBotAccuracy('GOAT')).toBe(goat.accuracy);
  });

  it('uses deterministic human-like delays that shorten with tier', () => {
    expect(footballGridBotDelayMs('Captain', 12345, 7)).toBe(
      footballGridBotDelayMs('Captain', 12345, 7),
    );
    expect(footballGridBotDelayMs('GOAT', 12345, 7)).toBeLessThan(
      footballGridBotDelayMs('Academy', 12345, 7),
    );
  });

  it('allows the exact bot deadline but fails closed after it or for malformed dates', () => {
    const deadline = '2026-08-26T10:00:00.000Z';
    const deadlineMs = Date.parse(deadline);
    expect(footballGridBotActionIsOnTime(deadlineMs, deadline)).toBe(true);
    expect(footballGridBotActionIsOnTime(deadlineMs + 1, deadline)).toBe(false);
    expect(footballGridBotActionIsOnTime(deadlineMs, 'not-a-date')).toBe(false);
    expect(footballGridBotActionIsOnTime(Number.NaN, deadline)).toBe(false);
  });

  it('dispatches live matches only through their pinned policy version', () => {
    expect(footballGridBotTierPolicyForVersion(1, 1, 'Captain')).toEqual(
      footballGridBotTierPolicy('Captain'),
    );
    expect(footballGridBotTierPolicyForVersion(2, 1, 'Captain')).toEqual(
      footballGridBotTierPolicyV2('Captain'),
    );
    expect(() => footballGridBotTierPolicyForVersion(3, 1, 'Captain')).toThrow(
      'Unsupported Football Grid bot policy 3/1',
    );
  });

  it('uses the launch-safe v2 curve with slower timing and an 82% hard tier cap', () => {
    const policies = tiers.map(footballGridBotTierPolicyV2);
    expect(policies[0]).toEqual({
      accuracy: 0.42,
      tacticalOptimality: 0.45,
      passOnMiss: 0.38,
      minDelayMs: 7_000,
      maxDelayMs: 16_000,
    });
    expect(policies.at(-1)).toEqual({
      accuracy: 0.82,
      tacticalOptimality: 0.85,
      passOnMiss: 0.18,
      minDelayMs: 4_500,
      maxDelayMs: 11_000,
    });
    for (let index = 1; index < policies.length; index += 1) {
      expect(policies[index].accuracy - policies[index - 1].accuracy).toBeCloseTo(0.04, 12);
      expect(policies[index].tacticalOptimality - policies[index - 1].tacticalOptimality).toBeCloseTo(0.04, 12);
      expect(policies[index].passOnMiss - policies[index - 1].passOnMiss).toBeCloseTo(-0.02, 12);
      expect(policies[index].minDelayMs).toBeLessThan(policies[index - 1].minDelayMs);
      expect(policies[index].maxDelayMs).toBeLessThan(policies[index - 1].maxDelayMs);
    }
  });

  it('uses chosen-cell scarcity and never lets the governor strengthen a v2 tier', () => {
    expect(footballGridBotScarcityMultiplier(2, 1, 9)).toBe(0.85);
    expect(footballGridBotScarcityMultiplier(2, 1, 10)).toBe(0.92);
    expect(footballGridBotScarcityMultiplier(2, 1, 14)).toBe(0.92);
    expect(footballGridBotScarcityMultiplier(2, 1, 15)).toBe(1);

    const broad = footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'GOAT',
      strengthAdjustment: 0,
      chosenCellUnusedAnswerCount: 20,
    });
    const scarce = footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'GOAT',
      strengthAdjustment: -0.20,
      chosenCellUnusedAnswerCount: 9,
    });
    expect(broad).toEqual({ baseAccuracy: 0.82, scarcityMultiplier: 1, effectiveAccuracy: 0.82 });
    expect(scarce.baseAccuracy).toBe(0.82);
    expect(scarce.effectiveAccuracy).toBeCloseTo((0.82 - 0.20) * 0.85, 12);
    expect(scarce.effectiveAccuracy).toBeLessThan(broad.effectiveAccuracy);
    expect(footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'GOAT',
      strengthAdjustment: 0,
      chosenCellUnusedAnswerCount: 0,
    }).effectiveAccuracy).toBe(0);
    expect(() => footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'Academy',
      strengthAdjustment: 0.01,
      chosenCellUnusedAnswerCount: 20,
    })).toThrow('invalid strength adjustment');
    expect(() => footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'Academy',
      strengthAdjustment: -0.2001,
      chosenCellUnusedAnswerCount: 20,
    })).toThrow('invalid strength adjustment');
  });

  it('preserves v1 candidate sampling but restricts v2 to five recognizable answers', () => {
    const candidates = Array.from({ length: 12 }, (_, index) => `player-${index + 1}`);
    expect(footballGridBotRecognizableCandidates(1, 1, candidates)).toEqual(candidates);
    expect(footballGridBotRecognizableCandidates(2, 1, candidates)).toEqual(candidates.slice(0, 5));
    expect(footballGridBotRecognizableCandidates(2, 1, candidates.slice(0, 3))).toEqual(candidates.slice(0, 3));
  });

  it('keeps all v2 effective probabilities monotone and within their tier baselines', () => {
    for (const adjustment of [0, -0.025, -0.10, -0.20]) {
      for (const answerCount of [0, 9, 10, 14, 15, 50]) {
        const effective = tiers.map((tier) => footballGridBotEffectiveAccuracy({
          modelVersion: 2,
          configVersion: 1,
          tier,
          strengthAdjustment: adjustment,
          chosenCellUnusedAnswerCount: answerCount,
        }));
        for (const policy of effective) {
          expect(policy.effectiveAccuracy).toBeGreaterThanOrEqual(0);
          expect(policy.effectiveAccuracy).toBeLessThanOrEqual(policy.baseAccuracy);
        }
        for (let index = 1; index < effective.length; index += 1) {
          expect(effective[index].effectiveAccuracy).toBeGreaterThanOrEqual(
            effective[index - 1].effectiveAccuracy,
          );
        }
      }
    }
  });

  it('takes a winning cell before considering a block', () => {
    const state = {
      turnNumber: 0,
      players: [{ userId: 'bot' }, { userId: 'human' }],
      claims: [
        { cellIndex: 0, claimantUserId: 'bot' },
        { cellIndex: 1, claimantUserId: 'bot' },
        { cellIndex: 3, claimantUserId: 'human' },
        { cellIndex: 4, claimantUserId: 'human' },
      ],
    } as FootballGridState;
    expect(chooseFootballGridBotCell(state, 'bot', 1, 'GOAT')).toBe(2);
  });

  it('blocks an immediate opponent win when it has no winning move', () => {
    const state = {
      turnNumber: 0,
      players: [{ userId: 'bot' }, { userId: 'human' }],
      claims: [
        { cellIndex: 3, claimantUserId: 'human' },
        { cellIndex: 4, claimantUserId: 'human' },
      ],
    } as FootballGridState;
    expect(chooseFootballGridBotCell(state, 'bot', 1, 'GOAT')).toBe(5);
  });
});

describe('Football Grid easy bot difficulty', () => {
  it('caps knowledge and tactics for every tier while adaptive keeps the tier model', () => {
    const goat = footballGridBotTierPolicyV2('GOAT');
    const easy = applyFootballGridBotDifficulty(goat, 'easy');
    expect(easy.accuracy).toBe(FOOTBALL_GRID_EASY_BOT_CAPS.accuracy);
    expect(easy.tacticalOptimality).toBe(FOOTBALL_GRID_EASY_BOT_CAPS.tacticalOptimality);
    expect(easy.passOnMiss).toBe(FOOTBALL_GRID_EASY_BOT_CAPS.passOnMiss);
    expect(easy.minDelayMs).toBe(goat.minDelayMs);
    expect(applyFootballGridBotDifficulty(goat, 'adaptive')).toEqual(goat);
  });

  it('never lets governor or scarcity lift an easy bot above the cap', () => {
    for (const modelVersion of [1, 2]) {
      const result = footballGridBotEffectiveAccuracy({
        modelVersion,
        configVersion: 1,
        tier: 'GOAT',
        strengthAdjustment: 0,
        chosenCellUnusedAnswerCount: 40,
        difficulty: 'easy',
      });
      expect(result.effectiveAccuracy).toBeLessThanOrEqual(FOOTBALL_GRID_EASY_BOT_CAPS.accuracy);
    }
    const weak = footballGridBotEffectiveAccuracy({
      modelVersion: 2,
      configVersion: 1,
      tier: 'Academy',
      strengthAdjustment: -0.2,
      chosenCellUnusedAnswerCount: 2,
      difficulty: 'easy',
    });
    expect(weak.effectiveAccuracy).toBeLessThan(FOOTBALL_GRID_EASY_BOT_CAPS.accuracy);
  });
});

describe('Football Grid bot draw policy', () => {
  const bot = 'bot';
  const human = 'human';
  const stateWith = (claims: Array<[number, string]>): FootballGridState => ({
    players: [{ userId: bot, isBot: true }, { userId: human, isBot: false }],
    claims: claims.map(([cellIndex, claimantUserId]) => ({ cellIndex, claimantUserId })),
  } as unknown as FootballGridState);

  it('accepts when the bot can no longer complete a line', () => {
    // Human holds the whole middle row and column: every line the bot could use is cut.
    const state = stateWith([[3, human], [4, human], [5, human], [1, human], [7, human], [0, bot], [8, bot]]);
    expect(footballGridBotShouldAcceptDraw(state, bot, 'adaptive')).toBe(true);
  });

  it('declines while only the bot can still win', () => {
    const state = stateWith([[3, bot], [4, bot], [5, bot], [1, bot], [7, bot], [0, human], [8, human]]);
    expect(footballGridBotShouldAcceptDraw(state, bot, 'adaptive')).toBe(false);
    expect(footballGridBotShouldAcceptDraw(state, bot, 'easy')).toBe(false);
  });

  it('accepts when the human has more open lines', () => {
    // Human owns the centre (4 lines), bot owns one edge (2 lines minus the cut ones).
    const state = stateWith([[4, human], [1, bot]]);
    expect(footballGridBotShouldAcceptDraw(state, bot, 'adaptive')).toBe(true);
  });

  it('declines an early balanced offer but settles a late one, earlier on easy', () => {
    const early = stateWith([[0, bot], [8, human]]);
    expect(footballGridBotShouldAcceptDraw(early, bot, 'adaptive')).toBe(false);
    expect(footballGridBotShouldAcceptDraw(early, bot, 'easy')).toBe(false);
    const mid = stateWith([[0, bot], [8, human], [2, human], [6, bot]]);
    expect(footballGridBotShouldAcceptDraw(mid, bot, 'adaptive')).toBe(false);
    expect(footballGridBotShouldAcceptDraw(mid, bot, 'easy')).toBe(true);
    const late = stateWith([[0, bot], [8, human], [2, human], [6, bot], [1, bot], [7, human]]);
    expect(footballGridBotShouldAcceptDraw(late, bot, 'adaptive')).toBe(true);
  });
});
