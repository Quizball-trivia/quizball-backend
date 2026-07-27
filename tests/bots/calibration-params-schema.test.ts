import { describe, it, expect } from 'vitest';
import { parseBotModelParams, CALIBRATION_SCHEMA_VERSION, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';

function validParams(): BotModelParams {
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    generatedAt: '2026-07-27T00:00:00.000Z',
    source: { batchId: 'b1', seasonNumber: 1, batchCompletedAt: '2026-07-15T00:00:00Z', isSmokeRun: false },
    thetaAnchoring: { convention: 'mean-zero-over-fitted-s1-cohort', cohortSize: 500 },
    fCurve: [
      { rp: 1000, skill: -1.5 },
      { rp: 1800, skill: 1.6 },
    ],
    difficultyLink: { intercept: 0.2, slope: -1.3, holdoutR2: 0.85, holdoutRmse: 0.3, nQuestions: 500 },
    ceiling: {
      topCohortSize: 10,
      topAggregateAccuracyHoldout: 0.72,
      topAggregateAccuracyInSample: 0.75,
      marginPp: 4,
      ceilingAccuracy: 0.68,
      speedFloor: [{ percentile: 0.1, timeMs: 2200 }],
      topMedianTimeMs: 4200,
      topLogTimeSigma: 0.4,
    },
    clamps: { finalProbCap: 0.93, skillCap: 4, minAnswerTimeMs: 600 },
    validation: { fitConverged: true, fitIters: 71, finalUpdateNorm: 9e-5, holdoutAuc: 0.78 },
  };
}

describe('botModelParams schema', () => {
  it('accepts a well-formed params object', () => {
    expect(() => parseBotModelParams(validParams())).not.toThrow();
  });

  it('rejects a wrong schema version', () => {
    const p = { ...validParams(), schemaVersion: 99 };
    expect(() => parseBotModelParams(p)).toThrow();
  });

  it('rejects an f-curve with fewer than 2 knots', () => {
    const p = { ...validParams(), fCurve: [{ rp: 1000, skill: 0 }] };
    expect(() => parseBotModelParams(p)).toThrow();
  });

  it('rejects a probability cap outside [0,1]', () => {
    const p = validParams();
    p.clamps.finalProbCap = 1.5;
    expect(() => parseBotModelParams(p)).toThrow();
  });

  it('rejects the wrong theta anchoring convention', () => {
    const p = { ...validParams(), thetaAnchoring: { convention: 'something-else', cohortSize: 1 } };
    expect(() => parseBotModelParams(p as unknown)).toThrow();
  });

  it('allows null holdout stats (sparse difficulty link)', () => {
    const p = validParams();
    p.difficultyLink = { intercept: 0, slope: 0, holdoutR2: null, holdoutRmse: null, nQuestions: 0 };
    expect(() => parseBotModelParams(p)).not.toThrow();
  });
});
