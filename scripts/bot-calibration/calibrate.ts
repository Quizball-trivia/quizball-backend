#!/usr/bin/env npx tsx
/**
 * Offline Season-1 calibration (persistent-bot roster, PR4 deliverable A).
 *
 * PROD READ-ONLY. Connects ONLY via CALIBRATION_DATABASE_URL, runs every query
 * inside a READ ONLY transaction, screens every statement as SELECT-only, and
 * writes NOTHING to the database. Outputs go to a local directory:
 *   - params.json                 (schema-validated bot_model_params.params)
 *   - bot_model_params.insert.sql (an INSERT for human review — NOT applied)
 *   - REPORT.md                   (cohorts, MEASURED exclusion counts, question-
 *                                  stats diagnostics, accuracy-by-difficulty,
 *                                  format distributions, curves, validation,
 *                                  and the FROZEN Layer-1 ceiling constants)
 *
 * Pipeline (addresses Sol's review):
 *  1. Resolve the S1 reset batch; take its completed_at as the S1 boundary.
 *  2. Placed S1 profiles → the fit population (intersect BEFORE fitting/anchoring).
 *  3. Bernoulli S1 answers (pre-boundary, placed players, non-backfill) only.
 *  4. Eligibility (>= min-answers) computed on that scoped set.
 *  5. 80/20 holdout split. Fit theta/beta on TRAIN.
 *  6. Top cohort selected on TRAIN theta; ceiling accuracy measured on HOLDOUT
 *     answers of that cohort (no selection leakage). Report in-sample too.
 *  7. REFIT on ALL scoped rows for the final theta/beta → f(RP) knots.
 *  8. difficultyLink: regress refit beta on logit(question_stats.smoothed_accuracy),
 *     holdout-validated, so PR8 can recover beta from question_stats.
 *  9. Emit schema-validated params.json (refuse if the refit did not converge).
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openReadOnlyDb } from './readonly-db.js';
import { fetchAccuracyByDifficulty, fetchPlacedProfiles, fetchS1BernoulliAnswers, fetchS1CleanTimesForPlayers, resolveBatch, withBatchRetry } from './queries.js';
import { fitLatentSkill, predictProb, type LatentAnswer, type LatentFitResult } from '../../src/modules/bots/calibration/latent-skill.js';
import { buildFCurve, percentile, rocAuc, calibrationCurve, logNormalTimeStats, linearFit, logit } from '../../src/modules/bots/calibration/math.js';
import { aggregateQuestionStats } from '../../src/modules/bots/calibration/aggregate.js';
import { botModelParamsSchema, CALIBRATION_SCHEMA_VERSION, type BotModelParams } from '../../src/modules/bots/calibration/params-schema.js';
import { TIMING_CLEAN_WINDOW_START, PARAMS_FINAL_PROB_CAP, PARAMS_SKILL_CAP, PARAMS_MIN_ANSWER_TIME_MS } from '../../src/modules/bots/calibration/constants.js';
import { writeReport } from './report.js';

interface Args {
  season?: number;
  batchId?: string;
  minAnswers: number;
  marginPp: number;
  limit?: number;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const num = (v: string | undefined): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Malformed numeric flag value: ${v}`);
    return n;
  };
  return {
    season: num(get('--season')),
    batchId: get('--batch-id'),
    minAnswers: num(get('--min-answers')) ?? 100,
    marginPp: num(get('--margin-pp')) ?? 4,
    limit: num(get('--limit')),
    out: get('--out') ?? 'scripts/bot-calibration/out',
  };
}

const FCURVE_PERCENTILES = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];
const SPEED_FLOOR_PERCENTILES = [0.1, 0.25, 0.5];

/** Seeded xorshift for a reproducible holdout split. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const isSmokeRun = args.limit != null && args.limit > 0;
  // Ops overrides for long prod runs against the pooler:
  //  - CALIBRATION_STATEMENT_TIMEOUT_MS: per-statement server timeout.
  //  - CALIBRATION_MAX_ITERS: fit iteration cap (raise if a large fit needs it).
  const envInt = (name: string, fallback: number): number => {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Malformed ${name}: ${raw}`);
    return n;
  };
  const statementTimeoutMs = envInt('CALIBRATION_STATEMENT_TIMEOUT_MS', 120_000);
  const fitOpts = { maxIters: envInt('CALIBRATION_MAX_ITERS', 5000) };
  const db = openReadOnlyDb({ statementTimeoutMs });
  try {
    const batch = await withBatchRetry(() => resolveBatch(db.query, { batchId: args.batchId, season: args.season }));
    if (!batch) throw new Error('No matching ranked_reset_batches row (check --season / --batch-id)');
    const s1Boundary = batch.completed_at;
    if (!s1Boundary) throw new Error('Resolved S1 batch has no completed_at; cannot scope Season-1 matches');

    const profiles = await withBatchRetry(() => fetchPlacedProfiles(db.query, batch.id));
    const placedIds = profiles.map((p) => p.user_id);
    if (placedIds.length === 0) throw new Error('No placed S1 profiles for this batch');

    // S1 Bernoulli answers, already scoped to placed players + pre-boundary.
    const rawAnswers = await withBatchRetry(() => fetchS1BernoulliAnswers(db.query, {
      s1Boundary,
      placedPlayerIds: placedIds,
      limit: args.limit,
    }));
    if (rawAnswers.length === 0) throw new Error('No Season-1 Bernoulli answers for placed players');

    // Eligibility on the SCOPED set.
    const countByPlayer = new Map<string, number>();
    for (const r of rawAnswers) countByPlayer.set(r.player_id, (countByPlayer.get(r.player_id) ?? 0) + 1);
    const eligible = new Set([...countByPlayer.entries()].filter(([, n]) => n >= args.minAnswers).map(([id]) => id));
    const scoped: LatentAnswer[] = rawAnswers
      .filter((r) => eligible.has(r.player_id))
      .map((r) => ({ playerId: r.player_id, questionId: r.question_id, correct: r.correct ? 1 : 0 }));
    if (scoped.length === 0) throw new Error('No players meet --min-answers on the S1 scoped set');

    // Holdout split.
    const rng = makeRng(0x9e3779b1);
    const train: LatentAnswer[] = [];
    const holdout: LatentAnswer[] = [];
    for (const a of scoped) (rng() < 0.2 ? holdout : train).push(a);

    const trainFit = fitLatentSkill(train, fitOpts);

    // Holdout validation on rows whose player+question are in the train design.
    const scored = holdout.filter((a) => trainFit.theta.has(a.playerId) && trainFit.beta.has(a.questionId));
    const preds = scored.map((a) => predictProb(trainFit, a));
    const labels = scored.map((a) => a.correct);
    const holdoutAuc = scored.length > 0 ? rocAuc(preds, labels) : null;
    const calibration = scored.length > 0 ? calibrationCurve(preds, labels, 10) : [];

    // Top cohort selected on TRAIN theta (eligible players only).
    const trainSkill = [...eligible].map((id) => [id, trainFit.theta.get(id) ?? Number.NEGATIVE_INFINITY] as const)
      .filter(([, t]) => Number.isFinite(t));
    const topIds = trainSkill.sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
    const topSet = new Set(topIds);

    // Ceiling accuracy measured on HOLDOUT answers of the top cohort (no leakage).
    const topHoldout = holdout.filter((a) => topSet.has(a.playerId));
    const topHoldoutCorrect = topHoldout.reduce((s, a) => s + a.correct, 0);
    const topAggregateAccuracyHoldout = topHoldout.length > 0 ? topHoldoutCorrect / topHoldout.length : null;
    // In-sample number for reference.
    const topTrain = train.filter((a) => topSet.has(a.playerId));
    const topAggregateAccuracyInSample = topTrain.length > 0 ? topTrain.reduce((s, a) => s + a.correct, 0) / topTrain.length : null;
    const ceilingBase = topAggregateAccuracyHoldout ?? topAggregateAccuracyInSample;
    if (ceilingBase == null) {
      throw new Error('Ceiling underivable: top cohort has no holdout and no train answers - refusing to emit params');
    }
    if (topAggregateAccuracyHoldout == null) {
      console.warn('WARNING: ceiling measured IN-SAMPLE (no holdout rows for the top cohort) - treat as optimistic');
    }
    const ceilingAccuracy = Math.max(0, ceilingBase - args.marginPp / 100);

    // Speed floor from top-cohort clean-window times.
    const topTimes = await withBatchRetry(() => fetchS1CleanTimesForPlayers(db.query, {
      s1Boundary,
      playerIds: topIds,
      cleanWindowStart: TIMING_CLEAN_WINDOW_START,
    }));
    const topTimesSorted = [...topTimes].sort((a, b) => a - b);
    const speedFloor = topTimesSorted.length > 0
      ? SPEED_FLOOR_PERCENTILES.map((p) => ({ percentile: p, timeMs: Math.round(percentile(topTimesSorted, p)) }))
      : [];
    const topTiming = logNormalTimeStats(topTimes);

    // REFIT on ALL scoped rows for the final theta/beta → f(RP).
    const finalFit: LatentFitResult = fitLatentSkill(scoped, fitOpts);
    if (finalFit.excluded.players.length > 0 || finalFit.excluded.questions.length > 0) {
      console.log(
        `  degenerate params excluded from fit: ${finalFit.excluded.players.length} players, ${finalFit.excluded.questions.length} questions (0%/100% observed — kept in question_stats).`,
      );
    }
    if (!finalFit.converged && !isSmokeRun) {
      // Print the diagnostics dump so the next pathology names itself.
      console.error(
        `Latent-skill fit did NOT converge (updateNorm=${finalFit.finalUpdateNorm.toExponential(2)} after ${finalFit.iters} iters).`,
      );
      if (finalFit.diagnostics && finalFit.diagnostics.length > 0) {
        console.error('  Largest remaining per-parameter updates:');
        for (const d of finalFit.diagnostics) {
          console.error(
            `    ${d.kind} ${d.id}: update=${d.update.toExponential(2)} value=${d.value.toFixed(3)} obsAcc=${(d.observedAccuracy * 100).toFixed(1)}% n=${d.answers}`,
          );
        }
      }
      throw new Error('Refusing to emit params on a non-converged fit.');
    }

    // f(RP): placed profiles ∩ final skill, percentile-anchored.
    const skillByPlayer = new Map([...eligible].map((id) => [id, finalFit.theta.get(id)]).filter((e): e is [string, number] => e[1] != null));
    const joined = profiles.filter((p) => skillByPlayer.has(p.user_id)).map((p) => ({ rp: p.rp, skill: skillByPlayer.get(p.user_id)! }));
    if (joined.length < 2) throw new Error('Too few placed players with a skill estimate for f(RP)');
    const rpsSorted = joined.map((j) => j.rp).sort((a, b) => a - b);
    const skillsSorted = joined.map((j) => j.skill).sort((a, b) => a - b);
    const fCurve = buildFCurve(rpsSorted, skillsSorted, FCURVE_PERCENTILES);

    // question_stats via the SHARED aggregation (single SQL source).
    // Explicit READ ONLY transaction: transaction poolers (Supabase 6543) ignore
    // the default_transaction_read_only startup parameter, so the per-call BEGIN
    // is the guarantee that holds everywhere.
    const agg = await withBatchRetry(() => db.beginReadOnly((tx) =>
      aggregateQuestionStats(tx, { limit: args.limit })
    ));

    // difficultyLink: regress refit beta on logit(smoothed_accuracy), holdout-validated.
    const accByQuestion = new Map<string, number>();
    for (const qs of agg.questionStats) if (qs.smoothedAccuracy != null) accByQuestion.set(qs.questionId, qs.smoothedAccuracy);
    const linkPoints = [...finalFit.beta.entries()]
      .filter(([qid]) => accByQuestion.has(qid))
      .map(([qid, beta]) => ({ x: logit(accByQuestion.get(qid)!), y: beta }));
    // NOTE: beta is difficulty; higher accuracy => lower beta, so slope is negative.
    let difficultyLink = { intercept: 0, slope: 0, holdoutR2: null as number | null, holdoutRmse: null as number | null, nQuestions: linkPoints.length };
    if (linkPoints.length >= 4) {
      const lrng = makeRng(0x51ed270b);
      const ltrain: typeof linkPoints = [];
      const ltest: typeof linkPoints = [];
      for (const p of linkPoints) (lrng() < 0.2 ? ltest : ltrain).push(p);
      const trainPts = ltrain.length >= 2 ? ltrain : linkPoints;
      const holdoutUsable = ltest.length >= 2;
      const testPts = holdoutUsable ? ltest : trainPts;
      const fit = linearFit(trainPts.map((p) => p.x), trainPts.map((p) => p.y));
      let se = 0;
      for (const p of testPts) { const pred = fit.intercept + fit.slope * p.x; se += (pred - p.y) ** 2; }
      difficultyLink = {
        intercept: fit.intercept,
        slope: fit.slope,
        holdoutR2: holdoutUsable ? fit.r2 : null,
        holdoutRmse: holdoutUsable ? Math.sqrt(se / testPts.length) : null,
        nQuestions: linkPoints.length,
      };
    }

    const params: BotModelParams = {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      source: {
        batchId: batch.id,
        seasonNumber: batch.season_number,
        batchCompletedAt: new Date(batch.completed_at as unknown as string | Date).toISOString(),
        isSmokeRun,
      },
      thetaAnchoring: { convention: 'mean-zero-over-fitted-s1-cohort', cohortSize: skillByPlayer.size },
      fCurve,
      difficultyLink,
      ceiling: {
        topCohortSize: topIds.length,
        topAggregateAccuracyHoldout,
        topAggregateAccuracyInSample,
        marginPp: args.marginPp,
        ceilingAccuracy,
        speedFloor,
        topMedianTimeMs: topTiming.medianTimeMs,
        topLogTimeSigma: topTiming.logTimeSigma,
      },
      clamps: {
        finalProbCap: PARAMS_FINAL_PROB_CAP,
        skillCap: PARAMS_SKILL_CAP,
        minAnswerTimeMs: PARAMS_MIN_ANSWER_TIME_MS,
      },
      validation: {
        fitConverged: finalFit.converged,
        fitIters: finalFit.iters,
        finalUpdateNorm: finalFit.finalUpdateNorm,
        holdoutAuc,
      },
    };

    // Schema-validate BEFORE writing anything.
    botModelParamsSchema.parse(params);

    const outDir = resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'params.json'), JSON.stringify(params, null, 2));

    const insertSql = [
      '-- Persistent-bot model params from Season-1 calibration.',
      '-- REVIEW before applying. Inserted inactive; a separate deliberate step activates it.',
      isSmokeRun ? '-- ⚠️ SMOKE RUN (--limit): NOT production-ready.' : '-- Full run.',
      'INSERT INTO public.bot_model_params (params, active, note)',
      `VALUES ('${JSON.stringify(params).replace(/'/g, "''")}'::jsonb, false,`,
      `  'S1 calibration schema v${CALIBRATION_SCHEMA_VERSION} generated ${params.generatedAt}${isSmokeRun ? ' (SMOKE)' : ''}');`,
      '',
    ].join('\n');
    writeFileSync(join(outDir, 'bot_model_params.insert.sql'), insertSql);

    // Accuracy-by-difficulty from the DB (real questions.difficulty buckets).
    const diffRows = await withBatchRetry(() => fetchAccuracyByDifficulty(db.query));
    const diffBuckets = diffRows.map((d) => ({
      difficulty: d.difficulty ?? 'unknown',
      questions: d.answers_count,
      meanSmoothedAccuracy: d.answers_count > 0 ? d.correct_count / d.answers_count : 0,
    }));

    writeReport(join(outDir, 'REPORT.md'), {
      batch,
      s1Boundary,
      isSmokeRun,
      cohort: {
        placedProfiles: profiles.length,
        s1BernoulliAnswers: rawAnswers.length,
        eligiblePlayers: eligible.size,
        minAnswers: args.minAnswers,
        fitTrainRows: train.length,
        holdoutRows: holdout.length,
        joinedForFCurve: joined.length,
      },
      exclusions: agg.exclusions,
      formatDistribution: agg.formatDistribution,
      questionStatsCount: agg.questionStats.length,
      backoffCount: agg.backoffStats.length,
      globalMean: agg.globalMean,
      accuracyByDifficulty: diffBuckets,
      validation: { holdoutAuc, calibration, fitConverged: finalFit.converged, fitIters: finalFit.iters, finalUpdateNorm: finalFit.finalUpdateNorm },
      difficultyLink,
      fCurve,
      ceiling: params.ceiling,
      clamps: params.clamps,
      marginPp: args.marginPp,
    });

    console.log(`Calibration complete. Outputs in ${outDir}`);
    console.log(`  S1 boundary: ${s1Boundary}, placed players: ${profiles.length}, eligible: ${eligible.size}`);
    console.log(`  scoped Bernoulli answers: ${rawAnswers.length}, question_stats rows: ${agg.questionStats.length}`);
    console.log(`  fit converged: ${finalFit.converged} (iters ${finalFit.iters}, updateNorm ${finalFit.finalUpdateNorm.toExponential(2)})`);
    console.log(`  ceiling: holdout ${fmtPct(topAggregateAccuracyHoldout)} / in-sample ${fmtPct(topAggregateAccuracyInSample)} -> ${(ceilingAccuracy * 100).toFixed(1)}% (margin ${args.marginPp}pp)`);
    if (holdoutAuc != null) console.log(`  holdout AUC: ${holdoutAuc.toFixed(3)}`);
    console.log(`  difficultyLink: beta = ${difficultyLink.intercept.toFixed(3)} + ${difficultyLink.slope.toFixed(3)}*logit(acc), holdout R²=${difficultyLink.holdoutR2?.toFixed(3) ?? 'n/a'}`);
  } finally {
    await db.end();
  }
}

function fmtPct(x: number | null): string {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error('Calibration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
