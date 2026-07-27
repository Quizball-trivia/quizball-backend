/**
 * Shared calibration constants — the SINGLE source of truth for the exclusion
 * rules that the offline calibration script (scripts/bot-calibration) and the
 * question_stats refresh job (question-stats-refresh.job.ts) must agree on.
 *
 * These are intentionally duplicated here (not imported from the realtime
 * engine) so the calibration pipeline is decoupled from gameplay code and a
 * refactor there cannot silently change what the pipeline treats as a timeout
 * backfill. The values are asserted against the engine constants in the unit
 * tests, so drift is caught.
 */

import type { MatchQuestionKind } from '../../../realtime/socket.types.js';

/**
 * Full question durations in ms, by kind. Retained for the report/diagnostics
 * only — it is NO LONGER used to detect timeout backfills.
 *
 * Backfill detection used to compare time_ms against these constants, but that
 * is unreliable: (a) clue chains run 10s × min(clueCount, 5), so a shorter
 * chain's backfill has time_ms < 50_000; and (b) a real interacting countdown
 * player can persist the exact backfill signature because the resolver fires a
 * zero-valued backfill insert BEFORE reading the player's real found-IDs and
 * the repo upserts ON CONFLICT DO NOTHING (possession-round-resolver.ts:201/262,
 * match-answers.repo.ts). We therefore restrict Bernoulli modelling to the
 * multiple-choice kinds and use the selected_index rule below.
 */
export const FULL_DURATION_MS: Record<MatchQuestionKind, number> = {
  multipleChoice: 10_000,
  putInOrder: 30_000,
  countdown: 30_000,
  clues: 50_000, // CLUES_PER_CLUE_MS (10_000) * CLUES_MAX_CLUES (5)
};

/**
 * Clean-window boundary for TIMING data. Before this instant, time_ms is
 * corrupt (the pre-reveal-ack scoring regression: instant->70 / slow->100, a
 * large fraction of answers had time_ms=0; prod hotfix shipped 2026-07-05).
 * ACCURACY (is_correct) before this date is fine — only timing is excluded.
 *
 * Per the plan the boundary is 2026-07-05T00:00:00Z (UTC). Timing samples with
 * answered_at strictly before this are dropped from median/sigma; accuracy
 * ignores the boundary entirely.
 */
export const TIMING_CLEAN_WINDOW_START = '2026-07-05T00:00:00Z';

/**
 * Question `type` values whose engine kind is `multipleChoice` and which
 * therefore (a) persist a real non-null selected_index for a genuine answer,
 * and (b) carry a true per-question Bernoulli is_correct (answerability, not an
 * opponent-relative result). These — and ONLY these — feed the latent-skill
 * logit and the smoothed_accuracy / global prior.
 *
 * The other kinds are handled separately (§ per-format models):
 *  - countdown_list: is_correct is opponent-relative (ties => both false), so it
 *    is NOT answerability. Modelled via a found-count distribution in
 *    format_stats. Never enters the Bernoulli prior or the logit.
 *  - put_in_order: partial-credit; modelled via a partial-credit distribution.
 *  - clue_chain: modelled via a reveal-index distribution.
 */
export const BERNOULLI_TYPES = ['mcq_single', 'true_false', 'input_text'] as const;
export type BernoulliType = (typeof BERNOULLI_TYPES)[number];

/** Non-Bernoulli special formats that get payload-aware format_stats instead. */
export const SPECIAL_TYPES = ['countdown_list', 'put_in_order', 'clue_chain'] as const;
export type SpecialType = (typeof SPECIAL_TYPES)[number];

/** Bayesian shrinkage prior strength (pseudo-answers) toward the global mean. */
export const SMOOTHING_PRIOR_N0 = 20;

/**
 * Minimum real answers a scope needs before it is trusted as a fallback target.
 * Resolved INDEPENDENTLY for accuracy vs timing (each has its own sample count).
 */
export const BACKOFF_MIN_SAMPLE = 30;

/**
 * Runtime clamps emitted for PR8 (Layer-1 backstops live in the ceiling block;
 * these are the per-question/skill/timing caps the gameplay model must apply).
 * Values chosen per the plan: final per-question probability cap 0.93 (below
 * today's effective 0.97), a skill cap, and timing floors that PR8 clamps
 * sampled answer times to. PR8 imports the zod-validated params; these defaults
 * are the values the calibration writes unless overridden.
 */
export const PARAMS_FINAL_PROB_CAP = 0.93;
export const PARAMS_SKILL_CAP = 4.0; // logit theta hard cap
export const PARAMS_MIN_ANSWER_TIME_MS = 600; // absolute floor for sampled times
