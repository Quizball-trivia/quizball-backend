/**
 * Markdown report writer for the offline calibration run. Kept separate from the
 * orchestrator so the report layout is easy to review/edit.
 */

import { writeFileSync } from 'node:fs';
import { TIMING_CLEAN_WINDOW_START } from '../../src/modules/bots/calibration/constants.js';
import type { FCurveKnot } from '../../src/modules/bots/calibration/math.js';
import type { AggregateResult } from '../../src/modules/bots/calibration/aggregate.js';
import type { BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';

interface CalibrationCurvePoint {
  binLow: number;
  binHigh: number;
  count: number;
  meanPredicted: number;
  observed: number;
}

export interface ReportData {
  batch: { id: string; season_number: number | null; completed_at: string | null };
  s1Boundary: string;
  isSmokeRun: boolean;
  cohort: {
    placedProfiles: number;
    s1BernoulliAnswers: number;
    eligiblePlayers: number;
    minAnswers: number;
    fitTrainRows: number;
    holdoutRows: number;
    joinedForFCurve: number;
  };
  exclusions: AggregateResult['exclusions'];
  formatDistribution: Record<string, number>;
  questionStatsCount: number;
  backoffCount: number;
  globalMean: number;
  accuracyByDifficulty: Array<{ difficulty: string; questions: number; meanSmoothedAccuracy: number }>;
  validation: {
    holdoutAuc: number | null;
    calibration: CalibrationCurvePoint[];
    fitConverged: boolean;
    fitIters: number;
    finalUpdateNorm: number;
  };
  difficultyLink: BotModelParams['difficultyLink'];
  fCurve: FCurveKnot[];
  ceiling: BotModelParams['ceiling'];
  clamps: BotModelParams['clamps'];
  marginPp: number;
}

function pct(x: number | null): string {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

export function writeReport(path: string, d: ReportData): void {
  const lines: string[] = [];
  const push = (s = ''): void => void lines.push(s);

  push('# Season-1 Bot Calibration Report');
  push();
  push(`Generated: ${new Date().toISOString()}`);
  push(`S1 batch: \`${d.batch.id}\` (season ${d.batch.season_number ?? 'n/a'}), boundary ${d.s1Boundary}`);
  if (d.isSmokeRun) push('\n> ⚠️ SMOKE RUN (--limit): sampled data, NOT production-ready.');
  push();

  push('## Frozen Layer-1 ceiling constants (for PR8)');
  push();
  push('Immutable, non-CMS-tunable backstops PR8 bakes into code. Copy verbatim.');
  push();
  push('```ts');
  push('// Season-1 calibration — Layer-1 hard backstop (immutable at runtime).');
  push(`export const S1_TOP_COHORT_ACCURACY_HOLDOUT = ${d.ceiling.topAggregateAccuracyHoldout?.toFixed(4) ?? 'null'};`);
  push(`export const S1_CEILING_MARGIN_PP = ${d.marginPp};`);
  push(`export const S1_CEILING_ACCURACY = ${d.ceiling.ceilingAccuracy.toFixed(4)}; // holdout accuracy − margin`);
  push(`export const S1_TOP_MEDIAN_TIME_MS = ${d.ceiling.topMedianTimeMs ?? 'null'};`);
  push(`export const S1_TOP_LOG_TIME_SIGMA = ${d.ceiling.topLogTimeSigma?.toFixed(4) ?? 'null'};`);
  push('export const S1_SPEED_FLOOR_MS = {');
  for (const s of d.ceiling.speedFloor) push(`  p${Math.round(s.percentile * 100)}: ${s.timeMs},`);
  push('};');
  push(`export const FINAL_PROB_CAP = ${d.clamps.finalProbCap};`);
  push(`export const SKILL_CAP = ${d.clamps.skillCap};`);
  push(`export const MIN_ANSWER_TIME_MS = ${d.clamps.minAnswerTimeMs};`);
  push('```');
  push();
  push(`Top cohort: ${d.ceiling.topCohortSize} players. Ceiling accuracy measured on HOLDOUT: ${pct(d.ceiling.topAggregateAccuracyHoldout)} (in-sample ${pct(d.ceiling.topAggregateAccuracyInSample)}, for reference). Ceiling = holdout − ${d.marginPp}pp = ${pct(d.ceiling.ceilingAccuracy)}.`);
  push();

  push('## Cohort sizes & MEASURED exclusions');
  push();
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Placed S1 profiles (non-AI/seed/deleted) | ${d.cohort.placedProfiles} |`);
  push(`| S1 Bernoulli answers (placed, pre-boundary, non-backfill) | ${d.cohort.s1BernoulliAnswers} |`);
  push(`| Eligible players (≥ ${d.cohort.minAnswers} answers) | ${d.cohort.eligiblePlayers} |`);
  push(`| Fit train / holdout rows | ${d.cohort.fitTrainRows} / ${d.cohort.holdoutRows} |`);
  push(`| Players joined for f(RP) (placed ∩ skill) | ${d.cohort.joinedForFCurve} |`);
  push();
  push('### question_stats aggregation exclusion counts (MEASURED, whole-DB scan)');
  push();
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| Total eligible answer rows scanned | ${d.exclusions.totalRows} |`);
  push(`| Bernoulli rows | ${d.exclusions.bernoulliRows} |`);
  push(`| Bernoulli backfills excluded (selected_index NULL) | ${d.exclusions.bernoulliBackfills} |`);
  push(`| Special-format rows (countdown/put-in-order/clues) | ${d.exclusions.specialRows} |`);
  push(`| Bernoulli rows outside timing clean-window | ${d.exclusions.bernoulliOutsideTimingWindow} |`);
  push(`| question_stats rows built | ${d.questionStatsCount} |`);
  push(`| backoff rows built | ${d.backoffCount} |`);
  push(`| global Bernoulli mean accuracy | ${pct(d.globalMean)} |`);
  push();
  push('### Format distribution (all scanned answers by question type)');
  push();
  push('| type | answers |');
  push('| --- | --- |');
  for (const [t, n] of Object.entries(d.formatDistribution).sort((a, b) => b[1] - a[1])) push(`| ${t} | ${n} |`);
  push();

  push('### Exclusion rules');
  push();
  push('- AI / seed / deleted users; dev matches; only `mode=ranked, status=completed`.');
  push('- **Bernoulli set** = mcq_single / true_false / input_text (engine kind `multipleChoice`). Only these feed accuracy + the latent-skill logit.');
  push('- **Backfill** (Bernoulli) = `selected_index IS NULL` — a genuine multiple-choice answer always persists a non-null index. The old time_ms-conjunction was dropped: clue chains vary in length and a real countdown player can persist the backfill signature (resolver fires a zero-valued insert before reading the real result, ON CONFLICT DO NOTHING).');
  push('- **countdown / put-in-order / clues** never enter accuracy/timing (countdown is opponent-relative; specials are partial-credit and their backfills are indistinguishable). They are modelled via payload-aware `format_stats` distributions.');
  push(`- **Timing clean-window**: only \`answered_at >= ${TIMING_CLEAN_WINDOW_START}\` feeds median/sigma; accuracy ignores the window. Accuracy and timing back off INDEPENDENTLY (each with its own sample count).`);
  push();

  push('## Accuracy by question difficulty (Bernoulli, whole population)');
  push();
  push('| difficulty | answers | mean accuracy |');
  push('| --- | --- | --- |');
  for (const b of d.accuracyByDifficulty) push(`| ${b.difficulty} | ${b.questions} | ${pct(b.meanSmoothedAccuracy)} |`);
  push();

  push('## Latent-skill fit & validation');
  push();
  push(`- Model: \`sigmoid(theta_player − beta_question)\` (no format term — beta absorbs format difficulty; each question has one format).`);
  push(`- Fit converged: **${d.validation.fitConverged}** (iters ${d.validation.fitIters}, final mean-abs update ${d.validation.finalUpdateNorm.toExponential(2)}).`);
  push(`- Holdout AUC: ${d.validation.holdoutAuc != null ? d.validation.holdoutAuc.toFixed(3) : 'n/a'}.`);
  push();
  if (d.validation.calibration.length > 0) {
    push('### Holdout calibration curve');
    push();
    push('| bin | n | mean predicted | observed |');
    push('| --- | --- | --- | --- |');
    for (const c of d.validation.calibration) {
      if (c.count === 0) continue;
      push(`| ${c.binLow.toFixed(1)}–${c.binHigh.toFixed(1)} | ${c.count} | ${pct(c.meanPredicted)} | ${pct(c.observed)} |`);
    }
    push();
  }

  push('## Difficulty link (PR8 recovers beta from question_stats)');
  push();
  push('`beta_question ≈ intercept + slope · logit(question_stats.smoothed_accuracy)`.');
  push('Slope is negative (higher accuracy → lower difficulty).');
  push();
  push('| param | value |');
  push('| --- | --- |');
  push(`| intercept | ${d.difficultyLink.intercept.toFixed(4)} |`);
  push(`| slope | ${d.difficultyLink.slope.toFixed(4)} |`);
  push(`| holdout R² | ${d.difficultyLink.holdoutR2?.toFixed(3) ?? 'n/a'} |`);
  push(`| holdout RMSE (beta units) | ${d.difficultyLink.holdoutRmse?.toFixed(3) ?? 'n/a'} |`);
  push(`| questions in link | ${d.difficultyLink.nQuestions} |`);
  push();

  push('## f(RP) → skill curve (fixed S1 scale, placed profiles)');
  push();
  push('| RP | skill (logit θ) |');
  push('| --- | --- |');
  for (const k of d.fCurve) push(`| ${k.rp} | ${k.skill.toFixed(4)} |`);
  push();

  push('## Speed (top-cohort answer times)');
  push();
  push(`Top-cohort median ${d.ceiling.topMedianTimeMs ?? 'n/a'} ms, ln-time σ ${d.ceiling.topLogTimeSigma?.toFixed(3) ?? 'n/a'}.`);
  push();
  push('| percentile | time (ms) |');
  push('| --- | --- |');
  for (const s of d.ceiling.speedFloor) push(`| p${Math.round(s.percentile * 100)} | ${s.timeMs} |`);
  push();

  writeFileSync(path, lines.join('\n'));
}
