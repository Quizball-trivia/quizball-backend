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
 * THE AGGREGATE-CEILING GUARANTEE (redesigned after Sol's ceiling-math pass).
 * The ONLY distribution-independent bound on a bot's aggregate accuracy is the
 * per-question probability cap: over ANY question mix, aggregate accuracy ≤ the
 * per-question cap. Solving E_D[sigmoid(θ−β)] = ceiling for the FULL-POOL
 * distribution D does NOT bound accuracy on an easy-only draft (a reachable mix
 * when the possession gap is small), so the θ-ceiling solver is a nicety for the
 * expected aggregate — NOT the safety guarantee.
 *
 * Therefore HARD_PROB_CAP is set to the frozen ceiling accuracy itself, so the
 * worst reachable aggregate over ANY mix = HARD_PROB_CAP = the ceiling
 * (86.31%) ≤ the real top cohort (90.31%, the §1.5 4pp downward δ). The win-rate
 * GOVERNOR (PR9) is the closed loop that steers actual win-rate into the 40-45%
 * band; this model only guarantees the bot can never STRUCTURALLY exceed the
 * per-question ceiling.
 *
 * Values frozen from the Season-1 calibration report (calibration-s1final/REPORT.md).
 */

/** The real top-cohort holdout aggregate accuracy (10 players) and the margin. */
export const S1_TOP_COHORT_ACCURACY_HOLDOUT = 0.9031;
export const S1_CEILING_MARGIN = 0.04;

/**
 * Frozen aggregate accuracy ceiling = top-cohort holdout − 4pp margin. This is
 * both the aggregate target AND the per-question hard cap (see HARD_PROB_CAP).
 */
export const HARD_CEILING_ACCURACY = 0.8631;

/**
 * Final per-question P(correct) can never exceed this, after EVERY term. Set to
 * the frozen ceiling so that the worst reachable aggregate on ANY question mix
 * (including an all-easy draft) equals the ceiling — the only
 * distribution-independent guarantee. Below the real top cohort by the 4pp δ, so
 * even on easy questions a bot stays at/under top humans per-question and hence
 * in aggregate. (Was 0.93, which allowed +6.69pp over the ceiling on easy mixes.)
 */
export const HARD_PROB_CAP = HARD_CEILING_ACCURACY;

/** Effective skill theta (post tilt/form/noise) is bounded to +/- this. */
export const HARD_SKILL_CAP = 4;

/** No sampled/committed answer time may be below this many ms. */
export const HARD_MIN_ANSWER_TIME_MS = 600;

/**
 * Minimum allowed ceilingAccuracy in params. A pathologically small ceiling
 * (e.g. 0) would make the θ-ceiling solver return a large-negative bound and, if
 * mis-clamped, could INVERT the skill cap. The schema floors ceilingAccuracy here
 * and the effective-cap helper additionally guards against inversion.
 */
export const MIN_CEILING_ACCURACY = 0.5;

/**
 * Conservative frozen fallback for the ceiling-derived theta bound, used when the
 * live question_stats table is empty (a fresh DB) so the pin-time solver has no
 * empirical beta distribution. The θ bound is only an EXPECTED-aggregate nicety
 * now (the per-question cap is the safety guarantee), so a modest value is fine.
 */
export const HARD_THETA_CEILING_FALLBACK = 1.6;
