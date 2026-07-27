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
 * Full question durations in ms, by kind. A timeout backfill persists exactly
 * this value into match_answers.time_ms (see possession-round-resolver.ts, which
 * writes getQuestionDurationMs(kind) for every un-answered player on timeout).
 *
 * Mirrors QUESTION_TIME_MS / PUT_IN_ORDER_QUESTION_TIME_MS /
 * COUNTDOWN_QUESTION_TIME_MS / CLUES_PER_CLUE_MS * CLUES_MAX_CLUES in
 * possession-state.ts. Kept in sync by calibration.constants.test.ts.
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
 * The boundary is deliberately set to the day AFTER the prod hotfix in Georgia
 * time expressed as a UTC instant, so the noisy transition day is fully
 * excluded from the timing distributions. Accuracy stats ignore this boundary.
 */
export const TIMING_CLEAN_WINDOW_START = '2026-07-06T00:00:00Z';

/**
 * Question `type` values (public.questions.type) that produce a Bernoulli
 * is_correct signal suitable for the latent-skill logit and for per-question
 * smoothed_accuracy. countdown_list is opponent-relative (is_correct compares
 * the two seats' found counts in the resolver), so it is NOT a Bernoulli
 * signal and is excluded from the logit; its distribution is modelled in
 * format_stats instead. put_in_order / clue_chain carry partial credit but
 * their is_correct is still a per-player boolean, so they contribute to
 * accuracy stats (not to the logit, to keep the latent scale clean).
 */
export const BERNOULLI_LOGIT_TYPES = ['mcq_single', 'true_false', 'input_text'] as const;

/** Bayesian shrinkage prior strength (pseudo-answers) toward the global mean. */
export const SMOOTHING_PRIOR_N0 = 20;

/**
 * Minimum real answers a backoff scope needs before it is trusted as a fallback
 * target. Below this the resolver descends to the next-broader scope.
 */
export const BACKOFF_MIN_SAMPLE = 30;
