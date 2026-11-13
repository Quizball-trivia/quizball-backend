import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: the Content Fixer's backoff, claim-by-name and Romero's triage of held work, e.g.
 *   CONTENT_FIXER_UNSTICK_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/quizball_content_fixer_test_unstick
 * Invented footballers only: the repository is public.
 */
const url = process.env.CONTENT_FIXER_UNSTICK_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_content_fixer_test[a-z0-9_]*$/.test(url)) throw new Error('Isolated local test database required');

const MIGRATIONS = ['20261110160000_content_gaps.sql', '20261110234000_hq_answer_gaps.sql', '20261110235000_content_fixer.sql',
  '20261113150000_content_fixer_grid.sql', '20261113160000_content_fixer_unstick.sql'];
const STANDINS = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS hq;
  CREATE TABLE IF NOT EXISTS hq.members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, kind text, name text, title text,
    avatar text, color text, description text, tools text[] NOT NULL DEFAULT '{}', instructions text, department text, status text DEFAULT 'active', updated_at timestamptz);
  CREATE TABLE IF NOT EXISTS hq.schedules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, name text, cron text, timezone text, task_title text, task_body text, task_kind text DEFAULT 'task', enabled boolean DEFAULT true);
  INSERT INTO hq.members (slug, kind, name, tools, instructions) VALUES ('director', 'agent', 'Romero', '{metrics}', 'x');
  CREATE TABLE IF NOT EXISTS public.wordgame_players (release_id text, pid text, name text, game_name text, fame int, aliases text[]);
  CREATE TABLE IF NOT EXISTS public.darts501_days (day date PRIMARY KEY, category jsonb NOT NULL);
  CREATE TABLE IF NOT EXISTS public.darts501_coverage (coverage_id text, pid text, PRIMARY KEY (coverage_id, pid));
  CREATE TABLE IF NOT EXISTS public.room_pool (game text, item_id text, payload jsonb, enabled boolean DEFAULT true);
  CREATE TABLE IF NOT EXISTS public.tenable_days (day date PRIMARY KEY, list jsonb NOT NULL);
  GRANT USAGE ON SCHEMA hq, public TO service_role, anon, authenticated;
