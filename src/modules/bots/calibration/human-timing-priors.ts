/**
 * Human answer-time priors for bot think-time.
 *
 * SOURCE: prod `match_answers`, ranked matches, HUMAN players only, the 30
 * days to 2026-09-17, time_ms in [200, 9999]. Per (phase x difficulty x
 * correctness) cell: p10 / p50 of time_ms and the log-sigma of ln(time_ms).
 * Re-measure with the same filter and paste the three numbers per cell.
 *
 * Why: bots answered hard questions at ~2.2s median regardless of correctness
 * and were under 1.5s on 30% of hard questions (humans: 11%) — a missing
 * per-question timing row fell back to category/type/global medians or the
 * 1184ms top-cohort median, the wrong-answer dwell was a flat +0.15 log units
 * while humans are 1.7-2.1x slower when wrong, and the floor was one
 * top-cohort p10 regardless of difficulty.
 */

export type TimingPhase = 'normal' | 'penalty';
export type TimingDifficulty = 'easy' | 'medium' | 'hard';

export interface HumanTimingPrior {
  /** 10th percentile of time_ms — the speed floor for the cell. */
  p10Ms: number;
  /** Median time_ms. */
  medianMs: number;
  /** Standard deviation of ln(time_ms). */
  logSigma: number;
}

type Cell = { correct: HumanTimingPrior; wrong: HumanTimingPrior };

const prior = (p10Ms: number, medianMs: number, logSigma: number): HumanTimingPrior => ({ p10Ms, medianMs, logSigma });

export const HUMAN_TIMING_PRIORS: Readonly<Record<TimingPhase, Readonly<Record<TimingDifficulty, Cell>>>> = {
  normal: {
    easy: { correct: prior(911, 1676, 0.66), wrong: prior(1234, 2819, 0.66) },
    medium: { correct: prior(1064, 2441, 0.72), wrong: prior(1551, 4347, 0.65) },
    hard: { correct: prior(1046, 2477, 0.76), wrong: prior(1751, 5263, 0.64) },
  },
  penalty: {
    easy: { correct: prior(885, 1715, 0.59), wrong: prior(1152, 2647, 0.61) },
    medium: { correct: prior(887, 1793, 0.62), wrong: prior(1069, 2516, 0.63) },
    hard: { correct: prior(1048, 2492, 0.64), wrong: prior(1263, 2954, 0.61) },
  },
};

/** Any phase other than 'penalty' (normal, last_attack, shot, undefined) uses the normal-play priors. */
export function timingPhase(phaseKind: string | null | undefined): TimingPhase {
  return phaseKind === 'penalty' ? 'penalty' : 'normal';
}

/** Unknown / missing difficulty labels use the medium priors. */
export function timingDifficulty(difficulty: string | null | undefined): TimingDifficulty {
  return difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium';
}

export function humanTimingPrior(
  phaseKind: string | null | undefined,
  difficulty: string | null | undefined,
  isCorrect: boolean,
): HumanTimingPrior {
  const cell = HUMAN_TIMING_PRIORS[timingPhase(phaseKind)][timingDifficulty(difficulty)];
  return isCorrect ? cell.correct : cell.wrong;
}

/** How much slower humans are when wrong vs. correct in this cell (median ratio, 1.2-2.1). */
export function humanWrongToCorrectMedianRatio(
  phaseKind: string | null | undefined,
  difficulty: string | null | undefined,
): number {
  const cell = HUMAN_TIMING_PRIORS[timingPhase(phaseKind)][timingDifficulty(difficulty)];
  return cell.wrong.medianMs / cell.correct.medianMs;
}
