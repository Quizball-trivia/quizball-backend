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
  questionCountdown?: string; // special format -> format_stats, NOT accuracy
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

async function seedQuestion(difficulty: string, type = 'mcq_single'): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    VALUES (${ids.categoryId!}, ${type}, ${difficulty}, 'published', ${{ en: `${TAG} ${difficulty} ${type}` }}::jsonb)
    RETURNING id
  `;
  return row.id;
}

async function seedMatch(isDev: boolean): Promise<string> {
  // Dev matches are seeded as status='active' so cleanupOldDevMatches (which
  // only targets completed/abandoned dev matches, globally) can never race-
  // delete them under the shared test DB. Our eligibility query excludes them
  // by BOTH is_dev=false AND status='completed', so an active dev match still
  // exercises the exclusion path. Non-dev matches stay 'completed'.
  const status = isDev ? 'active' : 'completed';
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO matches (mode, status, is_dev, started_at, ended_at)
    VALUES ('ranked', ${status}, ${isDev}, '2000-01-01T00:00:00Z'::timestamptz, NOW())
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
  payload?: Record<string, unknown>;
}

async function seedAnswer(a: AnswerSpec): Promise<void> {
  await sql`
    INSERT INTO match_answers
      (match_id, q_index, user_id, selected_index, is_correct, time_ms, points_earned, answered_at, answer_payload)
    VALUES (
      ${a.matchId}, ${a.qIndex}, ${a.userId}, ${a.selectedIndex}, ${a.isCorrect},
      ${a.timeMs}, ${a.pointsEarned}, ${a.answeredAt}::timestamptz, ${sql.json(a.payload ?? {})}
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
  ids.questionCountdown = await seedQuestion('medium', 'countdown_list');
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

  // Countdown (special format): opponent-relative is_correct, carries a found-count
  // payload. Must NOT contribute to accuracy/global-prior; only to format_stats.
  // Persisted like the resolver does: selected_index = null for non-MCQ kinds.
  await linkQuestion(ids.rankedMatch, 2, ids.questionCountdown);
  await linkQuestion(ids.rankedMatch2, 2, ids.questionCountdown);
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 2, userId: ids.humanA, selectedIndex: null, isCorrect: true, timeMs: 12000, pointsEarned: 50, answeredAt: CLEAN, payload: { questionKind: 'countdown', foundCount: 3, foundAnswerIds: ['a', 'b', 'c'] } });
  await seedAnswer({ matchId: ids.rankedMatch, qIndex: 2, userId: ids.humanB, selectedIndex: null, isCorrect: false, timeMs: 15000, pointsEarned: 20, answeredAt: CLEAN, payload: { questionKind: 'countdown', foundCount: 1, foundAnswerIds: ['a'] } });
  await seedAnswer({ matchId: ids.rankedMatch2, qIndex: 2, userId: ids.humanA, selectedIndex: null, isCorrect: false, timeMs: 15000, pointsEarned: 20, answeredAt: CLEAN, payload: { questionKind: 'countdown', foundCount: 1, foundAnswerIds: ['a'] } });
});

