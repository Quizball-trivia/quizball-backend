/**
 * Human accuracy priors by difficulty LABEL, for bot correctness.
 *
 * SOURCE: prod `match_answers`, ranked matches, HUMAN players only, NORMAL
 * phase, the 7 days to 2026-09-17: fraction of Bernoulli answers that were
 * correct per questions.difficulty label. Re-measure with the same filter and
 * paste the three numbers. (Penalty phase measured easy 0.79 / medium 0.62 /
 * hard 0.44 over the same window; deliberately not modelled — the code does
 * not distinguish phase for accuracy.)
 *
 * Why: without fresh question_stats the accuracy backoff lands on
 * category_type/type/global, so every question in a category looked equally
 * hard to the persistent model and its correctness ignored the label. The
 * ephemeral model's hand-set 1.35 / 1 / 0.65 multipliers are replaced by the
 * measured ratios relative to medium (easy ~1.31, hard ~0.78).
 */

export type AccuracyDifficulty = 'easy' | 'medium' | 'hard';

export const HUMAN_ACCURACY_PRIORS: Readonly<Record<AccuracyDifficulty, number>> = {
  easy: 0.702,
  medium: 0.537,
  hard: 0.420,
};

/** Unknown / missing difficulty labels use the medium prior. */
export function accuracyDifficulty(difficulty: string | null | undefined): AccuracyDifficulty {
  return difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium';
}

export function humanAccuracyPrior(difficulty: string | null | undefined): number {
  return HUMAN_ACCURACY_PRIORS[accuracyDifficulty(difficulty)];
}

/** Human accuracy for the label relative to medium — the ephemeral model's difficulty multiplier. */
export function humanAccuracyRatioToMedium(difficulty: string | null | undefined): number {
  return humanAccuracyPrior(difficulty) / HUMAN_ACCURACY_PRIORS.medium;
}
