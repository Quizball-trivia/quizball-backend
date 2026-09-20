import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_GRID_BOT_GOVERNOR_MIN_ADJUSTMENT,
  parseFootballGridBotStrengthAdjustment,
  stepFootballGridBotGovernor,
  updateFootballGridBotScoreEma,
  type FootballGridBotGovernorState,
} from '../../src/modules/football-grid/football-grid-bot-governor.js';

const NOW = new Date('2026-08-26T10:00:00.000Z');

function state(overrides: Partial<FootballGridBotGovernorState> = {}): FootballGridBotGovernorState {
  return {
    strengthAdjustment: 0,
    scoreEma: null,
    observationCount: 0,
    observationsAtAdjustment: 0,
    adjustmentUpdatedAt: null,
    ...overrides,
  };
}

describe('Football Tic Tac Toe bot governor', () => {
  it('parses valid database numerics and fails closed for missing or boosting v2 pins', () => {
    expect(parseFootballGridBotStrengthAdjustment('-0.0250', { required: true })).toBe(-0.025);
    expect(parseFootballGridBotStrengthAdjustment(null, { required: false })).toBe(0);
    expect(() => parseFootballGridBotStrengthAdjustment(null, { required: true })).toThrow(
      'missing its pinned strength adjustment',
    );
    expect(() => parseFootballGridBotStrengthAdjustment('0.0100', { required: true })).toThrow(
      'invalid strength adjustment',
    );
  });

  it('folds wins, draws, and losses into the score EMA', () => {
    expect(updateFootballGridBotScoreEma(null, 0.5)).toBe(0.5);
    expect(updateFootballGridBotScoreEma(0.5, 1)).toBe(0.55);
    expect(updateFootballGridBotScoreEma(0.5, 0)).toBe(0.45);
  });

  it('makes observation 20 the first eligible adjustment', () => {
    const at19 = stepFootballGridBotGovernor(
      state({ scoreEma: 0.8, observationCount: 18 }),
      { outcomeScore: 1, now: NOW, enabled: true },
    );
    expect(at19.next.observationCount).toBe(19);
    expect(at19.adjustmentChanged).toBe(false);

    const at20 = stepFootballGridBotGovernor(
      state({ scoreEma: 0.8, observationCount: 19 }),
      { outcomeScore: 1, now: NOW, enabled: true },
    );
    expect(at20.next.observationCount).toBe(20);
    expect(at20.next.strengthAdjustment).toBe(-0.025);
    expect(at20.next.observationsAtAdjustment).toBe(20);
    expect(at20.trigger).toBe('high_score_nerf');
  });

  it('requires both sample 30 and one hour after an adjustment at sample 20', () => {
    const adjustedAt = new Date(NOW.getTime() - 30 * 60 * 1_000);
    const base = state({
      strengthAdjustment: -0.025,
      scoreEma: 0.8,
      observationCount: 29,
      observationsAtAdjustment: 20,
      adjustmentUpdatedAt: adjustedAt,
    });
    const tooEarlyByTime = stepFootballGridBotGovernor(base, {
      outcomeScore: 1,
      now: NOW,
      enabled: true,
    });
    expect(tooEarlyByTime.next.observationCount).toBe(30);
    expect(tooEarlyByTime.adjustmentChanged).toBe(false);

    const oneHourLater = stepFootballGridBotGovernor(base, {
      outcomeScore: 1,
      now: new Date(adjustedAt.getTime() + 60 * 60 * 1_000),
      enabled: true,
    });
    expect(oneHourLater.next.strengthAdjustment).toBe(-0.05);
    expect(oneHourLater.next.observationsAtAdjustment).toBe(30);
  });

  it('uses hysteresis and only restores a nerf toward zero', () => {
    const insideBand = stepFootballGridBotGovernor(
      state({ scoreEma: 0.425, observationCount: 19 }),
      { outcomeScore: 0.5, now: NOW, enabled: true },
    );
    expect(insideBand.adjustmentChanged).toBe(false);

    const restored = stepFootballGridBotGovernor(
      state({ strengthAdjustment: -0.05, scoreEma: 0.1, observationCount: 19 }),
      { outcomeScore: 0, now: NOW, enabled: true },
    );
    expect(restored.next.strengthAdjustment).toBe(-0.025);
    expect(restored.trigger).toBe('low_score_restore');

    const cannotBoost = stepFootballGridBotGovernor(
      state({ strengthAdjustment: 0, scoreEma: 0.1, observationCount: 19 }),
      { outcomeScore: 0, now: NOW, enabled: true },
    );
    expect(cannotBoost.next.strengthAdjustment).toBe(0);
    expect(cannotBoost.adjustmentChanged).toBe(false);
  });

  it('does not adjust at the exact lower or upper score thresholds', () => {
    const exactUpper = stepFootballGridBotGovernor(
      state({ scoreEma: 0.416667, observationCount: 19 }),
      { outcomeScore: 1, now: NOW, enabled: true },
    );
    expect(exactUpper.next.scoreEma).toBe(0.475);
    expect(exactUpper.adjustmentChanged).toBe(false);

    const exactLower = stepFootballGridBotGovernor(
      state({ strengthAdjustment: -0.025, scoreEma: 0.416667, observationCount: 19 }),
      { outcomeScore: 0, now: NOW, enabled: true },
    );
    expect(exactLower.next.scoreEma).toBe(0.375);
    expect(exactLower.adjustmentChanged).toBe(false);
  });

  it('fails closed for malformed governor timestamps', () => {
    expect(() => stepFootballGridBotGovernor(
      state({ adjustmentUpdatedAt: new Date('not-a-date') }),
      { outcomeScore: 1, now: NOW, enabled: true },
    )).toThrow('Invalid Football Grid governor timestamp');
    expect(() => stepFootballGridBotGovernor(
      state(),
      { outcomeScore: 1, now: new Date('not-a-date'), enabled: true },
    )).toThrow('Invalid Football Grid governor timestamp');
  });

  it('clamps repeated nerfs at the minus-20-point floor', () => {
    const decision = stepFootballGridBotGovernor(
      state({
        strengthAdjustment: FOOTBALL_GRID_BOT_GOVERNOR_MIN_ADJUSTMENT,
        scoreEma: 1,
        observationCount: 100,
        observationsAtAdjustment: 90,
        adjustmentUpdatedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
      }),
      { outcomeScore: 1, now: NOW, enabled: true },
    );
    expect(decision.next.strengthAdjustment).toBe(-0.20);
    expect(decision.adjustmentChanged).toBe(false);
  });

  it('keeps warming the EMA while disabled and resets a stored nerf to zero', () => {
    const decision = stepFootballGridBotGovernor(
      state({ strengthAdjustment: -0.10, scoreEma: 0.8, observationCount: 25 }),
      { outcomeScore: 0, now: NOW, enabled: false },
    );
    expect(decision.next.scoreEma).toBe(0.72);
    expect(decision.next.observationCount).toBe(26);
    expect(decision.next.strengthAdjustment).toBe(0);
    expect(decision.next.observationsAtAdjustment).toBe(26);
    expect(decision.trigger).toBe('disabled_reset');
  });
});
