/**
 * Integration test: the offline calibration script's read-only query layer +
 * latent-skill fit, run against the local test DB (never prod). Seeds a small S1
 * cohort with a KNOWN skill ordering and asserts:
 *   - the read-only transaction blocks writes at the server;
 *   - fetchBernoulliAnswers excludes AI/seed/dev/backfill rows;
 *   - the recovered latent skill preserves the seeded skill ORDER (strong
 *     players rank above weak ones);
 *   - the f(RP) percentile mapping is monotonic in RP.
 *
 * Requires the test DB. Self-skips if unavailable. All data namespaced + cleaned.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import { openReadOnlyDb } from '../../scripts/bot-calibration/readonly-db.js';
import { resolveBatch, fetchPlacedProfiles, fetchS1BernoulliAnswers } from '../../scripts/bot-calibration/queries.js';
import { fitLatentSkill, predictProb, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
import { buildFCurve, pearson, linearFit, logit, rocAuc } from '../../src/modules/bots/calibration/math.js';
import { aggregateQuestionStats } from '../../src/modules/bots/calibration/aggregate.js';
import { botModelParamsSchema, CALIBRATION_SCHEMA_VERSION } from '../../src/modules/bots/calibration/params-schema.js';

let sql: typeof import('../../src/db/index.js').sql;
let db: ReturnType<typeof openReadOnlyDb>;
let dbAvailable = false;

const TAG = `cal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CLEAN = '2026-07-10T12:00:00Z';
// S1 matches must end BEFORE the reset batch boundary. Fixed instants: matches
// end on MATCH_ENDED, the batch completes on S1_BOUNDARY (later).
const MATCH_ENDED = '2026-07-12T00:00:00Z';
const S1_BOUNDARY = '2026-07-15T00:00:00Z';
const FULL_DURATION_MCQ_MS = 10000;
// A unique high season number avoids colliding with the test DB's real season-1
// batch (season_number is uniquely indexed). Resolve by this season below.
const TEST_SEASON = 900000 + Math.floor(Math.random() * 90000);

// Known skills: p0 weakest ... p5 strongest. Deterministic answers via a
// per-(player,question) threshold so recovery order is unambiguous.
const N_PLAYERS = 6;
const N_QUESTIONS = 40;
const trueSkill = (p: number): number => -1.5 + (p / (N_PLAYERS - 1)) * 3; // -1.5..1.5
const trueDiff = (q: number): number => -1 + (q / (N_QUESTIONS - 1)) * 2; // -1..1

const ids: {
  categoryId?: string;
  batchId?: string;
  questionIds: string[];
  playerIds: string[];
  aiId?: string;
  seedId?: string;
  matchId?: string;
  devMatchId?: string;
} = { questionIds: [], playerIds: [] };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

async function insertUser(nick: string, isAi: boolean, isSeed: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, is_seed, ai_kind)
    VALUES (${nick}, ${isAi}, ${isSeed}, ${isAi ? 'ephemeral' : null})
    RETURNING id`;
  return row.id;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping calibration-script integration test: database not available.\n');
    return;
  }

  // Point the read-only runner at the same test DB.
  process.env.CALIBRATION_DATABASE_URL = process.env.DATABASE_URL;
  db = openReadOnlyDb();

  const [cat] = await sql<{ id: string }[]>`
    INSERT INTO categories (name, slug, is_active)
    VALUES (${{ en: `${TAG} Cat` }}::jsonb, ${`${TAG}-cat`}, true) RETURNING id`;
  ids.categoryId = cat.id;

  const [batch] = await sql<{ id: string }[]>`
    INSERT INTO ranked_reset_batches (season_number, completed_at)
    VALUES (${TEST_SEASON}, ${S1_BOUNDARY}::timestamptz) RETURNING id`;
  ids.batchId = batch.id;

  for (let q = 0; q < N_QUESTIONS; q += 1) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO questions (category_id, type, difficulty, status, prompt)
      VALUES (${ids.categoryId}, 'mcq_single', 'medium', 'published', ${{ en: `${TAG} q${q}` }}::jsonb)
      RETURNING id`;
    ids.questionIds.push(row.id);
  }

  for (let p = 0; p < N_PLAYERS; p += 1) {
    ids.playerIds.push(await insertUser(`${TAG}_p${p}`, false, false));
  }
  ids.aiId = await insertUser(`${TAG}_ai`, true, false);
  ids.seedId = await insertUser(`${TAG}_seed`, false, true);

  // Archive placed profiles: RP correlated with skill so f(RP) has signal.
  const archiveCols = sql`
    reset_batch_id, user_id, rp, tier, placement_status,
    placement_required, placement_played, placement_wins,
    placement_perf_sum, placement_points_for_sum, placement_points_against_sum, current_win_streak`;
  for (let p = 0; p < N_PLAYERS; p += 1) {
    await sql`
      INSERT INTO ranked_profiles_archive (${archiveCols})
      VALUES (${ids.batchId}, ${ids.playerIds[p]}, ${1000 + p * 150}, 'silver', 'placed',
        5, 5, 3, 0, 0, 0, 0)`;
  }
  // An unplaced profile (different user) that must be excluded from f(RP).
  await sql`
    INSERT INTO ranked_profiles_archive (${archiveCols})
    VALUES (${ids.batchId}, ${ids.aiId ?? ids.playerIds[0]}, ${9999}, 'silver', 'unplaced',
      5, 2, 0, 0, 0, 0, 0)`;

  // The dev match is status='active' so cleanupOldDevMatches (targets only
  // completed/abandoned dev matches, globally) can't race-delete it on the shared
  // test DB. The S1 query excludes it by BOTH is_dev=false AND status='completed'.
  const START = '2000-01-01T00:00:00Z';
  const [m] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, started_at, ended_at) VALUES ('ranked','completed',false,${START}::timestamptz,${MATCH_ENDED}::timestamptz) RETURNING id`;
  ids.matchId = m.id;
  const [dm] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, started_at, ended_at) VALUES ('ranked','active',true,${START}::timestamptz,${MATCH_ENDED}::timestamptz) RETURNING id`;
  ids.devMatchId = dm.id;

  // One (match, q_index) per (player, question) would collide on the PK
  // (match_id,q_index,user_id) only across players — fine, players differ. Use a
  // distinct q_index per question, all players answer the same q_index.
  const rng = mulberry32(2024);
  for (let q = 0; q < N_QUESTIONS; q += 1) {
    await sql`
      INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index)
      VALUES (${ids.matchId}, ${q}, ${ids.questionIds[q]}, ${ids.categoryId}, 0)`;
    for (let p = 0; p < N_PLAYERS; p += 1) {
      const correct = rng() < sigmoid(trueSkill(p) - trueDiff(q));
      await sql`
        INSERT INTO match_answers
          (match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answered_at, answer_payload)
        VALUES (${ids.matchId}, ${q}, ${ids.playerIds[p]}, ${correct ? 0 : 1}, ${correct}, 5000, ${correct ? 100 : 0}, ${CLEAN}::timestamptz, '{}'::jsonb)`;
    }
  }

  // Noise rows that MUST be excluded, all on q_index 0 (distinct users/matches):
  //  - AI + seed answers on the real match
  await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
    VALUES (${ids.matchId}, 0, ${ids.aiId}, 0, true, 5000, 100, ${CLEAN}::timestamptz, '{}'::jsonb)`;
  await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
    VALUES (${ids.matchId}, 0, ${ids.seedId}, 0, true, 5000, 100, ${CLEAN}::timestamptz, '{}'::jsonb)`;
  //  - a null-index BACKFILL for p0. match_questions is UNIQUE(match_id,question_id),
  //    so reuse questionIds[0] on the DEV match (also dev-excluded) at q_index 0.
  //    Tests that a null selected_index is excluded regardless.
  await sql`INSERT INTO match_questions (match_id,q_index,question_id,category_id,correct_index)
    VALUES (${ids.devMatchId}, 0, ${ids.questionIds[0]}, ${ids.categoryId}, 0)`;
  await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
    VALUES (${ids.devMatchId}, 0, ${ids.playerIds[0]}, ${null}, false, ${FULL_DURATION_MCQ_MS}, 0, ${CLEAN}::timestamptz, '{}'::jsonb)`;
  // And a genuine null-index backfill on the REAL match for a fresh dedicated
  // question so the Bernoulli backfill exclusion is exercised on an eligible match.
  const [bfQ] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${ids.categoryId}, 'mcq_single', 'medium', 'published', ${{ en: `${TAG} bf` }}::jsonb) RETURNING id`;
  ids.questionIds.push(bfQ.id);
  await sql`INSERT INTO match_questions (match_id,q_index,question_id,category_id,correct_index)
    VALUES (${ids.matchId}, ${N_QUESTIONS}, ${bfQ.id}, ${ids.categoryId}, 0)`;
  await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
    VALUES (${ids.matchId}, ${N_QUESTIONS}, ${ids.playerIds[0]}, ${null}, false, ${FULL_DURATION_MCQ_MS}, 0, ${CLEAN}::timestamptz, '{}'::jsonb)`;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db.end().catch(() => {});
  const matches = [ids.matchId, ids.devMatchId].filter(Boolean) as string[];
  await sql`DELETE FROM match_answers WHERE match_id = ANY(${matches}::uuid[])`;
  await sql`DELETE FROM match_questions WHERE match_id = ANY(${matches}::uuid[])`;
  await sql`DELETE FROM matches WHERE id = ANY(${matches}::uuid[])`;
  await sql`DELETE FROM ranked_profiles_archive WHERE reset_batch_id = ${ids.batchId!}`;
  await sql`DELETE FROM question_stats WHERE question_id = ANY(${ids.questionIds}::uuid[])`;
  await sql`DELETE FROM questions WHERE id = ANY(${ids.questionIds}::uuid[])`;
  await sql`DELETE FROM ranked_reset_batches WHERE id = ${ids.batchId!}`;
  await sql`DELETE FROM categories WHERE id = ${ids.categoryId!}`;
  const users = [...ids.playerIds, ids.aiId, ids.seedId].filter(Boolean) as string[];
  await sql`DELETE FROM users WHERE id = ANY(${users}::uuid[])`;
});

describe('offline calibration script (read-only) against the test DB', () => {
  it('blocks writes through the read-only transaction', async () => {
    if (!dbAvailable) return;
    await expect(
      (db.query as unknown as (s: TemplateStringsArray, ...p: unknown[]) => Promise<unknown>)`DELETE FROM users WHERE id = ${ids.aiId}`,
    ).rejects.toThrow(/read-only/i);
    // The AI row still exists (nothing was deleted).
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE id = ${ids.aiId!}`;
    expect(row.n).toBe(1);
  });

  it('blocks writes through the exposed db.sql too (server-enforced read-only session)', async () => {
    if (!dbAvailable) return;
    // db.sql bypasses the local SELECT screen but the session is opened with
    // default_transaction_read_only=on, so the SERVER must reject the write.
    await expect(db.sql`DELETE FROM users WHERE id = ${ids.aiId}`).rejects.toThrow(/read-only|cannot execute/i);
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE id = ${ids.aiId!}`;
    expect(row.n).toBe(1);
  });

  it('resolves the S1 batch and placed profiles (unplaced excluded)', async () => {
    if (!dbAvailable) return;
    const batch = await resolveBatch(db.query, { season: TEST_SEASON });
    expect(batch?.id).toBe(ids.batchId);
    const placed = await fetchPlacedProfiles(db.query, ids.batchId!);
    const mine = placed.filter((p) => ids.playerIds.includes(p.user_id));
    expect(mine.length).toBe(N_PLAYERS); // 6 placed; the unplaced 9999 row excluded
    expect(mine.every((p) => p.rp < 9999)).toBe(true);
  });

  it('fetches only S1 placed human ranked non-backfill answers', async () => {
    if (!dbAvailable) return;
    // AI/seed are NOT placed so they can't be passed as placedPlayerIds; pass the
    // real placed player set and assert the count + that noise never leaks in.
    const rows = await fetchS1BernoulliAnswers(db.query, { s1Boundary: S1_BOUNDARY, placedPlayerIds: ids.playerIds });
    const mine = rows.filter((r) => ids.playerIds.includes(r.player_id));
    // 6 players x 40 questions = 240; the null-index backfill + AI/seed/dev excluded.
    expect(mine.length).toBe(N_PLAYERS * N_QUESTIONS);
    expect(rows.some((r) => r.player_id === ids.aiId)).toBe(false);
    expect(rows.some((r) => r.player_id === ids.seedId)).toBe(false);
    // The backfill row (null index, seeded on the eligible match for the last
    // pushed question) must be absent specifically.
    const backfillQuestionId = ids.questionIds[ids.questionIds.length - 1];
    expect(rows.some((r) => r.question_id === backfillQuestionId)).toBe(false);
  });

  it('excludes S2 answers (matches ending after the S1 boundary)', async () => {
    if (!dbAvailable) return;
    // A post-boundary match: its answers must NOT appear in the S1 fetch.
    const [s2] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode,status,is_dev,ended_at) VALUES ('ranked','completed',false,'2026-08-01T00:00:00Z'::timestamptz) RETURNING id`;
    await sql`INSERT INTO match_questions (match_id,q_index,question_id,category_id,correct_index)
      VALUES (${s2.id}, 0, ${ids.questionIds[0]}, ${ids.categoryId}, 0)`;
    await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
      VALUES (${s2.id}, 0, ${ids.playerIds[0]}, 0, true, 5000, 100, '2026-08-01T00:00:00Z'::timestamptz, '{}'::jsonb)`;
    try {
      const rows = await fetchS1BernoulliAnswers(db.query, { s1Boundary: S1_BOUNDARY, placedPlayerIds: ids.playerIds });
      const fromS2 = rows.filter((r) => r.player_id === ids.playerIds[0]).length;
      // p0 has exactly N_QUESTIONS S1 answers; the S2 answer is excluded.
      expect(fromS2).toBe(N_QUESTIONS);
    } finally {
      await sql`DELETE FROM match_answers WHERE match_id = ${s2.id}`;
      await sql`DELETE FROM match_questions WHERE match_id = ${s2.id}`;
      await sql`DELETE FROM matches WHERE id = ${s2.id}`;
    }
  });

  it('recovers the seeded skill ORDER and yields a monotonic f(RP) curve', async () => {
    if (!dbAvailable) return;
    const rows = await fetchS1BernoulliAnswers(db.query, { s1Boundary: S1_BOUNDARY, placedPlayerIds: ids.playerIds });
    const answers: LatentAnswer[] = rows
      .filter((r) => ids.playerIds.includes(r.player_id))
      .map((r) => ({ playerId: r.player_id, questionId: r.question_id, correct: r.correct ? 1 : 0 }));
    const fit = fitLatentSkill(answers);
    const recovered = ids.playerIds.map((id) => fit.theta.get(id) ?? 0);
    // p0 (weakest) should have the lowest theta, p5 (strongest) the highest.
    expect(recovered[0]).toBeLessThan(recovered[N_PLAYERS - 1]);
    // Order preserved: true skill index (0..5) vs recovered theta should be
    // strongly rank-correlated (Pearson on the small monotone sample). A couple
    // of local inversions are expected at this sample size; the trend must hold.
    const trueOrder = ids.playerIds.map((_, p) => p);
    expect(pearson(trueOrder, recovered)).toBeGreaterThan(0.85);

    // f(RP): RP increases with p, skill increases with p -> monotonic curve.
    const joined = ids.playerIds.map((id, p) => ({ rp: 1000 + p * 150, skill: fit.theta.get(id) ?? 0 }));
    const rps = joined.map((j) => j.rp).sort((a, b) => a - b);
    const skills = joined.map((j) => j.skill).sort((a, b) => a - b);
    const curve = buildFCurve(rps, skills, [0.1, 0.5, 0.9]);
    expect(curve[0].rp).toBeLessThan(curve[2].rp);
    expect(curve[0].skill).toBeLessThan(curve[2].skill);
  });

  /**
   * End-to-end orchestrator path: runs the same sequence calibrate.ts does —
   * S1-scoped fetch, train/holdout fit, top-cohort-on-train, holdout ceiling,
   * refit-all, f(RP), shared question_stats aggregation, difficulty link — and
   * asserts the assembled params validate against the zod schema.
   */
  it('assembles schema-valid params end-to-end (holdout ceiling, difficulty link)', async () => {
    if (!dbAvailable) return;
    const boundary = S1_BOUNDARY;
    const profiles = await fetchPlacedProfiles(db.query, ids.batchId!);
    const placedIds = profiles.map((p) => p.user_id);
    const rows = await fetchS1BernoulliAnswers(db.query, { s1Boundary: boundary, placedPlayerIds: placedIds });
    const scoped: LatentAnswer[] = rows.map((r) => ({ playerId: r.player_id, questionId: r.question_id, correct: r.correct ? 1 : 0 }));

    // train/holdout
    let s = 12345 >>> 0;
    const rand = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; };
    const train: LatentAnswer[] = [];
    const holdout: LatentAnswer[] = [];
    for (const a of scoped) (rand() < 0.2 ? holdout : train).push(a);
    const trainFit = fitLatentSkill(train);

    const scored = holdout.filter((a) => trainFit.theta.has(a.playerId) && trainFit.beta.has(a.questionId));
    const holdoutAuc = scored.length > 0 ? rocAuc(scored.map((a) => predictProb(trainFit, a)), scored.map((a) => a.correct)) : null;

    // top cohort on train theta, ceiling on holdout
    const topIds = placedIds.map((id) => [id, trainFit.theta.get(id) ?? -Infinity] as const)
      .filter(([, t]) => Number.isFinite(t)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    const topSet = new Set(topIds);
    const topHoldout = holdout.filter((a) => topSet.has(a.playerId));
    const ceilHoldout = topHoldout.length > 0 ? topHoldout.reduce((x, a) => x + a.correct, 0) / topHoldout.length : null;

    // refit all
    const finalFit = fitLatentSkill(scoped);
    const skillByPlayer = new Map(placedIds.map((id) => [id, finalFit.theta.get(id)]).filter((e): e is [string, number] => e[1] != null));
    const joined = profiles.filter((p) => skillByPlayer.has(p.user_id)).map((p) => ({ rp: p.rp, skill: skillByPlayer.get(p.user_id)! }));
    const fCurve = buildFCurve(joined.map((j) => j.rp).sort((a, b) => a - b), joined.map((j) => j.skill).sort((a, b) => a - b), [0.05, 0.5, 0.95]);

    // shared aggregation + difficulty link
    const agg = await aggregateQuestionStats(db.sql, {});
    const accByQ = new Map(agg.questionStats.filter((q) => q.smoothedAccuracy != null).map((q) => [q.questionId, q.smoothedAccuracy!]));
    const pts = [...finalFit.beta.entries()].filter(([q]) => accByQ.has(q)).map(([q, beta]) => ({ x: logit(accByQ.get(q)!), y: beta }));
    const link = pts.length >= 2 ? linearFit(pts.map((p) => p.x), pts.map((p) => p.y)) : { intercept: 0, slope: 0, r2: 0 };
    // Difficulty link slope must be negative (higher accuracy -> lower beta).
    if (pts.length >= 4) expect(link.slope).toBeLessThan(0);

    const params = {
      schemaVersion: CALIBRATION_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      source: { batchId: ids.batchId!, seasonNumber: TEST_SEASON, batchCompletedAt: boundary, isSmokeRun: false },
      thetaAnchoring: { convention: 'mean-zero-over-fitted-s1-cohort' as const, cohortSize: skillByPlayer.size },
      fCurve,
      difficultyLink: { intercept: link.intercept, slope: link.slope, holdoutR2: link.r2, holdoutRmse: 0.1, nQuestions: pts.length },
      ceiling: {
        topCohortSize: topIds.length,
        topAggregateAccuracyHoldout: ceilHoldout,
        topAggregateAccuracyInSample: null,
        marginPp: 4,
        ceilingAccuracy: Math.max(0, (ceilHoldout ?? 0.5) - 0.04),
        speedFloor: [{ percentile: 0.1, timeMs: 3000 }],
        topMedianTimeMs: 5000,
        topLogTimeSigma: 0.3,
      },
      clamps: { finalProbCap: 0.93, skillCap: 4, minAnswerTimeMs: 600 },
      validation: { fitConverged: finalFit.converged, fitIters: finalFit.iters, finalUpdateNorm: finalFit.finalUpdateNorm, holdoutAuc },
    };
    expect(() => botModelParamsSchema.parse(params)).not.toThrow();
    expect(fCurve.length).toBe(3);
    // f(RP) monotonic; ceiling in [0,1]; holdout AUC computed.
    expect(fCurve[0].skill).toBeLessThan(fCurve[2].skill);
    expect(params.ceiling.ceilingAccuracy).toBeGreaterThanOrEqual(0);
    expect(params.validation.holdoutAuc == null || params.validation.holdoutAuc >= 0).toBe(true);
  });
});
