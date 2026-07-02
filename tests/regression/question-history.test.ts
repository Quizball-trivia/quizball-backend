/**
 * History-aware question selection — the "stop repeating recently-seen
 * questions" contract (commits 50c7985 + 1aae435). The hot pick query excludes
 * questions a player saw within QUESTION_HISTORY_WINDOW_DAYS, and on pool
 * exhaustion orders the unavoidable repeat by least-recently-seen.
 *
 * We pin the source-of-truth read, getRecentlySeenQuestionIds, against the real
 * DB:
 *   - a question SHOWN to the user (shown_at set) is recently-seen.
 *   - a dispatched-but-never-shown question (shown_at NULL) does NOT pollute
 *     history (the documented shown_at gate).
 *   - a question shown OUTSIDE the window is not recently-seen.
 *
 * Local-only: REGRESSION_DB_URL must point at the native regression DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;
const NS = 'regression-qhistory';

describeLocal('regression: history-aware question selection (real DB)', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  let repo: (typeof import('../../src/modules/matches/match-questions.repo.js'))['matchQuestionsRepo'];
  let userId: string;
  let catId: string;
  let qShownRecent: string;
  let qShownOld: string;
  let qNeverShown: string;
  let matchId: string;

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    ({ matchQuestionsRepo: repo } = await import('../../src/modules/matches/match-questions.repo.js'));

    // Self-heal: clear any leftovers from a crashed prior run so re-runs don't
    // trip the nickname/category unique constraints.
    await sql`DELETE FROM match_questions WHERE match_id IN (SELECT m.id FROM matches m JOIN categories c ON c.id = m.category_a_id WHERE c.slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM match_players WHERE match_id IN (SELECT m.id FROM matches m JOIN categories c ON c.id = m.category_a_id WHERE c.slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM matches WHERE category_a_id IN (SELECT id FROM categories WHERE slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM questions WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${NS + '%'})`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS + '%'}`;
    await sql`DELETE FROM users WHERE nickname LIKE ${NS + '%'}`;

    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, nickname, onboarding_complete)
      VALUES (${NS} || '+u@test.local', ${NS} || '-u', true) RETURNING id`;
    userId = u.id;

    const [c] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, is_active)
      VALUES (${NS} || '-c', jsonb_build_object('en', 'QHist Cat'), true) RETURNING id`;
    catId = c.id;

    const qs = await sql<{ id: string }[]>`
      INSERT INTO questions (category_id, type, difficulty, status, prompt)
      SELECT ${catId}, 'mcq_single', 'easy', 'published',
             jsonb_build_object('en', ${NS} || '-q' || i)
      FROM generate_series(1, 3) i RETURNING id`;
    [qShownRecent, qShownOld, qNeverShown] = qs.map((r) => r.id);

    const [m] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, category_a_id, category_b_id, current_q_index, total_questions)
      VALUES ('ranked', 'completed', ${catId}, ${catId}, 5, 5) RETURNING id`;
    matchId = m.id;
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${matchId}, ${userId}, 1)`;

    // q0: shown 1 day ago (inside the 14-day window) → recently-seen.
    // q1: shown 30 days ago (outside the window) → NOT recently-seen.
    // q2: dispatched but never shown (shown_at NULL) → must NOT count.
    await sql`
      INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index, shown_at)
      VALUES
        (${matchId}, 0, ${qShownRecent}, ${catId}, 0, now() - interval '1 day'),
        (${matchId}, 1, ${qShownOld},    ${catId}, 0, now() - interval '30 days'),
        (${matchId}, 2, ${qNeverShown},  ${catId}, 0, NULL)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM match_questions WHERE match_id = ${matchId}`;
    await sql`DELETE FROM match_players WHERE match_id = ${matchId}`;
    await sql`DELETE FROM matches WHERE id = ${matchId}`;
    await sql`DELETE FROM questions WHERE category_id = ${catId}`;
    await sql`DELETE FROM categories WHERE id = ${catId}`;
    await sql`DELETE FROM users WHERE nickname = ${NS + '-u'}`;
  });

  it('a question shown inside the window is recently-seen; old + never-shown are not', async () => {
    const seen = await repo.getRecentlySeenQuestionIds([userId], 14);
    expect(seen, 'shown-recently must be flagged').toContain(qShownRecent);
    expect(seen, 'shown 30d ago is outside the 14d window').not.toContain(qShownOld);
    expect(seen, 'never-shown (shown_at NULL) must not pollute history').not.toContain(qNeverShown);
  });

  it('widening the window picks up the older question too', async () => {
    const seen = await repo.getRecentlySeenQuestionIds([userId], 60);
    expect(seen).toContain(qShownRecent);
    expect(seen, '30d ago is inside a 60d window').toContain(qShownOld);
    expect(seen).not.toContain(qNeverShown);
  });
});

// Fair repeat ordering: when a category is fully exhausted, the unavoidable
// repeat is ordered GREATEST(per-player seen count) ASC → oldest-seen ASC →
// random, considering BOTH players' history. This pins that contract end-to-end
// against the real DB via getRandomQuestionCandidatesForMatch(leastRecentForUserIds).
describeLocal('regression: fair repeat ordering on category exhaustion (real DB)', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  let repo: (typeof import('../../src/modules/matches/match-questions.repo.js'))['matchQuestionsRepo'];
  const NS2 = 'regression-qfair';
  let p1: string, p2: string, catId: string;
  let qFewest: string, qMid: string, qMost: string;
  let liveMatchId: string;

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    ({ matchQuestionsRepo: repo } = await import('../../src/modules/matches/match-questions.repo.js'));

    await sql`DELETE FROM match_questions WHERE match_id IN (SELECT m.id FROM matches m JOIN categories c ON c.id=m.category_a_id WHERE c.slug LIKE ${NS2 + '%'})`;
    await sql`DELETE FROM match_players WHERE match_id IN (SELECT m.id FROM matches m JOIN categories c ON c.id=m.category_a_id WHERE c.slug LIKE ${NS2 + '%'})`;
    await sql`DELETE FROM matches WHERE category_a_id IN (SELECT id FROM categories WHERE slug LIKE ${NS2 + '%'})`;
    await sql`DELETE FROM question_payloads WHERE question_id IN (SELECT id FROM questions WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${NS2 + '%'}))`;
    await sql`DELETE FROM questions WHERE category_id IN (SELECT id FROM categories WHERE slug LIKE ${NS2 + '%'})`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS2 + '%'}`;
    await sql`DELETE FROM users WHERE nickname LIKE ${NS2 + '%'}`;

    const us = await sql<{ id: string }[]>`
      INSERT INTO users (email, nickname, onboarding_complete)
      SELECT ${NS2} || '+' || i || '@test.local', ${NS2} || '-' || i, true FROM generate_series(1,2) i RETURNING id`;
    [p1, p2] = us.map((u) => u.id);

    const [c] = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, is_active) VALUES (${NS2} || '-c', jsonb_build_object('en','Fair Cat'), true) RETURNING id`;
    catId = c.id;

    // Exactly 3 questions, ALL already seen by both players (category exhausted).
    const qs = await sql<{ id: string }[]>`
      INSERT INTO questions (category_id, type, difficulty, status, prompt)
      SELECT ${catId}, 'mcq_single', 'easy', 'published', jsonb_build_object('en', ${NS2} || '-q' || i)
      FROM generate_series(1,3) i RETURNING id`;
    [qFewest, qMid, qMost] = qs.map((r) => r.id);

    // The pick query inner-joins question_payloads and validates the MCQ payload.
    // Clone a known-good payload from any real published MCQ so our test rows pass.
    const [tpl] = await sql<{ payload: unknown }[]>`
      SELECT qp.payload FROM question_payloads qp
      JOIN questions q ON q.id=qp.question_id
      WHERE q.type='mcq_single' AND q.status='published' LIMIT 1`;
    if (!tpl) throw new Error('regression DB has no published mcq_single payload to clone');
    for (const qid of [qFewest, qMid, qMost]) {
      await sql`INSERT INTO question_payloads (question_id, payload) VALUES (${qid}, ${sql.json(tpl.payload as object)})`;
    }

    // A LIVE match in this category (the one we're picking for) with both players.
    const [lm] = await sql<{ id: string }[]>`
      INSERT INTO matches (mode, status, category_a_id, category_b_id, current_q_index, total_questions)
      VALUES ('ranked','active',${catId},${catId},0,5) RETURNING id`;
    liveMatchId = lm.id;
    await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${liveMatchId}, ${p1}, 1), (${liveMatchId}, ${p2}, 2)`;

    // Seed PRIOR history (separate completed matches) so each question has a
    // known GREATEST(per-player count) and recency:
    //   qFewest: p1×1, p2×1  -> GREATEST=1, seen recently
    //   qMid:    p1×2, p2×1  -> GREATEST=2
    //   qMost:   p1×3, p2×3  -> GREATEST=3
    // qFewest has the lowest GREATEST → must be picked FIRST on the repeat.
    const seedSeen = async (qid: string, p1n: number, p2n: number) => {
      for (const [uid, n] of [[p1, p1n], [p2, p2n]] as const) {
        for (let k = 0; k < n; k += 1) {
          const [hm] = await sql<{ id: string }[]>`
            INSERT INTO matches (mode, status, category_a_id, category_b_id, current_q_index, total_questions)
            VALUES ('ranked','completed',${catId},${catId},1,1) RETURNING id`;
          await sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${hm.id}, ${uid}, 1)`;
          await sql`INSERT INTO match_questions (match_id, q_index, question_id, category_id, correct_index, shown_at)
                    VALUES (${hm.id}, 0, ${qid}, ${catId}, 0, now() - (interval '1 day') * ${k + 1})`;
        }
      }
    };
    await seedSeen(qFewest, 1, 1);
    await seedSeen(qMid, 2, 1);
    await seedSeen(qMost, 3, 3);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM match_questions WHERE match_id IN (SELECT m.id FROM matches m WHERE m.category_a_id=${catId})`;
    await sql`DELETE FROM match_players WHERE match_id IN (SELECT m.id FROM matches m WHERE m.category_a_id=${catId})`;
    await sql`DELETE FROM matches WHERE category_a_id=${catId}`;
    await sql`DELETE FROM question_payloads WHERE question_id IN (SELECT id FROM questions WHERE category_id=${catId})`;
    await sql`DELETE FROM questions WHERE category_id=${catId}`;
    await sql`DELETE FROM categories WHERE id=${catId}`;
    await sql`DELETE FROM users WHERE nickname LIKE ${NS2 + '%'}`;
  });

  it('on exhaustion, repeats the LEAST-played question first (GREATEST per-player count), both histories considered', async () => {
    // Ask for all 3 as a repeat batch (leastRecentForUserIds set = fallback path).
    const rows = await repo.getRandomQuestionCandidatesForMatch({
      matchId: liveMatchId,
      categoryIds: [catId],
      questionTypes: ['mcq_single'],
      leastRecentForUserIds: [p1, p2],
      limit: 3,
    });
    const order = rows.map((r) => r.id);
    expect(order, 'all 3 exhausted questions returned').toHaveLength(3);
    // qFewest (GREATEST=1) must come before qMid (=2) and qMost (=3).
    expect(order.indexOf(qFewest)).toBeLessThan(order.indexOf(qMid));
    expect(order.indexOf(qMid)).toBeLessThan(order.indexOf(qMost));
    expect(order[0], 'least-played question is picked first').toBe(qFewest);
  });
});
