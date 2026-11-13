import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: the content fixer on Football Grid cells (context → membership / alias → verify) on a
 * throwaway database holding stand-ins of the Grid content tables, e.g.
 *   CONTENT_FIXER_GRID_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_fixer_test_grid
 * Invented clubs and footballers only: the repository is public.
 */
const url = process.env.CONTENT_FIXER_GRID_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_fixer_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const MIGRATIONS = ['20261110160000_content_gaps.sql', '20261110234000_hq_answer_gaps.sql', '20261110235000_content_fixer.sql', '20261113150000_content_fixer_grid.sql'];
const STANDINS = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS hq;
  CREATE TABLE IF NOT EXISTS hq.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, kind text, name text, title text,
    avatar text, color text, description text, tools text[] NOT NULL DEFAULT '{}', instructions text, department text, status text DEFAULT 'active', updated_at timestamptz);
  CREATE TABLE IF NOT EXISTS hq.schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, name text, cron text, timezone text, task_title text, task_body text, task_kind text DEFAULT 'task', enabled boolean DEFAULT true);
  INSERT INTO hq.members (slug, kind, name, instructions) VALUES ('answer-gap-monitor', 'agent', 'Answer Gap Monitor', 'old');
  CREATE TABLE IF NOT EXISTS public.wordgame_players (release_id text, pid text, name text, game_name text, fame int, aliases text[]);
  CREATE TABLE IF NOT EXISTS public.darts501_days (day date PRIMARY KEY, category jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.darts501_coverage (coverage_id text, pid text, PRIMARY KEY (coverage_id, pid));
  CREATE TABLE IF NOT EXISTS public.room_pool (game text, item_id text, payload jsonb, enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.tenable_days (day date PRIMARY KEY, list jsonb NOT NULL);
  CREATE TABLE public.football_players (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.football_grid_content_releases (id uuid PRIMARY KEY, version integer NOT NULL UNIQUE, status text NOT NULL);
  CREATE TABLE public.football_grid_criteria (id uuid PRIMARY KEY, release_id uuid NOT NULL, criterion_key text NOT NULL, label_en text NOT NULL);
  CREATE TABLE public.football_grid_criterion_memberships (release_id uuid NOT NULL, criterion_id uuid NOT NULL, football_player_id uuid NOT NULL);
  CREATE TABLE public.football_grid_boards (id uuid PRIMARY KEY, release_id uuid NOT NULL, row_criteria uuid[] NOT NULL, column_criteria uuid[] NOT NULL);
  CREATE TABLE public.football_grid_board_answers (board_id uuid, release_id uuid, cell_index smallint, football_player_id uuid);
  GRANT USAGE ON SCHEMA hq, public TO service_role, anon, authenticated;
`;

const REL = '00000000-0000-4000-8000-000000000001';
const NEWER = '00000000-0000-4000-8000-000000000002';
const BOARD = '00000000-0000-4000-8000-0000000000b1';
const P_KNOWN = '00000000-0000-4000-8000-0000000000a1'; // right for cell 0
const P_HALF = '00000000-0000-4000-8000-0000000000a2'; // in the row club only
const P_NONE = '00000000-0000-4000-8000-0000000000a3'; // in neither
const crit = (n: number) => `00000000-0000-4000-8000-0000000000c${n}`;
const evidence = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'He joined Club Vale in 2010' }];
const two = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'Club Vale 2010-2012' }, { url: 'https://www.transfermarkt.com/x', quote: 'Club Vale 31 apps' }];

describe.skipIf(!url)('content fixer on Football Grid (real PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined });
    await sql.unsafe('DROP SCHEMA IF EXISTS hq CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await sql.unsafe(STANDINS);
    for (const file of MIGRATIONS) {
      const body = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
      await sql.begin((tx) => tx.unsafe(body));
    }
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`TRUNCATE content_gaps, content_gap_samples, content_gap_fixes, football_players, football_grid_content_releases, football_grid_criteria,
      football_grid_criterion_memberships, football_grid_boards, football_grid_board_answers RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO football_grid_content_releases VALUES (${REL}, 1, 'published'), (${NEWER}, 2, 'draft')`;
    // Row 0: club:vale, column 0: club:moor (and filler keys for the other rows/columns).
    await sql`INSERT INTO football_grid_criteria VALUES
      (${crit(1)}, ${REL}, 'club:vale', 'Club Vale'), (${crit(2)}, ${REL}, 'club:moor', 'Club Moor'),
      (${crit(3)}, ${REL}, 'club:a', 'A'), (${crit(4)}, ${REL}, 'club:b', 'B'), (${crit(5)}, ${REL}, 'club:c', 'C'), (${crit(6)}, ${REL}, 'club:d', 'D')`;
    await sql`INSERT INTO football_grid_boards VALUES (${BOARD}, ${REL}, ${[crit(1), crit(3), crit(4)]}::uuid[], ${[crit(2), crit(5), crit(6)]}::uuid[])`;
    await sql`INSERT INTO football_players VALUES (${P_KNOWN}, 'Aro Bandel'), (${P_HALF}, 'Wim Xell'), (${P_NONE}, 'Tod Quarm')`;
    await sql`INSERT INTO football_grid_criterion_memberships VALUES
      (${REL}, ${crit(1)}, ${P_KNOWN}), (${REL}, ${crit(2)}, ${P_KNOWN}), (${REL}, ${crit(1)}, ${P_HALF})`;
    await sql`INSERT INTO football_grid_board_answers VALUES (${BOARD}, ${REL}, 0, ${P_KNOWN})`;
    await sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, resolved_id, candidate_ids, count) VALUES
        ('football_grid', 'realtime', ${`${BOARD}#0`}, 'c', 'miss', 'wim xell', ${P_HALF}, ${[P_HALF]}, 9),
        ('football_grid', 'realtime', ${`${BOARD}#0`}, 'c', 'miss', 'tod quarm', ${P_NONE}, ${[P_NONE]}, 5),
        ('grid_daily', 'daily', ${`${BOARD}#0`}, 'c', 'unknown', 'bandle', NULL, NULL, 3),
        ('grid_daily', 'daily', 'club:vale|club:moor', ${BOARD}, 'reported', 'wim xell', ${P_HALF}, NULL, 1),
        ('grid_daily', 'daily', ${`${BOARD}#0`}, 'c', 'unknown', 'd qoa', NULL, NULL, 2)
    `;
    await sql`INSERT INTO content_gap_samples (gap_id, locale, typed) VALUES (3, 'en', 'Bandle'), (5, 'en', ${"D'Qoa"})`;
  });

  type Claimed = { id: number; context: Record<string, any>; contextHash: string };
  const claim = async (game: string, owner = 'fixer:run-1') =>
    (await sql<[{ c: { token: string; gaps: Claimed[] } }]>`SELECT hq.content_gaps_claim(${owner}, 10, 60, ${game}) AS c`)[0].c;
  const propose = (owner: string, token: string, ids: number[], kind: string, payload: unknown, hashes: Record<number, string>) =>
    sql<[{ r: { fixId: number; status: string } }]>`SELECT hq.content_gap_propose(${owner}, ${token}::uuid, ${ids}::bigint[], ${kind}, ${sql.json(payload as never)}, ${sql.json(evidence)}, ${sql.json(hashes as never)}) AS r`;

  it('a played cell resolves to its two criteria and, per person, what a published release already holds', async () => {
    const c = await claim('football_grid');
    const half = c.gaps.find((g) => g.id === 1)!;
    expect(half.context).toMatchObject({
      found: true, boardId: BOARD, cell: 0, rowKey: 'club:vale', columnKey: 'club:moor', rowLabel: 'Club Vale', columnLabel: 'Club Moor',
      cellAnswers: 1, latestRelease: 1, people: [{ id: P_HALF, name: 'Wim Xell', known: true, inRow: true, inColumn: false, onBoard: false }],
    });
    expect(half.context.contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a report keyed by the criterion pair resolves too; an unknown key is not found', async () => {
    const r = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('grid_daily', 'club:vale|club:moor', ${P_HALF}, NULL, NULL) AS c`)[0].c;
    expect(r).toMatchObject({ found: true, boardId: null, rowKey: 'club:vale', columnKey: 'club:moor', people: [{ id: P_HALF, inRow: true, inColumn: false }] });
    const missing = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('grid_daily', 'club:x|club:y', NULL, NULL, NULL) AS c`)[0].c;
    expect(missing.found).toBe(false);
    const half = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('grid_daily', 'club:vale|club:missing', NULL, NULL, NULL) AS c`)[0].c;
    expect(half.found).toBe(false);
    const junk = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('football_grid', ${`${BOARD}#9`}, NULL, NULL, NULL) AS c`)[0].c;
    expect(junk.found).toBe(false);
  });

  it('a Grid membership names exactly the criteria the footballer lacks, and goes to the verifier (not a person)', async () => {
    const c = await claim('football_grid');
    const g1 = c.gaps.find((g) => g.id === 1)!;
    const call = (payload: unknown) => propose('fixer:run-1', c.token, [1], 'membership', payload, { 1: g1.contextHash });
    await expect(call({ pid: P_HALF, criterionKeys: ['club:vale', 'club:moor'], fact: 'Played for Club Moor 2012-2014' })).rejects.toThrow(/exactly the cell's criteria/);
    await expect(call({ pid: P_HALF, criterionKeys: ['club:other'], fact: 'Played for Club Moor 2012-2014' })).rejects.toThrow(/keys of this cell/);
    await expect(call({ pid: P_NONE, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' })).rejects.toThrow(/context.people/);
    await expect(call({ pid: P_HALF, criterionKeys: ['club:moor'], fact: 'short' })).rejects.toThrow(/needs fact/);
    const [{ r }] = await call({ pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014', extra: 'dropped' });
    expect(r.status).toBe('proposed');
    const [fix] = await sql`SELECT payload FROM content_gap_fixes WHERE id = ${r.fixId}`;
    expect(fix.payload).toEqual({ pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' });

    // Missing both facts: both keys, never one.
    const g2 = c.gaps.find((g) => g.id === 2)!;
    await expect(propose('fixer:run-1', c.token, [2], 'membership', { pid: P_NONE, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' }, { 2: g2.contextHash }))
      .rejects.toThrow(/exactly the cell's criteria/);
    const [{ r: r2 }] = await propose('fixer:run-1', c.token, [2], 'membership', { pid: P_NONE, criterionKeys: ['club:vale', 'club:moor'], fact: 'Club Vale 2009, Club Moor 2012' }, { 2: g2.contextHash });
    expect(r2.status).toBe('proposed');
  });

  it('the verifier confirms the same footballer and the same criteria from two publishers; anything else is held', async () => {
    const c = await claim('football_grid');
    const g1 = c.gaps.find((g) => g.id === 1)!;
    const [{ r }] = await propose('fixer:run-1', c.token, [1], 'membership', { pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' }, { 1: g1.contextHash });
    const verifyWith = async (extracted: unknown) => {
      const v = (await sql<[{ c: { token: string; fixes: Array<{ id: number; claim: unknown }> } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
      expect(v.fixes[0].claim).toEqual({ pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' });
      return (await sql<[{ r: { status: string } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${r.fixId}, 'agree', ${sql.json(extracted as never)}, ${sql.json(two)}) AS r`)[0].r;
    };
    expect((await verifyWith({ pid: P_HALF, criterionKeys: ['club:moor'] })).status).toBe('verified');
    const [gap] = await sql`SELECT status FROM content_gaps WHERE id = 1`;
    expect(gap.status).toBe('verified');
  });

  it('a different criterion from the verifier is held', async () => {
    const c = await claim('football_grid');
    const g2 = c.gaps.find((g) => g.id === 2)!;
    const [{ r }] = await propose('fixer:run-1', c.token, [2], 'membership', { pid: P_NONE, criterionKeys: ['club:moor', 'club:vale'], fact: 'Club Vale 2009, Club Moor 2012' }, { 2: g2.contextHash });
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-9', 5, 60) AS c`)[0].c;
    const [{ r: out }] = await sql<[{ r: { status: string } }]>`SELECT hq.content_fix_verify('verifier:run-9', ${v.token}::uuid, ${r.fixId}, 'agree', ${sql.json({ pid: P_NONE, criterionKeys: ['club:vale'] })}, ${sql.json(two)}) AS r`;
    expect(out.status).toBe('held');
  });

  it('a Grid alias must name a footballer already right for the cell', async () => {
    const c = await claim('grid_daily');
    const g = c.gaps.find((x) => x.id === 3)!;
    await expect(propose('fixer:run-1', c.token, [3], 'alias', { entityId: P_HALF, locale: 'en', text: 'Bandle' }, { 3: g.contextHash })).rejects.toThrow(/already right for this cell/);
    await expect(propose('fixer:run-1', c.token, [3], 'alias', { entityId: P_KNOWN, locale: 'en', text: 'Bandel A' }, { 3: g.contextHash })).rejects.toThrow(/typed text of every gap/);
    const [{ r }] = await propose('fixer:run-1', c.token, [3], 'alias', { entityId: P_KNOWN, locale: 'en', text: 'Bandle' }, { 3: g.contextHash });
    expect(r.status).toBe('proposed');
    // Typed with an apostrophe (recorded as "d qoa"): the exact spelling is accepted.
    const g5 = c.gaps.find((x) => x.id === 5)!;
    const [{ r: r5 }] = await propose('fixer:run-1', c.token, [5], 'alias', { entityId: P_KNOWN, locale: 'en', text: "D'Qoa" }, { 5: g5.contextHash });
    expect(r5.status).toBe('proposed');
  });

  it('a membership published in between changes the hash, so the stale proposal is refused', async () => {
    const c = await claim('football_grid');
    const g1 = c.gaps.find((g) => g.id === 1)!;
    await sql`UPDATE football_grid_content_releases SET status = 'published' WHERE id = ${NEWER}`;
    await sql`INSERT INTO football_grid_criteria VALUES (${crit(7)}, ${NEWER}, 'club:moor', 'Club Moor')`;
    await sql`INSERT INTO football_grid_criterion_memberships VALUES (${NEWER}, ${crit(7)}, ${P_HALF})`;
    await expect(propose('fixer:run-1', c.token, [1], 'membership', { pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' }, { 1: g1.contextHash }))
      .rejects.toThrow(/board changed/);
    // Row fact in release 1, column fact only in release 2 (which lacks the row criterion): no single release makes him
    // right for the cell, so it is not "already published".
    const fresh = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('football_grid', ${`${BOARD}#0`}, ${P_HALF}, NULL, NULL) AS c`)[0].c;
    expect(fresh).toMatchObject({ targetRelease: 1, latestRelease: 2 });
    expect(fresh.people[0]).toMatchObject({ inRow: true, inColumn: false, onBoard: false });
  });

  it('flags are read in the newest release holding both criteria; facts split across releases are not enough', async () => {
    await sql`UPDATE football_grid_content_releases SET status = 'published' WHERE id = ${NEWER}`;
    await sql`INSERT INTO football_grid_criteria VALUES (${crit(7)}, ${NEWER}, 'club:moor', 'Club Moor'), (${crit(8)}, ${NEWER}, 'club:vale', 'Club Vale')`;
    // Newer release: Wim Xell only at Club Moor (his Club Vale fact is only in release 1).
    await sql`INSERT INTO football_grid_criterion_memberships VALUES (${NEWER}, ${crit(7)}, ${P_HALF}), (${NEWER}, ${crit(7)}, ${P_KNOWN}), (${NEWER}, ${crit(8)}, ${P_KNOWN})`;
    const ctx = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('football_grid', ${`${BOARD}#0`}, ${P_HALF}, NULL, NULL) AS c`)[0].c;
    expect(ctx).toMatchObject({ targetRelease: 2, people: [{ id: P_HALF, inRow: false, inColumn: true }] });
    const c = await claim('football_grid');
    const g1 = c.gaps.find((g) => g.id === 1)!;
    await expect(propose('fixer:run-1', c.token, [1], 'membership', { pid: P_HALF, criterionKeys: ['club:moor'], fact: 'Played for Club Moor 2012-2014' }, { 1: g1.contextHash }))
      .rejects.toThrow(/exactly the cell's criteria/);
    const [{ r }] = await propose('fixer:run-1', c.token, [1], 'membership', { pid: P_HALF, criterionKeys: ['club:vale'], fact: 'Played for Club Vale 2010-2012' }, { 1: g1.contextHash });
    expect(r.status).toBe('proposed');
    // An alias for him is refused: he is not right for the cell in one release.
    const d = await claim('grid_daily');
    const g3 = d.gaps.find((x) => x.id === 3)!;
    await expect(propose('fixer:run-1', d.token, [3], 'alias', { entityId: P_HALF, locale: 'en', text: 'Bandle' }, { 3: g3.contextHash })).rejects.toThrow(/already right for this cell/);
  });

  it('a membership is refused when no published release holds both criteria', async () => {
    await sql`DELETE FROM football_grid_criteria WHERE id = ${crit(2)}`;
    await sql`UPDATE football_grid_content_releases SET status = 'published' WHERE id = ${NEWER}`;
    await sql`INSERT INTO football_grid_criteria VALUES (${crit(7)}, ${NEWER}, 'club:moor', 'Club Moor')`;
    const ctx = (await sql<[{ c: Record<string, any> }]>`SELECT hq.content_gap_context('grid_daily', 'club:vale|club:moor', ${P_HALF}, NULL, NULL) AS c`)[0].c;
    expect(ctx).toMatchObject({ found: true, targetRelease: null, people: [{ inRow: false, inColumn: false }] });
  });

  it('membership on other games still goes to a person; the instructions gained a Grid section once', async () => {
    const [m] = await sql`SELECT instructions FROM hq.members WHERE slug = 'answer-gap-monitor'`;
    expect(m.instructions.match(/FOOTBALL GRID \(games football_grid/g)).toHaveLength(1);
    const [v] = await sql`SELECT instructions FROM hq.members WHERE slug = 'content-verifier'`;
    expect(v.instructions).toContain('FOOTBALL GRID memberships');
  });
});
