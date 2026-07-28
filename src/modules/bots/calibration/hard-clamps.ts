/**
 * IMMUTABLE Layer-1 backstops for the persistent-bot gameplay model (PR8, §1.5).
 *
 * These are CODE CONSTANTS, not params. A CMS/DB `bot_model_params` row can only
 * ever make the effective clamps STRICTER, never looser:
 *   - final per-question probability : min(paramsCap, HARD_PROB_CAP)
 *   - effective skill (theta)        : min(paramsSkillCap, HARD_SKILL_CAP)
 *   - minimum answer time            : max(paramsFloor, HARD_MIN_ANSWER_TIME_MS)
 *   - speed floor                    : max(measured floor, HARD_MIN_ANSWER_TIME_MS)
 *
 * The params-schema (params-schema.ts) additionally REJECTS at load any row that
 * tries to exceed these — so a bad row can never even be stored/activated — and
 * the gameplay model re-applies the min/max at runtime as defence in depth
 * (a row written before a schema tightening still can't breach the code cap).
 *
 * Values frozen from the Season-1 calibration report (calibration-s1final/REPORT.md).
 * They are the be#175 insurance: even if every tunable is maxed, the bot cannot
 * exceed these.
 */

/** Final per-question P(correct) can never exceed this, after every term. */
export const HARD_PROB_CAP = 0.93;

/** Effective skill theta (post tilt/form/noise) is bounded to +/- this. */
export const HARD_SKILL_CAP = 4;

/** No sampled/committed answer time may be below this many ms. */
export const HARD_MIN_ANSWER_TIME_MS = 600;

/**
 * Frozen aggregate accuracy ceiling and the real top-cohort accuracy it derives
 * from (holdout − margin). The model's effective theta is additionally bounded
 * so the EXPECTED aggregate over the real difficulty mix cannot exceed this — a
 * hard runtime constraint, not merely telemetry.
 */
export const HARD_CEILING_ACCURACY = 0.8631;
export const S1_TOP_COHORT_ACCURACY_HOLDOUT = 0.9031;

/**
 * Conservative frozen fallback for the ceiling-derived theta bound, used when the
 * live question_stats table is empty (a fresh DB) so the pin-time solver has no
 * empirical beta distribution. Derived so that, over a symmetric mean-0 beta
 * spread, the expected aggregate stays at/under HARD_CEILING_ACCURACY AND a
 * top-of-curve bot lands strictly below the real top cohort (the §1.5 downward
 * delta). Deliberately conservative: a real (non-empty) DB computes a tighter,
 * data-derived bound at pin time.
 */
export const HARD_THETA_CEILING_FALLBACK = 1.6;
