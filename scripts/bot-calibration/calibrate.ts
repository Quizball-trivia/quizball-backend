#!/usr/bin/env npx tsx
/**
 * Offline Season-1 calibration (persistent-bot roster, PR4 deliverable A).
 *
 * PROD READ-ONLY. Connects ONLY via CALIBRATION_DATABASE_URL, runs every query
 * inside a READ ONLY transaction, screens every statement as SELECT-only, and
 * writes NOTHING to the database. Outputs go to a local directory:
 *   - params.json                 (matches bot_model_params.params)
 *   - bot_model_params.insert.sql (an INSERT for human review — NOT applied)
 *   - REPORT.md                   (cohorts, exclusions, curves, validation,
 *                                  and the FROZEN Layer-1 ceiling constants)
 *
 * Usage (a human runs this, pointing CALIBRATION_DATABASE_URL at the prod
 * pooler; develop/test against the local test DB):
 *   CALIBRATION_DATABASE_URL=postgres://... npm run bot:calibrate -- \
 *     --season 1 --min-answers 100 --margin-pp 4 --out scripts/bot-calibration/out
 *   Flags: --season N | --batch-id UUID, --min-answers N, --margin-pp N,
 *          --limit N (cap answers scanned for a smoke run), --out DIR
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });
loadEnv();

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openReadOnlyDb } from './readonly-db.js';
import { resolveBatch, fetchPlacedProfiles, fetchBernoulliAnswers, fetchCleanTimesForPlayers } from './queries.js';
import { fitLatentSkill, predictProb, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
import { buildFCurve, percentile, pearson, rocAuc, calibrationCurve, logNormalTimeStats } from '../../src/modules/bots/calibration/math.js';
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
  const seasonRaw = get('--season');
  const minRaw = get('--min-answers');
  const marginRaw = get('--margin-pp');
  const limitRaw = get('--limit');
  return {
    season: seasonRaw != null ? Number(seasonRaw) : undefined,
    batchId: get('--batch-id'),
    minAnswers: minRaw != null ? Number(minRaw) : 100,
    marginPp: marginRaw != null ? Number(marginRaw) : 4,
    limit: limitRaw != null ? Number(limitRaw) : undefined,
    out: get('--out') ?? 'scripts/bot-calibration/out',
  };
}

const FCURVE_PERCENTILES = [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95];
const SPEED_FLOOR_PERCENTILES = [0.1, 0.25, 0.5];
const PARAMS_VERSION_TAG = 's1-calibration-v1';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openReadOnlyDb();
  try {
    const batch = await resolveBatch(db.query, { batchId: args.batchId, season: args.season });
    if (!batch) throw new Error('No matching ranked_reset_batches row (check --season / --batch-id)');

    const profiles = await fetchPlacedProfiles(db.query, batch.id);
    const rawAnswers = await fetchBernoulliAnswers(db.query, { limit: args.limit });

    // Latent-skill fit: keep only players with >= minAnswers Bernoulli answers.
    const byPlayer = new Map<string, LatentAnswer[]>();
    for (const r of rawAnswers) {
      const a: LatentAnswer = {
        playerId: r.player_id,
        questionId: r.question_id,
        format: r.format,
        correct: r.correct ? 1 : 0,
      };
      const list = byPlayer.get(a.playerId) ?? [];
      list.push(a);
      byPlayer.set(a.playerId, list);
    }
    const eligiblePlayers = new Set(
      [...byPlayer.entries()].filter(([, list]) => list.length >= args.minAnswers).map(([id]) => id),
    );
    const fitAnswers = rawAnswers
      .filter((r) => eligiblePlayers.has(r.player_id))
      .map((r): LatentAnswer => ({ playerId: r.player_id, questionId: r.question_id, format: r.format, correct: r.correct ? 1 : 0 }));

    if (fitAnswers.length === 0) throw new Error('No players meet --min-answers; widen the threshold or check data');

    // Holdout split for validation (random 80/20).
    const train: LatentAnswer[] = [];
    const holdout: LatentAnswer[] = [];
    let seed = 0x2545f491;
    const rand = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 100000) / 100000;
    };
    for (const a of fitAnswers) (rand() < 0.2 ? holdout : train).push(a);

    const fit = fitLatentSkill(train);

    // Validation on holdout rows whose player+question were in train.
    const scored = holdout.filter((a) => fit.theta.has(a.playerId) && fit.beta.has(a.questionId));
    const preds = scored.map((a) => predictProb(fit, a));
    const labels = scored.map((a) => a.correct);
    const auc = scored.length > 0 ? rocAuc(preds, labels) : null;
    const calibration = scored.length > 0 ? calibrationCurve(preds, labels, 10) : [];

    // Per-player skill (theta) on the fixed S1 scale, restricted to eligible players.
    const skillByPlayer = new Map<string, number>();
    for (const id of eligiblePlayers) {
      const t = fit.theta.get(id);
      if (t != null) skillByPlayer.set(id, t);
    }

    // f(RP): anchor RP percentiles (placed S1 profiles) to skill percentiles.
    // Use only players present in BOTH the placed-profile set and the skill fit.
    const joined = profiles
      .filter((p) => skillByPlayer.has(p.user_id))
      .map((p) => ({ rp: p.rp, skill: skillByPlayer.get(p.user_id)! }));
    const rpsSorted = joined.map((j) => j.rp).sort((a, b) => a - b);
    const skillsSorted = joined.map((j) => j.skill).sort((a, b) => a - b);
    const fCurve = joined.length > 1 ? buildFCurve(rpsSorted, skillsSorted, FCURVE_PERCENTILES) : [];

    // Top cohort: top-10 eligible players by latent skill.
    const rankedBySkill = [...skillByPlayer.entries()].sort((a, b) => b[1] - a[1]);
    const topIds = rankedBySkill.slice(0, 10).map(([id]) => id);
    const topSet = new Set(topIds);
    const topAnswers = fitAnswers.filter((a) => topSet.has(a.playerId));
    const topCorrect = topAnswers.reduce((s, a) => s + a.correct, 0);
    const topAggregateAccuracy = topAnswers.length > 0 ? topCorrect / topAnswers.length : 0;
    const ceilingAccuracy = Math.max(0, topAggregateAccuracy - args.marginPp / 100);

    const topTimes = await fetchCleanTimesForPlayers(db.query, topIds);
    const topTimesSorted = [...topTimes].sort((a, b) => a - b);
    const speedFloor = topTimesSorted.length > 0
      ? SPEED_FLOOR_PERCENTILES.map((p) => ({ percentile: p, timeMs: Math.round(percentile(topTimesSorted, p)) }))
      : [];
    const topTiming = logNormalTimeStats(topTimes);

    // Recovery diagnostic: train-set self-consistency (predicted vs observed
    // per-player accuracy) — a sanity signal, not a formal recovery test.
    const trainByPlayer = new Map<string, { pred: number; obs: number; n: number }>();
    for (const a of train) {
      if (!fit.theta.has(a.playerId) || !fit.beta.has(a.questionId)) continue;
      const cur = trainByPlayer.get(a.playerId) ?? { pred: 0, obs: 0, n: 0 };
      cur.pred += predictProb(fit, a);
      cur.obs += a.correct;
      cur.n += 1;
      trainByPlayer.set(a.playerId, cur);
    }
    const selfPred: number[] = [];
    const selfObs: number[] = [];
    for (const v of trainByPlayer.values()) {
      if (v.n >= 20) {
        selfPred.push(v.pred / v.n);
        selfObs.push(v.obs / v.n);
      }
    }
    const selfConsistencyR = selfPred.length > 2 ? pearson(selfObs, selfPred) : null;

    const params = {
      versionTag: PARAMS_VERSION_TAG,
      generatedAt: new Date().toISOString(),
      source: {
        batchId: batch.id,
        seasonNumber: batch.season_number,
        batchCompletedAt: batch.completed_at,
      },
      fCurve,
      ceiling: {
        topCohortSize: topIds.length,
        topAggregateAccuracy,
        marginPp: args.marginPp,
        ceilingAccuracy,
        speedFloor,
        topMedianTimeMs: topTiming.medianTimeMs,
        topLogTimeSigma: topTiming.logTimeSigma,
      },
      formatOffsets: Object.fromEntries(fit.gamma),
      referenceFormat: fit.referenceFormat,
    };

    const outDir = resolve(args.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'params.json'), JSON.stringify(params, null, 2));

    const insertSql = [
      '-- Persistent-bot model params from Season-1 calibration.',
      '-- REVIEW before applying. Inserted inactive; a separate deliberate step',
      '-- activates it (bot_model_params has a single-active unique index).',
      'INSERT INTO public.bot_model_params (params, active, note)',
      `VALUES ('${JSON.stringify(params).replace(/'/g, "''")}'::jsonb, false,`,
      `  '${PARAMS_VERSION_TAG} generated ${params.generatedAt}');`,
      '',
    ].join('\n');
    writeFileSync(join(outDir, 'bot_model_params.insert.sql'), insertSql);

    writeReport(join(outDir, 'REPORT.md'), {
      batch,
      cohort: {
        placedProfiles: profiles.length,
        answersScanned: rawAnswers.length,
        eligiblePlayers: eligiblePlayers.size,
        minAnswers: args.minAnswers,
        fitTrainRows: train.length,
        holdoutRows: holdout.length,
        joinedForFCurve: joined.length,
      },
      validation: { auc, calibration, selfConsistencyR, fitConverged: fit.converged, fitIters: fit.iters },
      fCurve,
      ceiling: params.ceiling,
      formatOffsets: params.formatOffsets,
      referenceFormat: fit.referenceFormat,
      marginPp: args.marginPp,
      limit: args.limit,
    });

    console.log(`Calibration complete. Outputs in ${outDir}`);
    console.log(`  eligible players: ${eligiblePlayers.size}, f-curve knots: ${fCurve.length}`);
    console.log(`  top-cohort accuracy: ${(topAggregateAccuracy * 100).toFixed(1)}% -> ceiling ${(ceilingAccuracy * 100).toFixed(1)}% (margin ${args.marginPp}pp)`);
    if (auc != null) console.log(`  holdout AUC: ${auc.toFixed(3)}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
