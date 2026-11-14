import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: Tenable context shows the board's answers; a stats verification must name its cut-off;
 * aliases still need two publishers (Wikipedia and Wikidata are one); Tenable gaps leased when the migration runs go
 * back to the queue without costing an attempt.
 *   CONTENT_FIXER_TV_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_fixer_test_tv
 * Invented footballers and clubs only: the repository is public.
 */
const url = process.env.CONTENT_FIXER_TV_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_fixer_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const MIGRATIONS = ['20261110160000_content_gaps.sql', '20261110234000_hq_answer_gaps.sql', '20261110235000_content_fixer.sql',
  '20261113150000_content_fixer_grid.sql', '20261113160000_content_fixer_unstick.sql', '20261113170000_content_gaps_ranked.sql',
  '20261114200000_content_fixer_tenable_verify.sql'];
const STANDINS = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS hq;
  CREATE TABLE IF NOT EXISTS hq.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, kind text, name text, title text,
    avatar text, color text, description text, tools text[] NOT NULL DEFAULT '{}', instructions text, department text, status text DEFAULT 'active', updated_at timestamptz);
  CREATE TABLE IF NOT EXISTS hq.schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, name text, cron text, timezone text, task_title text, task_body text, task_kind text DEFAULT 'task', enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.wordgame_players (release_id text, pid text, name text, game_name text, fame int, aliases text[]);
  CREATE TABLE IF NOT EXISTS public.darts501_days (day date PRIMARY KEY, category jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.darts501_coverage (coverage_id text, pid text, PRIMARY KEY (coverage_id, pid));
  CREATE TABLE IF NOT EXISTS public.room_pool (game text, item_id text, payload jsonb, enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.tenable_days (day date PRIMARY KEY, list jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.tenable_entities (release_id text, kind text, eid text, name text, known text, fame int, aliases text[], qualifier text);
  GRANT USAGE ON SCHEMA hq, public TO service_role, anon, authenticated;
  GRANT SELECT ON public.wordgame_players, public.darts501_days, public.darts501_coverage, public.room_pool, public.tenable_days, public.tenable_entities TO service_role;
`;

const PLAYER_LIST = {
  id: 'list-p', kind: 'player', release: 'rel-1', matcher: 1, tier: 1, topicKey: 'x', note: { en: 'Ties share a place.' }, asOf: '2026-11-01', title: { en: 'Invented League top scorers' },
  slots: [{ eid: 'p1', figure: { value: 120, unit: 'goals' } }, { eid: 'p2', figure: { value: 90, unit: 'goals' } }],
};
const CLUB_LIST = {
  id: 'list-c', kind: 'club', release: 'ten-1', matcher: 1, tier: 1, topicKey: 'y', note: null, asOf: '2026-11-01', title: { en: 'Invented Cup titles' },
  slots: [{ eid: 'c1', figure: { value: 7, unit: 'titles' } }],
};
const CATEGORY = {
  id: 'cat-x', release: 'rel-1', coverage: 'cov-1', unit: 'apps', asOf: '2026-11-09', title: { en: 'Invented League apps for Club X' },
  entries: [{ eid: 'p1', value: 120 }],
};
const TWO_PUBLISHERS = [{ url: 'https://de.wikipedia.org/wiki/Erfunden', quote: 'x' }, { url: 'https://www.espn.com/a', quote: 'y' }];
const ONE_PUBLISHER = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'also written W. Xell' }, { url: 'https://www.wikidata.org/wiki/Q1', quote: 'alias W. Xell' }];

describe.skipIf(!url)('content fixer: Tenable context and verify rules (real PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined });
    await sql.unsafe('DROP SCHEMA IF EXISTS hq CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await sql.unsafe(STANDINS);
    const apply = async (file: string) => {
      const body = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin((tx) => tx.unsafe(body));
    };
    for (const file of MIGRATIONS.slice(0, -1)) await apply(file);
    // A Tenable gap a Fixer run holds when the migration lands (its third try) and a Darts gap held the same way.
    // A fourth give-back would hold it (typed 12 times): the restore must undo that too, keeping its history.
    await sql`INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, resolved_id, count, attempts, audit) VALUES
      ('tenable', 'daily', 'list-x', 'c', 'miss', 'lease one', NULL, 12, 3, '[{"to": "open", "reason": "earlier"}]'::jsonb),
      ('darts501', 'daily', 'cat-x', 'c', 'miss', 'lease two', NULL, 3, 1, '[]'::jsonb)`;
    await sql`SELECT hq.content_gaps_claim('fixer:run-0', 10, 60, NULL)`;
    await apply(MIGRATIONS[MIGRATIONS.length - 1]);
    leasedAfter = await sql`SELECT game, status, attempts, next_try_at IS NULL AS ready, lease_owner, jsonb_array_length(audit) AS audits FROM content_gaps ORDER BY id`;
  });
  let leasedAfter: unknown[] = [];
  afterAll(async () => { await sql.end(); });
  beforeEach(async () => {
    await sql`TRUNCATE content_gaps, content_gap_samples, content_gap_fixes, darts501_days, darts501_coverage, wordgame_players, tenable_days, tenable_entities RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO wordgame_players (release_id, pid, name, fame) VALUES ('rel-1', 'p1', 'Aro Bandel', 60), ('rel-1', 'p2', 'Wim Xell', 30), ('rel-1', 'p3', 'Cal Dorn', 20)`;
    await sql`INSERT INTO tenable_entities (release_id, kind, eid, name, known, fame) VALUES ('ten-1', 'club', 'c1', 'Invented United', 'Invented Utd', 50), ('ten-1', 'club', 'c2', 'Other Rovers', 'Rovers', 20)`;
    await sql`INSERT INTO tenable_days (day, list) VALUES ('2026-11-11', ${sql.json(PLAYER_LIST)}), ('2026-11-12', ${sql.json(CLUB_LIST)})`;
    await sql`INSERT INTO darts501_days (day, category) VALUES ('2026-11-11', ${sql.json(CATEGORY)})`;
  });

  type Claimed = { id: number; context: Record<string, any>; contextHash: string };
  const claim = async (game: string, owner = 'fixer:run-1') =>
    (await sql<[{ c: { token: string; gaps: Claimed[] } }]>`SELECT hq.content_gaps_claim(${owner}, 10, 60, ${game}) AS c`)[0].c;
  const gap = async (game: string, board: string, verdict: string, norm: string, resolved: string | null, typed: string) => {
    const [{ id }] = await sql<[{ id: number }]>`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, resolved_id, count)
      VALUES (${game}, 'daily', ${board}, 'c', ${verdict}, ${norm}, ${resolved}, 5) RETURNING id`;
    await sql`INSERT INTO content_gap_samples (gap_id, locale, typed) VALUES (${id}, 'en', ${typed})`;
    return Number(id);
  };
  const vclaim = async () => (await sql<[{ c: { token: string; fixes: Array<{ id: number }> } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
  const verify = async (token: string, fixId: number, extracted: unknown, sources: unknown) =>
    (await sql<[{ r: { status: string; checks: Record<string, unknown> } }]>`
      SELECT hq.content_fix_verify('verifier:run-9', ${token}::uuid, ${fixId}, 'agree', ${sql.json(extracted as never)}, ${sql.json(sources as never)}) AS r`)[0].r;

  async function proposeAlias(id: number, text: string, entityId = 'p2') {
    const c = await claim('tenable');
    const g = c.gaps.find((x) => x.id === id)!;
    const [{ r }] = await sql<[{ r: { fixId: number } }]>`
      SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[id]}::bigint[], 'alias', ${sql.json({ entityId, locale: 'en', text })},
        ${sql.json([{ url: 'https://en.wikipedia.org/wiki/Invented', quote: text }])}, ${sql.json({ [id]: g.contextHash })}) AS r`;
    return r.fixId;
  }

  it('a Tenable gap shows the board: every answer in order with its name and figure, and who the player may have meant', async () => {
    const id = await gap('tenable', 'list-p', 'miss', 'cal dorn', 'p3', 'Cal Dorn');
    const ctx = (await claim('tenable')).gaps.find((g) => g.id === id)!.context;
    expect(ctx.slots).toEqual([
      { rank: 1, id: 'p1', name: 'Aro Bandel', value: 120, unit: 'goals' },
      { rank: 2, id: 'p2', name: 'Wim Xell', value: 90, unit: 'goals' },
    ]);
    expect(ctx.people).toEqual([{ id: 'p3', name: 'Cal Dorn', onList: false }]);
    // The board's own rule (ties, what counts) decides what belongs on it.
    expect(ctx.note).toBe('Ties share a place.');
  });

  it('managers and nations are named from the list\'s entity release; no note is null', async () => {
    await sql`INSERT INTO tenable_entities (release_id, kind, eid, name, known, fame) VALUES ('ten-1', 'manager', 'm1', 'Invented Boss', 'Boss', 40), ('ten-1', 'nation', 'n1', 'Invented Land', 'Land', 40)`;
    await sql`INSERT INTO tenable_days (day, list) VALUES
      ('2026-11-13', ${sql.json({ ...CLUB_LIST, id: 'list-m', kind: 'manager', slots: [{ eid: 'm1', figure: { value: 3, unit: 'titles' } }] })}),
      ('2026-11-14', ${sql.json({ ...CLUB_LIST, id: 'list-n', kind: 'nation', slots: [{ eid: 'n1', figure: { value: 2, unit: 'titles' } }] })})`;
    const m = await gap('tenable', 'list-m', 'miss', 'boss', 'm1', 'Boss');
    const n = await gap('tenable', 'list-n', 'miss', 'land', 'n1', 'Land');
    const gaps = (await claim('tenable')).gaps;
    const ctxM = gaps.find((g) => g.id === m)!.context;
    expect(ctxM.slots[0].name).toBe('Invented Boss');
    expect(ctxM.note).toBeNull();
    expect(gaps.find((g) => g.id === n)!.context.slots[0].name).toBe('Invented Land');
  });

  it('a board stored without a slots array still gives a context (empty slots), so the claim batch goes through', async () => {
    await sql`INSERT INTO tenable_days (day, list) VALUES ('2026-11-15', ${sql.json({ ...PLAYER_LIST, id: 'list-broken', slots: null })})`;
    const broken = await gap('tenable', 'list-broken', 'miss', 'cal dorn', 'p3', 'Cal Dorn');
    const fine = await gap('tenable', 'list-p', 'miss', 'aro', 'p1', 'Aro');
    const gaps = (await claim('tenable')).gaps;
    expect(gaps.find((g) => g.id === broken)!.context).toMatchObject({ slots: [], people: [{ id: 'p3', onList: false }] });
    expect(gaps.find((g) => g.id === fine)!.context.slots).toHaveLength(2);
  });

  it('a wrong board is closed with a reason Romero picks up ("question wrong…")', async () => {
    const [{ i }] = await sql`SELECT instructions AS i FROM hq.members WHERE slug = 'answer-gap-monitor'`;
    expect(i).toContain('wontfix with reason "question wrong: board');
    expect(i).not.toContain('reason "board wrong"');
  });

  it('club, manager and nation lists take their names from the list\'s entity release', async () => {
    const id = await gap('tenable', 'list-c', 'ambiguous', 'rovers', null, 'Rovers');
    await sql`UPDATE content_gaps SET candidate_ids = ${['c2', 'c1']} WHERE id = ${id}`;
    const ctx = (await claim('tenable')).gaps.find((g) => g.id === id)!.context;
    expect(ctx.slots).toEqual([{ rank: 1, id: 'c1', name: 'Invented United', value: 7, unit: 'titles' }]);
    expect(ctx.people).toEqual([{ id: 'c2', name: 'Other Rovers', onList: false }, { id: 'c1', name: 'Invented United', onList: true }]);
  });

  it('a stats verification must name its cut-off: none is refused (the Verifier retries), the same one verifies, another is held', async () => {
    const id = await gap('darts501', 'cat-x', 'uncovered', 'wim xell', 'p2', 'Wim Xell');
    const stats = { pid: 'p2', asOf: '2026-11-09', leagues: [{ league: 'LaLiga', club: 'Club Y', apps: 12, goals: 0 }] };
    const c = await claim('darts501');
    const g = c.gaps.find((x) => x.id === id)!;
    const [{ r }] = await sql<[{ r: { fixId: number } }]>`
      SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[id]}::bigint[], 'stats', ${sql.json(stats)},
        ${sql.json([{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'Club Y 12 (0)' }])}, ${sql.json({ [id]: g.contextHash })}) AS r`;
    const v = await vclaim();
    await expect(verify(v.token, r.fixId, { pid: 'p2', leagues: stats.leagues }, TWO_PUBLISHERS)).rejects.toThrow(/asOf is required/);
    expect((await sql`SELECT status FROM content_gap_fixes WHERE id = ${r.fixId}`)[0].status).toBe('proposed');
    expect(await verify(v.token, r.fixId, { pid: 'p2', asOf: '2026-11-09', leagues: stats.leagues }, TWO_PUBLISHERS)).toMatchObject({ status: 'verified', checks: { matches: true } });

    await sql`UPDATE content_gap_fixes SET status = 'proposed', verifier = NULL WHERE id = ${r.fixId}`;
    await sql`UPDATE content_gaps SET status = 'proposed' WHERE id = ${id}`;
    const v2 = await vclaim();
    expect(await verify(v2.token, r.fixId, { pid: 'p2', asOf: '2026-10-01', leagues: stats.leagues }, TWO_PUBLISHERS)).toMatchObject({ status: 'held', checks: { matches: false } });
  });

  it('an alias still needs two publishers, even for someone on the board: Wikipedia plus Wikidata is one', async () => {
    const id = await gap('tenable', 'list-p', 'unknown', 'w xell', null, 'W. Xell');
    const fixId = await proposeAlias(id, 'W. Xell');
    let v = await vclaim();
    expect(await verify(v.token, fixId, { entityId: 'p2', locale: 'en', text: 'W. Xell' }, ONE_PUBLISHER))
      .toMatchObject({ status: 'held', checks: { publishers: 1, matches: true } });
    await sql`UPDATE content_gap_fixes SET status = 'proposed', verifier = NULL WHERE id = ${fixId}`;
    await sql`UPDATE content_gaps SET status = 'proposed' WHERE id = ${id}`;
    v = await vclaim();
    expect(await verify(v.token, fixId, { entityId: 'p2', locale: 'en', text: 'W. Xell' }, TWO_PUBLISHERS)).toMatchObject({ status: 'verified' });
  });

  it('Tenable gaps leased when the migration runs go back to the queue at once, without costing an attempt; others keep their lease', async () => {
    expect(leasedAfter).toEqual([
      { game: 'tenable', status: 'open', attempts: 3, ready: true, lease_owner: null, audits: 1 },
      { game: 'darts501', status: 'checking', attempts: 1, ready: true, lease_owner: 'fixer:run-0', audits: 0 },
    ]);
  });
});
