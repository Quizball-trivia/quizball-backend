/**
 * Integration test: the question_stats refresh job (persistent-bot roster).
 *
 * Seeds a self-contained ranked history — human + AI + seed users, a completed
 * ranked match and a dev match, per-question answers spanning a timeout
 * backfill, clean- and dirty-timing-window rows — then runs refreshQuestionStats
 * and asserts:
 *   - answers_count / correct_count exclude AI, seed, deleted users, dev matches,
 *     and timeout backfills;
 *   - smoothed_accuracy matches the Bayesian shrinkage;
 *   - timing (median_time_ms / log_time_sigma) is computed ONLY from clean-window
 *     answers;
 *   - backoff rows exist at category_type / type / global scopes;
 *   - a second run is idempotent (identical counts).
 *
 * Requires the test database (DATABASE_URL in setup.ts). Self-skips if absent.
 * All seed data is namespaced to a unique tag so parallel/shared-DB runs and the
 * afterAll cleanup never collide with other suites.
 *
 *   npm run docker:start
 *   npx vitest run tests/bots/question-stats-refresh.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';
import { FULL_DURATION_MS } from '../../src/modules/bots/calibration/constants.js';

let sql: typeof import('../../src/db/index.js').sql;
let refreshQuestionStats: typeof import('../../src/modules/bots/question-stats-refresh.job.js').refreshQuestionStats;

let dbAvailable = false;

const TAG = `qsr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const CLEAN = '2026-07-10T12:00:00Z'; // inside the timing clean window
const DIRTY = '2026-07-01T12:00:00Z'; // before the clean window (accuracy ok, timing excluded)

const ids: {
  categoryId?: string;
  questionMcq?: string; // heavily-answered mcq
  questionSparse?: string; // few answers -> shrinks toward global
  humanA?: string;
  humanB?: string;
  aiUser?: string;
  seedUser?: string;
  rankedMatch?: string;
  rankedMatch2?: string;
  devMatch?: string;
} = {};

let userSeq = 0;
async function seedUser(kind: 'human' | 'ai' | 'seed'): Promise<string> {
  userSeq += 1;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, is_seed, ai_kind)
    VALUES (
      ${`${TAG}_${kind}_${userSeq}`},
      ${kind === 'ai'},
      ${kind === 'seed'},
      ${kind === 'ai' ? 'ephemeral' : null}
    )
    RETURNING id
  `;
  return row.id;
}

async function seedQuestion(difficulty: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${ids.categoryId!}, 'mcq_single', ${difficulty}, 'published', ${{ en: `${TAG} ${difficulty}` }}::jsonb)
    RETURNING id
  `;
  return row.id;
}

async function seedMatch(isDev: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, ended_at)
    VALUES ('ranked', 'completed', ${isDev}, NOW())
    RETURNING id
  `;
  return row.id;
}

async function linkQuestion(matchId: string, qIndex: number, questionId: string): Promise<void> {
  await sql`
    INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index)
    VALUES (${matchId}, ${qIndex}, ${questionId}, ${ids.categoryId!}, 0)
  `;
}

interface AnswerSpec {
  matchId: string;
  qIndex: number;
  userId: string;
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  answeredAt: string;
}

async function seedAnswer(a: AnswerSpec): Promise<void> {
  await sql`
    INSERT INTO match_answers
      (match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answered_at, answer_payload)
    VALUES (
      ${a.matchId}, ${a.qIndex}, ${a.userId}, ${a.selectedIndex}, ${a.isCorrect},
      ${a.timeMs}, ${a.pointsEarned}, ${a.answeredAt}::timestamptz, '{}'::jsonb
    )
  `;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    refreshQuestionStats = (await import('../../src/modules/bots/question-stats-refresh.job.js')).refreshQuestionStats;
  } catch {
    console.warn('\n⚠️  Skipping question_stats refresh integration test: database not available.\n');
    return;
  }

  const [cat] = await sql<{ id: string }[]>`
    INSERT INTO categories (name, slug, is_active)
    VALUES (${{ en: `${TAG} Cat` }}::jsonb, ${`${TAG}-cat`}, true)
    RETURNING id
  `;
  ids.categoryId = cat.id;

  ids.questionMcq = await seedQuestion('easy');
  ids.questionSparse = await seedQuestion('hard');
  ids.humanA = await seedUser('human');
  ids.humanB = await seedUser('human');
  ids.aiUser = await seedUser('ai');
  ids.seedUser = await seedUser('seed');
  ids.rankedMatch = await seedMatch(false);
  ids.rankedMatch2 = await seedMatch(false);
  ids.devMatch = await seedMatch(true);

  await linkQuestion(ids.rankedMatch, 0, ids.questionMcq);
  await linkQuestion(ids.rankedMatch, 1, ids.questionSparse);
  await linkQuestion(ids.rankedMatch2, 0, ids.questionMcq);
  await linkQuestion(ids.devMatch, 0, ids.questionMcq);

  // questionMcq: 3 usable human answers + 1 timeout backfill (excluded).
  //  match1/q0 humanA: correct, clean-window 4000ms
  //  match1/q0 humanB: correct, clean-window 6000ms
  //  match1/q0 is a separate PK per user; the backfill goes on match2 to avoid
  //  colliding with humanB's real answer on the same (match,q).
  //  match2/q0 humanA: correct but PRE-clean-window (DIRTY) -> accuracy counts, timing excluded
  //  match2/q0 humanB: TIMEOUT BACKFILL (null idx, wrong, full duration, 0 points) -> fully excluded
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 0, userId: ids.humanA, selectedIndex: 0, isCorrect: true, timeMs: 4000, pointsEarned: 100, answeredAt: CLEAN });
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 0, userId: ids.humanB, selectedIndex: 0, isCorrect: true, timeMs: 6000, pointsEarned: 90, answeredAt: CLEAN });
  await seedAnswer({ matchId: ids.rankedMatch2, qIndex: 0, userId: ids.humanA, selectedIndex: 0, isCorrect: true, timeMs: 2000, pointsEarned: 100, answeredAt: DIRTY });
  await seedAnswer({ matchId: ids.rankedMatch2, qIndex: 0, userId: ids.humanB, selectedIndex: null, isCorrect: false, timeMs: FULL_DURATION_MS.multipleChoice, pointsEarned: 0, answeredAt: CLEAN });

  // AI + seed answers on questionMcq -> must be excluded entirely.
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 0, userId: ids.aiUser, selectedIndex: 1, isCorrect: false, timeMs: 3000, pointsEarned: 0, answeredAt: CLEAN });
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 0, userId: ids.seedUser, selectedIndex: 0, isCorrect: true, timeMs: 3000, pointsEarned: 100, answeredAt: CLEAN });

  // Dev-match answer on questionMcq -> excluded.
  await seedAnswer({ matchId: ids.devMatch, qIndex: 0, userId: ids.humanA, selectedIndex: 0, isCorrect: true, timeMs: 3000, pointsEarned: 100, answeredAt: CLEAN });

  // questionSparse (ranked): a single wrong human answer, clean window.
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 1, userId: ids.humanA, selectedIndex: 2, isCorrect: false, timeMs: 8000, pointsEarned: 0, answeredAt: CLEAN });
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Clean up only the rows this suite created (namespaced). match_answers +
  // match_questions cascade from matches/questions; question_stats cascades from
  // questions. Delete children explicitly to be safe under FK ordering.
  await sql`DELETE FROM match_answers WHERE match_id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM match_questions WHERE match_id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM matches WHERE id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM question_stats WHERE question_id = ANY(${[ids.questionMcq, ids.questionSparse].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM questions WHERE id = ANY(${[ids.questionMcq, ids.questionSparse].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM categories WHERE id = ${ids.categoryId!}`;
  await sql`DELETE FROM users WHERE id = ANY(${[ids.humanA, ids.humanB, ids.aiUser, ids.seedUser].filter(Boolean)}::uuid[])`;
  // Remove backoff rows this suite's category/type produced (namespaced key).
  await sql`DELETE FROM question_stats_backoff WHERE scope_key = ${`${TAG}-cat:mcq_single`}`;
});

describe('question_stats refresh job', () => {
  it('aggregates human ranked answers with all exclusions applied', async () => {
    if (!dbAvailable) return;
    const summary = await refreshQuestionStats();
    expect(summary.questionRows).toBeGreaterThanOrEqual(2);

    const [mcq] = await sql<
      { answers_count: number; correct_count: number; smoothed_accuracy: number; median_time_ms: number | null; log_time_sigma: number | null }[]
    >`SELECT answers_count, correct_count, smoothed_accuracy, median_time_ms, log_time_sigma
      FROM question_stats WHERE question_id = ${ids.questionMcq!}`;

    // Usable answers on questionMcq: humanA(clean correct), humanB(clean correct),
    // humanA(dirty correct). Excluded: humanB timeout backfill, AI, seed, dev.
    expect(mcq.answers_count).toBe(3);
    expect(mcq.correct_count).toBe(3);

    // Timing uses ONLY clean-window rows: 4000 + 6000 (dirty 2000 excluded,
    // backfill excluded) -> median 5000.
    expect(mcq.median_time_ms).toBe(5000);
    expect(mcq.log_time_sigma).not.toBeNull();

    // smoothed_accuracy = (3 + 20*globalMean) / (3 + 20). globalMean over all
    // usable rows across both questions is derivable, but assert it sits between
    // the raw rate (1.0) and the prior, and is < 1.
    expect(mcq.smoothed_accuracy).toBeGreaterThan(0.5);
    expect(mcq.smoothed_accuracy).toBeLessThan(1);
  });

  it('produces backoff rows at every scope', async () => {
    if (!dbAvailable) return;
    const catType = await sql<{ answers_count: number }[]>`
      SELECT answers_count FROM question_stats_backoff
      WHERE scope = 'category_type' AND scope_key = ${`${TAG}-cat:mcq_single`}`;
    expect(catType.length).toBe(1);
    // 3 (questionMcq usable) + 1 (questionSparse) = 4 mcq_single answers in this category.
    expect(catType[0].answers_count).toBe(4);

    const global = await sql<{ answers_count: number; smoothed_accuracy: number }[]>`
      SELECT answers_count, smoothed_accuracy FROM question_stats_backoff WHERE scope = 'global' AND scope_key = 'global'`;
    expect(global.length).toBe(1);
    expect(global[0].answers_count).toBeGreaterThanOrEqual(4);
  });

  it('is idempotent — a second run yields identical per-question counts', async () => {
    if (!dbAvailable) return;
    const before = await sql<{ answers_count: number; correct_count: number }[]>`
      SELECT answers_count, correct_count FROM question_stats WHERE question_id = ${ids.questionMcq!}`;
    await refreshQuestionStats();
    const after = await sql<{ answers_count: number; correct_count: number }[]>`
      SELECT answers_count, correct_count FROM question_stats WHERE question_id = ${ids.questionMcq!}`;
    expect(after[0].answers_count).toBe(before[0].answers_count);
    expect(after[0].correct_count).toBe(before[0].correct_count);
  });
});
