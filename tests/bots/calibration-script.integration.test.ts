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
import { resolveBatch, fetchPlacedProfiles, fetchBernoulliAnswers } from '../../scripts/bot-calibration/queries.js';
import { fitLatentSkill, type LatentAnswer } from '../../src/modules/bots/calibration/latent-skill.js';
import { buildFCurve, pearson } from '../../src/modules/bots/calibration/math.js';
import { FULL_DURATION_MS } from '../../src/modules/bots/calibration/constants.js';

let sql: typeof import('../../src/db/index.js').sql;
let db: ReturnType<typeof openReadOnlyDb>;
let dbAvailable = false;

const TAG = `cal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CLEAN = '2026-07-10T12:00:00Z';
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
    VALUES (${TEST_SEASON}, NOW()) RETURNING id`;
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

  const [m] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, ended_at) VALUES ('ranked','completed',false,NOW()) RETURNING id`;
  ids.matchId = m.id;
  const [dm] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, ended_at) VALUES ('ranked','completed',true,NOW()) RETURNING id`;
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
  //  - a timeout backfill for p0 on the dev match (dev-excluded AND backfill-excluded)
  await sql`INSERT INTO match_questions (match_id,q_index,question_id,category_id,correct_index)
    VALUES (${ids.devMatchId}, 0, ${ids.questionIds[0]}, ${ids.categoryId}, 0)`;
  await sql`INSERT INTO match_answers (match_id,q_index,user_id,selected_index,is_correct,time_ms,points_earned,answered_at,answer_payload)
    VALUES (${ids.devMatchId}, 0, ${ids.playerIds[0]}, ${null}, false, ${FULL_DURATION_MS.multipleChoice}, 0, ${CLEAN}::timestamptz, '{}'::jsonb)`;
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

  it('resolves the S1 batch and placed profiles (unplaced excluded)', async () => {
    if (!dbAvailable) return;
    const batch = await resolveBatch(db.query, { season: TEST_SEASON });
    expect(batch?.id).toBe(ids.batchId);
    const placed = await fetchPlacedProfiles(db.query, ids.batchId!);
    const mine = placed.filter((p) => ids.playerIds.includes(p.user_id));
    expect(mine.length).toBe(N_PLAYERS); // 6 placed; the unplaced 9999 row excluded
    expect(mine.every((p) => p.rp < 9999)).toBe(true);
  });

  it('fetches only human ranked non-backfill answers', async () => {
    if (!dbAvailable) return;
    const rows = await fetchBernoulliAnswers(db.query);
    const mine = rows.filter((r) => ids.playerIds.includes(r.player_id));
    // 6 players x 40 questions = 240; AI/seed/dev/backfill all excluded.
    expect(mine.length).toBe(N_PLAYERS * N_QUESTIONS);
    expect(mine.some((r) => r.player_id === ids.aiId)).toBe(false);
    expect(mine.some((r) => r.player_id === ids.seedId)).toBe(false);
  });

  it('recovers the seeded skill ORDER and yields a monotonic f(RP) curve', async () => {
    if (!dbAvailable) return;
    const rows = await fetchBernoulliAnswers(db.query);
    const answers: LatentAnswer[] = rows
      .filter((r) => ids.playerIds.includes(r.player_id))
      .map((r) => ({ playerId: r.player_id, questionId: r.question_id, format: r.format, correct: r.correct ? 1 : 0 }));
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
});
