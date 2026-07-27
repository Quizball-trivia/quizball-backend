/**
 * Markdown report writer for the offline calibration run. Kept separate from the
 * orchestrator so the report layout is easy to review/edit.
 */

import { writeFileSync } from 'node:fs';
import { FULL_DURATION_MS, TIMING_CLEAN_WINDOW_START } from '../../src/modules/bots/calibration/constants.js';
import type { FCurveKnot } from '../../src/modules/bots/calibration/math.js';

interface CalibrationCurvePoint {
  binLow: number;
  binHigh: number;
  count: number;
  meanPredicted: number;
  observed: number;
}

export interface ReportData {
  batch: { id: string; season_number: number | null; completed_at: string | null };
  cohort: {
    placedProfiles: number;
    answersScanned: number;
    eligiblePlayers: number;
    minAnswers: number;
    fitTrainRows: number;
    holdoutRows: number;
    joinedForFCurve: number;
  };
  validation: {
    auc: number | null;
    calibration: CalibrationCurvePoint[];
    selfConsistencyR: number | null;
    fitConverged: boolean;
    fitIters: number;
  };
  fCurve: FCurveKnot[];
  ceiling: {
    topCohortSize: number;
    topAggregateAccuracy: number;
    marginPp: number;
    ceilingAccuracy: number;
    speedFloor: Array<{ percentile: number; timeMs: number }>;
    topMedianTimeMs: number | null;
    topLogTimeSigma: number | null;
  };
  formatOffsets: Record<string, number>;
  referenceFormat: string;
  marginPp: number;
  limit?: number;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function writeReport(path: string, d: ReportData): void {
  const lines: string[] = [];
  const push = (s = ''): void => void lines.push(s);

  push('# Season-1 Bot Calibration Report');
  push();
  push(`Generated: ${new Date().toISOString()}`);
  if (d.limit) push(`\n> ⚠️ SMOKE RUN — answers capped at --limit ${d.limit}. Numbers are NOT production-ready.`);
  push();

  push('## Frozen Layer-1 ceiling constants (for PR8)');
  push();
  push('These are the immutable, non-CMS-tunable backstops PR8 bakes into code.');
  push('Copy the block below verbatim.');
  push();
  push('```ts');
  push('// Season-1 calibration — Layer-1 hard backstop (immutable at runtime).');
  push(`export const S1_TOP_COHORT_AGGREGATE_ACCURACY = ${d.ceiling.topAggregateAccuracy.toFixed(4)};`);
  push(`export const S1_CEILING_MARGIN_PP = ${d.marginPp};`);
  push(`export const S1_CEILING_ACCURACY = ${d.ceiling.ceilingAccuracy.toFixed(4)}; // top aggregate − margin`);
  push(`export const S1_TOP_MEDIAN_TIME_MS = ${d.ceiling.topMedianTimeMs ?? 'null'};`);
  push(`export const S1_TOP_LOG_TIME_SIGMA = ${d.ceiling.topLogTimeSigma?.toFixed(4) ?? 'null'};`);
  push('export const S1_SPEED_FLOOR_MS = {');
  for (const s of d.ceiling.speedFloor) push(`  p${Math.round(s.percentile * 100)}: ${s.timeMs},`);
  push('};');
  push('```');
  push();
  push(`Top cohort: ${d.ceiling.topCohortSize} players. Aggregate accuracy ${pct(d.ceiling.topAggregateAccuracy)} → ceiling ${pct(d.ceiling.ceilingAccuracy)} after a ${d.marginPp}pp margin.`);
  push();

  push('## Cohort sizes & exclusions');
  push();
  push('| Metric | Value |');
  push('| --- | --- |');
  push(`| S1 reset batch | \`${d.batch.id}\` (season ${d.batch.season_number ?? 'n/a'}) |`);
  push(`| Placed S1 profiles (non-AI/seed/deleted) | ${d.cohort.placedProfiles} |`);
  push(`| Bernoulli answers scanned | ${d.cohort.answersScanned} |`);
  push(`| Eligible players (≥ ${d.cohort.minAnswers} answers) | ${d.cohort.eligiblePlayers} |`);
  push(`| Fit train rows / holdout rows | ${d.cohort.fitTrainRows} / ${d.cohort.holdoutRows} |`);
  push(`| Players joined for f(RP) (placed ∩ skill) | ${d.cohort.joinedForFCurve} |`);
  push();
  push('### Exclusions applied (identical to the refresh job)');
  push();
  push('- **AI / seed / deleted users** (`users.is_ai`, `is_seed`, `is_deleted`, `deleted_at`).');
  push('- **Dev matches** (`matches.is_dev = true`); only `mode=ranked`, `status=completed`.');
  push('- **Timeout backfills** — see below.');
  push('- **Countdown** answers excluded from the logit (opponent-relative `is_correct`).');
  push(`- **Timing clean-window**: only \`answered_at >= ${TIMING_CLEAN_WINDOW_START}\` feeds timing (accuracy uses all completed ranked answers; pre-window \`time_ms\` is corrupt).`);
  push();
  push('### Timeout-backfill signature');
  push();
  push('A timeout backfill is persisted by `possession-round-resolver.ts` for every');
  push('un-answered player when a question times out. It is identified — and excluded —');
  push('by the CONJUNCTION of all four persisted fields (any one alone is insufficient,');
  push('because real answers are clamped to `[0, duration]` and can share `time_ms=duration`):');
  push();
  push('```sql');
  push('selected_index IS NULL');
  push('AND is_correct = false');
  push('AND points_earned = 0');
  push('AND time_ms = <full duration for the question kind>');
  push('```');
  push();
  push('Full durations by kind (ms): ' +
    `multipleChoice=${FULL_DURATION_MS.multipleChoice}, countdown=${FULL_DURATION_MS.countdown}, ` +
    `putInOrder=${FULL_DURATION_MS.putInOrder}, clues=${FULL_DURATION_MS.clues}.`);
  push();
  push('For MCQ this is exact (a real MCQ answer always persists a non-null `selected_index`,');
  push('even a wrong buzzer-beater). For non-MCQ formats a real answer also persists');
  push('`selected_index = NULL`, so the conjunction with `points_earned = 0`, `is_correct = false`,');
  push('and the exact full-duration `time_ms` is the discriminator. The only residual over-');
  push('exclusion is a real non-MCQ answer that scored 0, was wrong, AND landed at the exact');
  push('clamp ceiling — negligible and accepted.');
  push();

  push('## f(RP) → skill curve (fixed S1 scale)');
  push();
  push('Maps S2 RP to latent skill via percentile anchoring on the **placed S1** RP and');
  push('skill distributions (NOT live S2 percentiles). Knots:');
  push();
  push('| RP | skill (logit θ) |');
  push('| --- | --- |');
  for (const k of d.fCurve) push(`| ${k.rp} | ${k.skill.toFixed(4)} |`);
  push();

  push('## Format easiness offsets (γ, reference pinned to 0)');
  push();
  push(`Reference format: \`${d.referenceFormat}\`.`);
  push();
  push('| format | γ |');
  push('| --- | --- |');
  for (const [f, g] of Object.entries(d.formatOffsets)) push(`| ${f} | ${g.toFixed(4)} |`);
  push();

  push('## Validation');
  push();
  push(`- Fit converged: ${d.validation.fitConverged} (iters ${d.validation.fitIters}).`);
  push(`- Holdout AUC: ${d.validation.auc != null ? d.validation.auc.toFixed(3) : 'n/a'}.`);
  push(`- Self-consistency (train per-player observed vs predicted, Pearson r): ${d.validation.selfConsistencyR != null ? d.validation.selfConsistencyR.toFixed(3) : 'n/a'}.`);
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
