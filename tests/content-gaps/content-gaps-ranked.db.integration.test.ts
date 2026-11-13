import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: the content-gap context for Ranked questions (Who Am I, Countdown), e.g.
 *   CONTENT_GAPS_RANKED_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_fixer_test_ranked
 * Invented questions only: the repository is public.
 */
const url = process.env.CONTENT_GAPS_RANKED_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_fixer_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const MIGRATIONS = ['20261110160000_content_gaps.sql', '20261110234000_hq_answer_gaps.sql', '20261110235000_content_fixer.sql',
  '20261113150000_content_fixer_grid.sql', '20261113160000_content_fixer_unstick.sql', '20261113170000_content_gaps_ranked.sql'];
const STANDINS = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS hq;
  CREATE TABLE IF NOT EXISTS hq.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, kind text, name text, title text,
    avatar text, color text, description text, tools text[] NOT NULL DEFAULT '{}', instructions text, department text, status text DEFAULT 'active', updated_at timestamptz);
  CREATE TABLE IF NOT EXISTS hq.schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, name text, cron text, timezone text, task_title text, task_body text, task_kind text DEFAULT 'task', enabled boolean DEFAULT true);
  INSERT INTO hq.members (slug, kind, name, instructions) VALUES ('answer-gap-monitor', 'agent', 'Fixer', 'old');
  CREATE TABLE IF NOT EXISTS public.wordgame_players (release_id text, pid text, name text, game_name text, fame int, aliases text[]);
  CREATE TABLE IF NOT EXISTS public.darts501_days (day date PRIMARY KEY, category jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.darts501_coverage (coverage_id text, pid text, PRIMARY KEY (coverage_id, pid));
  CREATE TABLE IF NOT EXISTS public.room_pool (game text, item_id text, payload jsonb, enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.tenable_days (day date PRIMARY KEY, list jsonb NOT NULL);
  CREATE TABLE public.questions (id uuid PRIMARY KEY, type text NOT NULL, status text NOT NULL, prompt jsonb NOT NULL);
  CREATE TABLE public.question_payloads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), question_id uuid NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.squad_spin_criteria (id uuid PRIMARY KEY, family text, label_en text);
  CREATE TABLE public.squad_spin_players (id uuid PRIMARY KEY, name_en text);
  CREATE TABLE public.squad_spin_combos (id uuid PRIMARY KEY, club_id uuid, nation_id uuid, position_group text, extra_ids uuid[], answer_ids uuid[],
    tier text, active boolean, content_version integer);
  GRANT USAGE ON SCHEMA hq, public TO service_role, anon, authenticated;
`;
const WHO = '00000000-0000-4000-8000-0000000000d1';
const LIST = '00000000-0000-4000-8000-0000000000d2';

describe.skipIf(!url)('content-gap context for Ranked (real PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined });
    await sql.unsafe('DROP SCHEMA IF EXISTS hq CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await sql.unsafe(STANDINS);
    for (const file of MIGRATIONS) {
      const body = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin((tx) => tx.unsafe(body));
    }
    await sql`INSERT INTO questions VALUES (${WHO}, 'clue_chain', 'published', ${sql.json({ en: 'Who am I?', es: '¿Quién soy?' })}),
      (${LIST}, 'countdown_list', 'published', ${sql.json({ en: 'Name the invented club captains' })})`;
    await sql`INSERT INTO question_payloads (question_id, payload) VALUES
      (${WHO}, ${sql.json({ type: 'clue_chain', clues: [{ en: 'I played for Club Vale' }, 'Plain clue'], display_answer: { en: 'Aro Bandel' }, accepted_answers: { en: ['Aro Bandel', 'Bandel'] } })}),
      (${LIST}, ${sql.json({ type: 'countdown_list', answer_groups: [{ id: 'g1', display: 'Wim Xell', accepted: ['Wim Xell', 'Xell'] }] })})`;
  });
  afterAll(async () => { await sql?.end(); });
  const ctx = async (game: string, board: string) => (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context(${game}, ${board}, NULL, NULL, 'r1') AS c`)[0].c;

  it('a Who Am I question: prompt, clues in English, the display and accepted answers', async () => {
    expect(await ctx('clue_chain', WHO)).toMatchObject({
      found: true, prompt: 'Who am I?', clues: ['I played for Club Vale', '"Plain clue"'], displayAnswer: { en: 'Aro Bandel' },
      acceptedAnswers: { en: ['Aro Bandel', 'Bandel'] }, answerGroups: null, questionStatus: 'published',
    });
  });

  it('a Countdown question: its answer groups; a question of the other kind or a junk id is not found', async () => {
    expect(await ctx('countdown_list', LIST)).toMatchObject({ found: true, answerGroups: [{ id: 'g1', display: 'Wim Xell' }], acceptedAnswers: null });
    expect((await ctx('clue_chain', LIST)).found).toBe(false);
    expect((await ctx('clue_chain', 'not-a-uuid')).found).toBe(false);
  });

  it('a Squad Spin combo: its criteria, position and accepted footballers', async () => {
    const [club, nation, combo, p1] = ['e1', 'e2', 'e3', 'e4'].map((x) => `00000000-0000-4000-8000-0000000000${x}`);
    await sql`INSERT INTO squad_spin_criteria VALUES (${club}, 'club', 'Club Vale'), (${nation}, 'nation', 'Invented Isles')`;
    await sql`INSERT INTO squad_spin_players VALUES (${p1}, 'Aro Bandel')`;
    await sql`INSERT INTO squad_spin_combos VALUES (${combo}, ${club}, ${nation}, 'MID', '{}', ${[p1]}::uuid[], 'gold', true, 3)`;
    expect(await ctx('squad_spin', combo)).toMatchObject({
      found: true, position: 'MID', criteria: ['Club Vale', 'Invented Isles'], answers: [{ id: p1, name: 'Aro Bandel' }],
    });
    expect((await ctx('squad_spin', '00000000-0000-4000-8000-0000000000ff')).found).toBe(false);
  });

  it('the Fixer learned Ranked once; the other games still resolve', async () => {
    const [m] = await sql`SELECT instructions FROM hq.members WHERE slug = 'answer-gap-monitor'`;
    expect(m.instructions.match(/RANKED \(games clue_chain/g)).toHaveLength(1);
    expect(m.instructions).toContain('SQUAD SPIN (game squad_spin)');
    expect((await ctx('tenable', 'missing-list')).found).toBe(false);
  });
});