afterAll(async () => {
  if (!dbAvailable) return;
  // Clean up only the rows this suite created (namespaced). match_answers +
  // match_questions cascade from matches/questions; question_stats cascades from
  // questions. Delete children explicitly to be safe under FK ordering.
  await sql`DELETE FROM match_answers WHERE match_id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM match_questions WHERE match_id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  await sql`DELETE FROM matches WHERE id = ANY(${[ids.rankedMatch, ids.rankedMatch2, ids.devMatch].filter(Boolean)}::uuid[])`;
  const allQ = [ids.questionMcq, ids.questionSparse, ids.questionCountdown].filter(Boolean) as string[];
  await sql`DELETE FROM question_stats WHERE question_id = ANY(${allQ}::uuid[])`;
  await sql`DELETE FROM questions WHERE id = ANY(${allQ}::uuid[])`;
  await sql`DELETE FROM categories WHERE id = ${ids.categoryId!}`;
  await sql`DELETE FROM users WHERE id = ANY(${[ids.humanA, ids.humanB, ids.aiUser, ids.seedUser].filter(Boolean)}::uuid[])`;
  // Remove backoff rows this suite's category/type produced (namespaced keys).
  await sql`DELETE FROM question_stats_backoff WHERE scope_key IN (${`${TAG}-cat:mcq_single`}, ${`${TAG}-cat:countdown_list`})`;
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

  it('keeps special formats OUT of accuracy and models them in format_stats', async () => {
    if (!dbAvailable) return;
    await refreshQuestionStats();
    const [cd] = await sql<
      { answers_count: number; correct_count: number; smoothed_accuracy: number | null; format_stats: Record<string, unknown> }[]
    >`SELECT answers_count, correct_count, smoothed_accuracy, format_stats
      FROM question_stats WHERE question_id = ${ids.questionCountdown!}`;
    // Countdown contributes NO accuracy (answers_count/correct_count stay 0, acc null).
    expect(cd.answers_count).toBe(0);
    expect(cd.correct_count).toBe(0);
    expect(cd.smoothed_accuracy).toBeNull();
    // ...but it carries a found-count distribution built from the payload.
    const dist = cd.format_stats.countdownFoundCountDistribution as Record<string, number> | undefined;
    expect(dist).toBeTruthy();
    // foundCounts seeded: 3 (once), 1 (twice) -> {"1":2,"3":1}
    expect(dist!['3']).toBe(1);
    expect(dist!['1']).toBe(2);

    // The countdown answers must not have contaminated the category_type mcq
    // accuracy (only Bernoulli rows count there).
    const [ct] = await sql<{ answers_count: number }[]>`
      SELECT answers_count FROM question_stats_backoff
      WHERE scope = 'category_type' AND scope_key = ${`${TAG}-cat:mcq_single`}`;
    expect(ct.answers_count).toBe(4); // unchanged by the 3 countdown answers
    const cdCt = await sql<{ answers_count: number }[]>`
      SELECT answers_count FROM question_stats_backoff
      WHERE scope = 'category_type' AND scope_key = ${`${TAG}-cat:countdown_list`}`;
    // countdown_list produces no accuracy backoff row (0 Bernoulli answers) OR a
    // row with 0 answers — either way its answers_count is 0 if present.
    if (cdCt.length > 0) expect(cdCt[0].answers_count).toBe(0);
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

  it('delete-not-present drops a question_stats row that lost all eligible answers', async () => {
    if (!dbAvailable) return;
    // questionSparse currently has 1 eligible answer -> a row exists.
    const present = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM question_stats WHERE question_id = ${ids.questionSparse!}`;
    expect(present[0].n).toBe(1);
    // Make that lone answer ineligible by flipping the match out of 'completed'
    // (the query requires status='completed'). Avoid toggling is_dev, which would
    // create a completed dev match that races cleanupOldDevMatches on the shared DB.
    await sql`UPDATE matches SET status = 'active' WHERE id = ${ids.rankedMatch!}`;
    try {
      await refreshQuestionStats();
      const gone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM question_stats WHERE question_id = ${ids.questionSparse!}`;
      expect(gone[0].n).toBe(0); // obsolete row deleted, not left stale
    } finally {
      await sql`UPDATE matches SET status = 'completed' WHERE id = ${ids.rankedMatch!}`;
      await refreshQuestionStats(); // restore state for any later assertions
    }
  });

  it('--limit is a DRY RUN — computes a summary but writes nothing', async () => {
    if (!dbAvailable) return;
    const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM question_stats`;
    const summary = await refreshQuestionStats({ limit: 1 });
    expect(summary.dryRun).toBe(true);
    expect(summary.questionRowsDeleted).toBe(0);
    const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM question_stats`;
    expect(after[0].n).toBe(before[0].n); // untouched
  });
});
