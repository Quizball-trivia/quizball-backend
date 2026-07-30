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
import {
  HARD_MIN_ANSWER_TIME_MS,
  HARD_SKILL_CAP,
  MIN_CEILING_ACCURACY,
} from './hard-clamps.js';

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
  // The slope MUST be strictly negative: higher human accuracy => easier
  // question => LOWER beta. A non-negative slope would invert difficulty
  // (bots would ace hard questions and miss easy ones), so it is rejected at
  // load — this is a safety invariant, not a fit diagnostic.
  slope: z.number().negative(),
  // Holdout validation of the link (fit on train questions, scored on holdout).
  holdoutR2: z.number().nullable(),
  holdoutRmse: z.number().nullable(),
  nQuestions: z.number().int().nonnegative(),
});

// Clamps. skillCap and minAnswerTimeMs are hard-bounded by the code backstops at
// load (they cannot LOOSEN). finalProbCap is advisory: the SAFETY guarantee is
// the code constant HARD_PROB_CAP (= the ceiling), and the model always applies
// min(paramsCap, HARD_PROB_CAP) at runtime — so finalProbCap may be any value in
// [0,1] but can never loosen the real cap. (The frozen S1 artifact carries 0.93;
// the runtime min tightens it to the ceiling.)
export const clampsSchema = z.object({
  finalProbCap: z.number().min(0).max(1),
  skillCap: z.number().positive().max(HARD_SKILL_CAP),
  minAnswerTimeMs: z.number().min(HARD_MIN_ANSWER_TIME_MS),
});

export const ceilingSchema = z.object({
  topCohortSize: z.number().int().nonnegative(),
  // Measured on HOLDOUT answers of the top cohort (no selection leakage).
  topAggregateAccuracyHoldout: z.number().min(0).max(1).nullable(),
  // In-sample number retained for reference/comparison only.
  topAggregateAccuracyInSample: z.number().min(0).max(1).nullable(),
  marginPp: z.number().nonnegative(),
  // Floored at MIN_CEILING_ACCURACY: a pathologically small ceiling would drive
  // the theta-ceiling solver to a large-negative bound and risk inverting the
  // skill cap. Rejected below the floor at load; the effective-cap helper also
  // guards against inversion at runtime.
  ceilingAccuracy: z.number().min(MIN_CEILING_ACCURACY).max(1),
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
