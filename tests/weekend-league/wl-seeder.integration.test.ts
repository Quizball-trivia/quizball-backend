/**
 * Content seeder against the local DB: synthetic wl_private stock in, a
 * fully seeded 4-game tournament out — slots + reserves, bilingual-only,
 * all-or-nothing on shortage, repeat-avoidance across recent tournaments.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

let sql: typeof import('../../src/db/index.js').sql;
let seed: typeof import('../../src/modules/weekend-league/wl-seeder.js').wlSeedTournamentContent;
let needPerKind: typeof import('../../src/modules/weekend-league/wl-seeder.js').wlSourceNeedPerKind;
let dbAvailable = false;

const testQuestionIds: string[] = [];
const testTournamentIds: string[] = [];
let categoryId = '';

const WL_TEST_LOCK = 774431001;
let lockConn: Awaited<ReturnType<typeof sql.reserve>> | null = null;

const i18n = (base: string) => ({ en: `${base} en`, ka: `${base} ka` });

async function seedSource(type: string, payload: Record<string, unknown>, visibility = 'wl_private'): Promise<string> {
  const [q] = await sql<{ id: string }[]>`
    INSERT INTO questions (category_id, type, difficulty, status, ranked_eligible, visibility, prompt)
    VALUES (${categoryId}, ${type}, 'medium', 'published', true, ${visibility},
            ${sql.json(i18n(`prompt-${type}-${testQuestionIds.length}`) as never)})
    RETURNING id
  `;
  await sql`
    INSERT INTO question_payloads (question_id, payload)
    VALUES (${q.id}, ${sql.json(payload as never)})
  `;
  testQuestionIds.push(q.id);
  return q.id;
}

function mcqPayload(n: number): Record<string, unknown> {
  return {
    type: 'mcq_single',
    options: [0, 1, 2, 3].map((i) => ({
      id: `o${i}`, text: i18n(`opt-${n}-${i}`), is_correct: i === n % 4,
    })),
  };
}

async function stockAllKinds(): Promise<void> {
  const counts: Array<[string, number, (i: number) => Record<string, unknown>]> = [
    ['mcq_single', needPerKind('mcq'), mcqPayload],
    ['true_false', needPerKind('true_false'), (i) => ({
      type: 'true_false',
      options: [
        { id: 'true', text: i18n(`t${i}`), is_correct: i % 2 === 0 },
        { id: 'false', text: i18n(`f${i}`), is_correct: i % 2 !== 0 },
      ],
    })],
    ['high_low', needPerKind('higher_lower'), (i) => ({
      type: 'high_low',
      stat_label: i18n(`stat${i}`),
      matchups: [0, 1, 2, 3, 4].map((m) => ({
        id: `m${m}`, left_name: i18n(`L${i}-${m}`), left_value: m + i,
        right_name: i18n(`R${i}-${m}`), right_value: m + i + 1,
      })),
    })],
    ['career_path', needPerKind('career_path'), (i) => ({
      type: 'career_path',
      clubs: [i18n(`club${i}a`), i18n(`club${i}b`)],
      display_answer: i18n(`career-ans${i}`),
      accepted_answers: [`career answer ${i}`],
    })],
    ['clue_chain', needPerKind('who_am_i'), (i) => ({
      type: 'clue_chain',
      display_answer: i18n(`clue-ans${i}`),
      accepted_answers: [`clue answer ${i}`],
      clues: [1, 2, 3, 4, 5].map((c) => ({ type: 'text', content: i18n(`clue${i}-${c}`) })),
    })],
  ];
  for (const [type, need, build] of counts) {
    for (let i = 0; i < need; i += 1) {
      await seedSource(type, build(i));
    }
  }
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    const mod = await import('../../src/modules/weekend-league/wl-seeder.js');
    seed = mod.wlSeedTournamentContent;
    needPerKind = mod.wlSourceNeedPerKind;
    lockConn = await sql.reserve();
    await lockConn`SELECT pg_advisory_lock(${WL_TEST_LOCK})`;
    const [cat] = await sql<{ id: string }[]>`
      SELECT id FROM categories LIMIT 1
    `;
    if (!cat) throw new Error('no category available');
    categoryId = cat.id;
    dbAvailable = true;
  } catch {
    if (lockConn) {
      await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
      lockConn.release();
      lockConn = null;
    }
    console.warn('\n⚠️  Skipping WL seeder tests: DB unavailable.\n');
  }
}, 120_000);

afterAll(async () => {
  if (!dbAvailable) {
    return;
  }
  if (testTournamentIds.length > 0) {
    await sql`DELETE FROM wl_tournaments WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])`;
  }
  if (testQuestionIds.length > 0) {
    await sql`DELETE FROM question_payloads WHERE question_id = ANY(${sql.array(testQuestionIds)}::uuid[])`;
    await sql`DELETE FROM questions WHERE id = ANY(${sql.array(testQuestionIds)}::uuid[])`;
  }
  if (lockConn) {
    await lockConn`SELECT pg_advisory_unlock(${WL_TEST_LOCK})`.catch(() => {});
    lockConn.release();
  }
  await sql.end({ timeout: 5 });
});

async function createTournament(): Promise<string> {
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO wl_tournaments (is_test, status, config)
    VALUES (true, 'content_pending', '{"launch_edition": true}'::jsonb)
    RETURNING id
  `;
  testTournamentIds.push(t.id);
  return t.id;
}

describe('wlSeedTournamentContent', () => {
  it('refuses to seed anything on insufficient stock', async ({ skip }) => {
    if (!dbAvailable) skip();
    // Self-sufficient precondition: leftover wl_private stock from other
    // (kept-state) runs must not satisfy this test. Localhost-guarded.
    if ((() => {
      try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname); }
      catch { return false; }
    })()) {
      await sql`DELETE FROM question_payloads WHERE question_id IN
        (SELECT id FROM questions WHERE visibility = 'wl_private')`;
      await sql`DELETE FROM questions WHERE visibility = 'wl_private'
        AND id NOT IN (SELECT source_question_id FROM wl_questions WHERE source_question_id IS NOT NULL)`;
    }
    const tid = await createTournament();
    const result = await seed({ tournamentId: tid, allowPublicBank: false, deterministic: true });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.shortages ?? {}).length).toBeGreaterThan(0);
    const [count] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_questions WHERE tournament_id = ${tid}
    `;
    expect(count.n).toBe(0);
  });

  it('seeds 4 full games with reserves from wl_private stock, idempotently', async ({ skip }) => {
    if (!dbAvailable) skip();
    await stockAllKinds();
    const tid = await createTournament();
    const result = await seed({ tournamentId: tid, allowPublicBank: false, deterministic: true });
    expect(result.ok).toBe(true);
    // 4 games × (21 slots + 5 kinds × 2 reserves) = 4 × 31 = 124 rows.
    expect(result.inserted).toBe(124);

    const [slots] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_questions
      WHERE tournament_id = ${tid} AND reserve_ordinal = 0
    `;
    expect(slots.n).toBe(4 * 21);

    // The HL chain compares within one stat: all 3 steps share a source.
    const hl = await sql<{ game_index: number; sources: number }[]>`
      SELECT game_index, COUNT(DISTINCT source_question_id)::int AS sources
      FROM wl_questions
      WHERE tournament_id = ${tid} AND kind = 'higher_lower' AND reserve_ordinal = 0
      GROUP BY game_index
    `;
    expect(hl.every((g) => g.sources === 1)).toBe(true);

    // Idempotent: a second call inserts nothing.
    const again = await seed({ tournamentId: tid, allowPublicBank: false, deterministic: true });
    expect(again).toEqual({ ok: true, inserted: 0 });
  });

  it('repeat-avoidance: real-event sources block, test-event sources do not', async ({ skip }) => {
    if (!dbAvailable) skip();
    // The previous test's consumer is a TEST tournament — its consumption
    // must NOT starve fresh events (staging runs many compressed test
    // events a day), so seeding succeeds on the same stock.
    const tid2 = await createTournament();
    const asTest = await seed({ tournamentId: tid2, allowPublicBank: false, deterministic: true });
    expect(asTest.ok).toBe(true);

    // Flip the consumers to REAL events: now the stock is burned for the
    // repeat window and a fresh tournament must refuse rather than repeat.
    await sql`
      UPDATE wl_tournaments SET is_test = false
      WHERE id = ANY(${sql.array(testTournamentIds)}::uuid[])
    `;
    const tid3 = await createTournament();
    const result = await seed({ tournamentId: tid3, allowPublicBank: false, deterministic: true });
    expect(result.ok).toBe(false);
  });
});