`;

const LIST = { id: 'list-1', kind: 'player', release: 'rel-1', asOf: '2026-11-09', title: { en: 'Invented list' } };
const evidence = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'Aro Bandel, also written Arro Bandel' }];
const two = [{ url: 'https://en.wikipedia.org/wiki/Invented', quote: 'Arro Bandel' }, { url: 'https://www.transfermarkt.com/x', quote: 'Arro Bandel' }];

describe.skipIf(!url)('content fixer, unstuck (real PostgreSQL)', () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => undefined });
    await sql.unsafe('DROP SCHEMA IF EXISTS hq CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await sql.unsafe(STANDINS);
    // The old instructions text the migration rewrites, and the two schedules it speeds up.
    await sql`INSERT INTO hq.members (slug, kind, name, tools, instructions) VALUES ('answer-gap-monitor', 'agent', 'Fixer', '{}', 'old'), ('content-verifier', 'agent', 'Verifier', '{}', 'old')`;
    for (const file of MIGRATIONS) {
      const body = readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8');
      if (file.includes('unstick')) {
        await sql`INSERT INTO hq.schedules (member_id, cron, task_title) SELECT id, '0 */3 * * *', 'Work the content-gap queue' FROM hq.members WHERE slug = 'answer-gap-monitor'`;
        await sql`INSERT INTO hq.schedules (member_id, cron, task_title) SELECT id, '30 1-23/3 * * *', 'Verify proposed fixes' FROM hq.members WHERE slug = 'content-verifier'`;
      }
      await sql.begin((tx) => tx.unsafe(body));
    }
  });
  afterAll(async () => { await sql?.end(); });
  beforeEach(async () => {
    await sql`TRUNCATE content_gaps, content_gap_samples, content_gap_fixes, tenable_days, wordgame_players RESTART IDENTITY CASCADE`;
    await sql`INSERT INTO tenable_days (day, list) VALUES ('2026-11-12', ${sql.json(LIST)}), ('2026-11-13', ${sql.json({ ...LIST, id: 'list-2' })})`;
    await sql`INSERT INTO wordgame_players (release_id, pid, name, fame) VALUES ('rel-1', 'p1', 'Aro Bandel', 60)`;
    // "arro bandel" typed on two lists (5 + 4), "zed" once (9), "quil" (3).
    await sql`
      INSERT INTO content_gaps (game, mode, board_key, context_fp, verdict, norm, resolved_id, count) VALUES
        ('tenable', 'daily', 'list-1', 'c', 'unknown', 'arro bandel', NULL, 5),
        ('tenable', 'daily', 'list-2', 'c', 'unknown', 'arro bandel', NULL, 4),
        ('tenable', 'daily', 'list-1', 'c', 'unknown', 'zed', NULL, 8),
        ('tenable', 'daily', 'list-2', 'c', 'unknown', 'quil', NULL, 3)
    `;
  });

  type Gap = { id: number; name: string; nameTyped: number; attempts: number; contextHash: string };
  const claim = async (owner: string, limit = 10) =>
    (await sql<[{ c: { token: string; gaps: Gap[] } }]>`SELECT hq.content_gaps_claim(${owner}, ${limit}, 60, 'tenable') AS c`)[0].c;
  const release = (owner: string, token: string) => sql`SELECT hq.content_gaps_release(${owner}, ${token}::uuid)`;
  const due = (ids: number[]) => sql`UPDATE content_gaps SET next_try_at = now() - interval '1 second' WHERE id = ANY(${ids}::bigint[])`;
  const gap = async (id: number) => (await sql`SELECT status, attempts, next_try_at, audit FROM content_gaps WHERE id = ${id}`)[0];
  const decide = (fix: number | null, gaps: number[] | null, action: string, reason = 'checked the sources') =>
    sql`SELECT hq.content_held_decide('director:run-1', ${fix}, ${gaps}::bigint[], ${action}, ${reason}) AS r`;

  it('claims the most-typed names first, with every board each name was typed on', async () => {
    const c = await claim('fixer:run-1', 3);
    // "arro bandel" (9 over two lists) ranks with "zed" (8); both lists of the first come together.
    expect(c.gaps.map((g) => [g.name, g.nameTyped])).toEqual([['arro bandel', 9], ['arro bandel', 9], ['zed', 8]]);
  });

  it('a gap given back unused waits 6 h, then 1 d, then 3 d; the fourth time it goes to Romero or is closed', async () => {
    const waits: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      await due([1, 3]);
      const c = await claim(`fixer:run-${i}`);
      expect(c.gaps.map((g) => g.id)).toEqual(expect.arrayContaining([1, 3]));
      await release(`fixer:run-${i}`, c.token);
      const [w] = await sql`SELECT round(extract(epoch FROM next_try_at - now()) / 3600) AS h FROM content_gaps WHERE id = 1`;
      waits.push(String(w.h));
    }
    expect(waits).toEqual(['6', '24', '72', 'null']);
    // Typed 5 times: closed; typed 8 times: the same (Romero sees only names typed 10+ times).
    expect(await gap(1)).toMatchObject({ status: 'wontfix', attempts: 4 });
    await sql`UPDATE content_gaps SET count = 12 WHERE id = 2`;
    await sql`UPDATE content_gaps SET attempts = 3 WHERE id = 2`;
    await due([2]);
    const c = await claim('fixer:run-9');
    await release('fixer:run-9', c.token);
    const g2 = await gap(2);
    expect(g2.status).toBe('held');
    expect(g2.audit.at(-1)).toMatchObject({ actor: 'system', to: 'held', reason: 'unresolved after 4 tries' });
  });

  it('a lease that expired (crashed run) counts as a try too', async () => {
    const c = await claim('fixer:crashed');
    expect(c.gaps.length).toBeGreaterThan(0);
    await sql`UPDATE content_gaps SET lease_until = now() - interval '1 minute' WHERE status = 'checking'`;
    const again = await claim('fixer:next');
    expect(again.gaps).toEqual([]);
    expect(await gap(1)).toMatchObject({ status: 'open', attempts: 1 });
  });

  it('a fix the verifier disagrees with sends its gaps back with one try counted', async () => {
    const c = await claim('fixer:run-1');
    const g = c.gaps.find((x) => x.id === 1)!;
    const [{ r }] = await sql<[{ r: { fixId: number } }]>`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'alias',
      ${sql.json({ entityId: 'p1', locale: 'en', text: 'Arro Bandel' })}, ${sql.json(evidence)}, ${sql.json({ 1: g.contextHash })}) AS r`;
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-1', 5, 60) AS c`)[0].c;
    await sql`SELECT hq.content_fix_verify('verifier:run-1', ${v.token}::uuid, ${r.fixId}, 'disagree', ${sql.json({ entityId: 'p1', locale: 'en', text: 'Aro Bandel' })}, ${sql.json(two)})`;
    expect(await gap(1)).toMatchObject({ status: 'open', attempts: 1 });
  });

  it('Romero lists held fixes and gaps, and can only reverify, park, reject or reopen, never verify', async () => {
    const c = await claim('fixer:run-1');
    const g = c.gaps.find((x) => x.id === 1)!;
    const [{ r }] = await sql<[{ r: { fixId: number } }]>`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[1]}::bigint[], 'alias',
      ${sql.json({ entityId: 'p1', locale: 'en', text: 'Arro Bandel' })}, ${sql.json(evidence)}, ${sql.json({ 1: g.contextHash })}) AS r`;
    const v = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-1', 5, 60) AS c`)[0].c;
    // Agrees, but from one publisher only: held.
    await sql`SELECT hq.content_fix_verify('verifier:run-1', ${v.token}::uuid, ${r.fixId}, 'agree', ${sql.json({ entityId: 'p1', locale: 'en', text: 'Arro Bandel' })}, ${sql.json([two[0]])})`;
    const [{ h }] = await sql`SELECT hq.content_held(10) AS h`;
    expect(h).toMatchObject({ fixesHeld: 1, fixes: [{ id: r.fixId, kind: 'alias', verifier: { verdict: 'agree', checks: { publishers: 1, matches: true } } }] });

    await expect(decide(r.fixId, null, 'verify')).rejects.toThrow(/reverify, park, reject or reopen/);
    await expect(decide(r.fixId, null, 'reverify', 'x')).rejects.toThrow(/reason is required/);
    await decide(r.fixId, null, 'reverify');
    expect((await sql`SELECT status FROM content_gap_fixes WHERE id = ${r.fixId}`)[0].status).toBe('proposed');
    expect((await gap(1)).status).toBe('proposed');
    // Verified only through the verifier, from two publishers.
    const v2 = (await sql<[{ c: { token: string } }]>`SELECT hq.content_fixes_claim('verifier:run-2', 5, 60) AS c`)[0].c;
    const [{ out }] = await sql`SELECT hq.content_fix_verify('verifier:run-2', ${v2.token}::uuid, ${r.fixId}, 'agree', ${sql.json({ entityId: 'p1', locale: 'en', text: 'Arro Bandel' })}, ${sql.json(two)}) AS out`;
    expect(out.status).toBe('verified');
    await expect(decide(r.fixId, null, 'reject')).rejects.toThrow(/is not held/);
  });

  it('reverify at most twice and only for kinds the verifier checks; park takes a fix off the list; reopen/reject move its gaps', async () => {
    const c = await claim('fixer:run-1');
    const hash = (id: number) => c.gaps.find((x) => x.id === id)!.contextHash;
    const [{ r: accepted }] = await sql<[{ r: { fixId: number; status: string } }]>`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[3]}::bigint[], 'accepted',
      ${sql.json({ text: 'Zed', why: 'on the list' })}, ${sql.json(evidence)}, ${sql.json({ 3: hash(3) })}) AS r`;
    expect(accepted.status).toBe('held');
    await expect(decide(accepted.fixId, null, 'reverify')).rejects.toThrow(/cannot check a accepted fix/);
    await decide(accepted.fixId, null, 'park', 'right, waiting for a Tenable publisher');
    const [{ h }] = await sql`SELECT hq.content_held(10) AS h`;
    expect(h).toMatchObject({ fixesHeld: 0, fixesParked: 1, fixes: [] });
    await expect(decide(accepted.fixId, null, 'park')).rejects.toThrow(/already parked/);

    const [{ r: other }] = await sql<[{ r: { fixId: number } }]>`SELECT hq.content_gap_propose('fixer:run-1', ${c.token}::uuid, ${[4]}::bigint[], 'needs_entity',
      ${sql.json({ name: 'Quil' })}, ${sql.json(evidence)}, ${sql.json({ 4: hash(4) })}) AS r`;
    await decide(other.fixId, null, 'reopen', 'wrong person, try again');
    // Reopened by Romero: open and claimable now, no try counted.
    expect(await gap(4)).toMatchObject({ status: 'open', attempts: 0, next_try_at: null });
    expect((await sql`SELECT status FROM content_gap_fixes WHERE id = ${other.fixId}`)[0].status).toBe('rejected');
  });

  it('held gaps with no fix: reopen gives one more try, close sets the status; fixes are decided by fix id', async () => {
    await sql`UPDATE content_gaps SET status = 'held', attempts = 4 WHERE id IN (3, 4)`;
    const [{ h }] = await sql`SELECT hq.content_held(10) AS h`;
    expect(h.gapsHeld).toBe(2);
    await expect(decide(null, [3, 1], 'reopen')).rejects.toThrow(/held with no fix/);
    await expect(decide(5, [3], 'reopen')).rejects.toThrow(/not both/);
    await decide(null, [3], 'reopen', 'worth one more look');
    expect(await gap(3)).toMatchObject({ status: 'open', attempts: 3, next_try_at: null });
    await decide(null, [4], 'junk', 'not a footballer');
    expect(await gap(4)).toMatchObject({ status: 'junk' });
    expect((await gap(4)).audit.at(-1)).toMatchObject({ actor: 'director:run-1', action: 'junk', from: 'held', to: 'junk' });
  });

  it('rewrites the instructions and runs both hourly; only the service role runs the new functions', async () => {
    const crons = await sql`SELECT task_title, cron FROM hq.schedules WHERE task_title IN ('Work the content-gap queue', 'Verify proposed fixes') ORDER BY task_title`;
    expect(crons.map((r) => r.cron)).toEqual(expect.arrayContaining(['0 * * * *', '30 * * * *']));
    expect(crons.every((r) => ['0 * * * *', '30 * * * *'].includes(r.cron))).toBe(true);
    expect((await sql`SELECT instructions FROM hq.members WHERE slug = 'answer-gap-monitor'`)[0].instructions).toContain('UNRESOLVED NAMES:');
    for (const role of ['anon', 'authenticated']) {
      await expect(sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await tx`SELECT hq.content_held(5)`; })).rejects.toThrow(/permission denied/);
    }
    await sql.begin(async (tx) => { await tx.unsafe('SET LOCAL ROLE service_role'); await tx`SELECT hq.content_held(5)`; });
  });
});
