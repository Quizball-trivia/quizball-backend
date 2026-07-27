/**
 * Zod schema for bot_model_params.params — the calibration OUTPUT that PR8's
 * gameplay model imports. Schema validation replaces the ad-hoc version label:
 * the offline script validates before writing params.json, and PR8 validates on
 * read, so a malformed or partial artifact can never reach the gameplay model.
 *
 * PR8 reconstructs P(correct) = sigmoid(theta_p - beta_q) where:
 *   - theta_p = f(currentRp) + personal offset, on the FIXED S1 latent scale
 *     (thetaAnchoring documents the convention: mean-0 over the fitted S1 cohort).
 *   - beta_q is recovered from question_stats.smoothed_accuracy via the
 *     difficultyLink: beta ≈ intercept + slope * logit(smoothed_accuracy).
 * After computing the probability, PR8 applies clamps.finalProbCap; the sampled
 * skill is bounded by clamps.skillCap; sampled answer times are floored by
 * clamps.minAnswerTimeMs and by the ceiling speed floor.
 */

import { z } from 'zod';

export const CALIBRATION_SCHEMA_VERSION = 1;

export const fCurveKnotSchema = z.object({
  rp: z.number(),
  skill: z.number(),
});

export const speedFloorSchema = z.object({
  percentile: z.number().min(0).max(1),
  timeMs: z.number().nonnegative(),
});

export const difficultyLinkSchema = z.object({
  // beta ≈ intercept + slope * logit(smoothed_accuracy)
  intercept: z.number(),
  slope: z.number(),
  // Holdout validation of the link (fit on train questions, scored on holdout).
  holdoutR2: z.number().nullable(),
  holdoutRmse: z.number().nullable(),
  nQuestions: z.number().int().nonnegative(),
});

export const clampsSchema = z.object({
  finalProbCap: z.number().min(0).max(1),
  skillCap: z.number().positive(),
  minAnswerTimeMs: z.number().nonnegative(),
});

export const ceilingSchema = z.object({
  topCohortSize: z.number().int().nonnegative(),
  // Measured on HOLDOUT answers of the top cohort (no selection leakage).
  topAggregateAccuracyHoldout: z.number().min(0).max(1).nullable(),
  // In-sample number retained for reference/comparison only.
  topAggregateAccuracyInSample: z.number().min(0).max(1).nullable(),
  marginPp: z.number().nonnegative(),
  ceilingAccuracy: z.number().min(0).max(1),
  speedFloor: z.array(speedFloorSchema),
  topMedianTimeMs: z.number().nullable(),
  topLogTimeSigma: z.number().nullable(),
});

export const botModelParamsSchema = z.object({
  schemaVersion: z.literal(CALIBRATION_SCHEMA_VERSION),
  generatedAt: z.string(),
  source: z.object({
    batchId: z.string(),
    seasonNumber: z.number().nullable(),
    batchCompletedAt: z.string().nullable(),
    isSmokeRun: z.boolean(),
  }),
  thetaAnchoring: z.object({
    convention: z.literal('mean-zero-over-fitted-s1-cohort'),
    cohortSize: z.number().int().nonnegative(),
  }),
  // f(RP) -> skill (theta) knots on the fixed S1 scale.
  fCurve: z.array(fCurveKnotSchema).min(2),
  // Recovers beta_q from question_stats.smoothed_accuracy for PR8.
  difficultyLink: difficultyLinkSchema,
  ceiling: ceilingSchema,
  clamps: clampsSchema,
  // Fit + validation diagnostics (for the report / audit trail).
  validation: z.object({
    fitConverged: z.boolean(),
    fitIters: z.number().int().nonnegative(),
    finalUpdateNorm: z.number(),
    holdoutAuc: z.number().nullable(),
  }),
});

export type BotModelParams = z.infer<typeof botModelParamsSchema>;
export type FCurveKnotParam = z.infer<typeof fCurveKnotSchema>;

/** Parse + validate; throws a descriptive error on any schema violation. */
export function parseBotModelParams(input: unknown): BotModelParams {
  return botModelParamsSchema.parse(input);
}
