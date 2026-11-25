import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { ADMIN_DATABASE, testDbOptions } from '../partners/test-db.js';

/**
 * Real PostgreSQL. Locally on an isolated clone with every migration applied:
 *   PLAY_POPULARITY_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_popularity
 * In CI on a database created from MIGRATION_TEST_DATABASE_URL and dropped afterwards, holding only the columns the
 * popularity query reads. Each test runs in one transaction that is rolled back.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres>, tx: null as unknown }));
vi.mock('../../src/db/index.js', () => ({
  get sql() { return db.sql; },
  withStatementTimeout: (run: (tx: unknown) => Promise<unknown>) => run(db.tx),
}));

const url = process.env.PLAY_POPULARITY_TEST_DATABASE_URL;
const local = url ? testDbOptions(url, /^quizball_room_test_[a-z0-9_]+$/) : null;
if (local && ![5432, 5436].includes(local.port)) throw new Error('Isolated local room test database required');
const admin = !url && process.env.MIGRATION_TEST_DATABASE_URL ? testDbOptions(process.env.MIGRATION_TEST_DATABASE_URL, ADMIN_DATABASE) : null;

const REPO_SQL = readFileSync(join(__dirname, '../../src/modules/public/play-popularity.repo.ts'), 'utf8');
const SOURCE_TABLES = [...new Set([...REPO_SQL.matchAll(/\bFROM ([a-z_0-9]+) WHERE /g)].map((m) => m[1]!))];
const FIXTURE = `
  CREATE TABLE users (id uuid PRIMARY KEY, is_ai boolean NOT NULL DEFAULT false, ai_kind text,
    is_seed boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY, token_hash text, linked_user_id uuid);
  CREATE TABLE goal_choreographies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, title jsonb, options jsonb,
    players jsonb, steps jsonb, scorer text, match_label text, year integer);
  CREATE TABLE daily_challenge_completions (user_id uuid, challenge_type text, completed_at timestamptz NOT NULL DEFAULT now());
  ${SOURCE_TABLES.filter((t) => t !== 'daily_challenge_completions').map((t) => `CREATE TABLE ${t} (
    user_id uuid, guest_id uuid, challenge_type text, created_at timestamptz NOT NULL DEFAULT now(),
    day date, content_version bigint, state jsonb, closes_at timestamptz, goal_id uuid, goal_snapshot jsonb, max_points integer);`).join('\n')}
`;

type Sql = postgres.Sql;
const ROLLBACK = new Error('rollback');

describe.skipIf(!url && !admin)('play popularity on real Postgres', () => {
  let created: { admin: Sql; database: string } | null = null;

  beforeAll(async () => {
    if (local) db.sql = postgres({ ...local, max: 1, onnotice: () => undefined });
    else {
      const database = `play_popularity_${randomUUID().replaceAll('-', '')}`;
      const adminSql = postgres({ ...admin!, max: 1, onnotice: () => undefined });
      // CREATE DATABASE copies template1 and fails while another suite is connected to it: retry.
      try {
        for (let attempt = 1; ; attempt += 1) {
          try { await adminSql.unsafe(`CREATE DATABASE "${database}"`); break; } catch (error) {
            if ((error as { code?: string }).code !== '55006' || attempt >= 10) throw error;
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          }
        }
      } catch (error) {
        await adminSql.end({ timeout: 2 });
        throw error;
      }
      created = { admin: adminSql, database };
      db.sql = postgres({ ...admin!, database, max: 1, onnotice: () => undefined });
      await db.sql.unsafe(FIXTURE);
    }
  }, 60_000);
  afterAll(async () => {
    await db.sql?.end();
    if (created) {
      await created.admin.unsafe(`DROP DATABASE IF EXISTS "${created.database}" WITH (FORCE)`);
      await created.admin.end({ timeout: 2 });
    }
  });

  async function inRollback(body: (tx: Sql) => Promise<void>) {
    await db.sql.begin('isolation level repeatable read', async (tx) => {
      db.tx = tx;
      await body(tx as unknown as Sql);
      throw ROLLBACK;
    }).catch((error: unknown) => { if (error !== ROLLBACK) throw error; });
  }

  async function member(tx: Sql, flags: { ai?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    await tx.unsafe('INSERT INTO users (id, is_ai, ai_kind) VALUES ($1, $2, $3)', [id, flags.ai ?? false, flags.ai ? 'persistent' : null]);
    return id;
  }

  async function guest(tx: Sql, linkedTo: string | null = null): Promise<string> {
    const id = randomUUID();
    await tx.unsafe('INSERT INTO guest_sessions (id, token_hash, linked_user_id) VALUES ($1, $2, $3)', [id, `hash-${id}`, linkedTo]);
    return id;
  }

  async function dailyRun(tx: Sql, table: string, owner: { user?: string; guest?: string }, daysAgo: number) {
    await tx.unsafe(
      `INSERT INTO ${table} (user_id, guest_id, day, content_version, state, closes_at, created_at)
       VALUES ($1, $2, (now() - make_interval(days => $3))::date, 1, '{}'::jsonb, now() + interval '1 day', now() - make_interval(days => $3))`,
      [owner.user ?? null, owner.guest ?? null, daysAgo],
    );
  }

  async function counts(): Promise<Record<string, { players_7d: number; players_3d: number }>> {
    const { playPopularityRepo } = await import('../../src/modules/public/play-popularity.repo.js');
    const rows = await playPopularityRepo.load();
    return Object.fromEntries(rows.map((row) => [row.game, { players_7d: row.players_7d, players_3d: row.players_3d }]));
  }

  const zero = { players_7d: 0, players_3d: 0 };
  const delta = (before: Awaited<ReturnType<typeof counts>>, after: Awaited<ReturnType<typeof counts>>, game: string) => ({
    players_7d: (after[game] ?? zero).players_7d - (before[game] ?? zero).players_7d,
    players_3d: (after[game] ?? zero).players_3d - (before[game] ?? zero).players_3d,
  });

  it('counts each game from its own table: distinct people, members and guests, guests merged into their member, bots left out', async () => {
    await inRollback(async (tx) => {
      const before = await counts();

      // Connections: one member on two days + their guest session before sign-in = 1 person; 1 old guest; 1 other member.
      const regular = await member(tx);
      await dailyRun(tx, 'conexiones_runs', { user: regular }, 1);
      await dailyRun(tx, 'conexiones_runs', { user: regular }, 2);
      await dailyRun(tx, 'conexiones_runs', { guest: await guest(tx, regular) }, 0);
      await dailyRun(tx, 'conexiones_runs', { guest: await guest(tx) }, 5);
      await dailyRun(tx, 'conexiones_runs', { user: await member(tx) }, 2);
      // Codenames: three members in the window, one outside it, a guest, and a bot.
      await dailyRun(tx, 'codenames_runs', { user: await member(tx) }, 1);
      await dailyRun(tx, 'codenames_runs', { user: await member(tx) }, 4);
      await dailyRun(tx, 'codenames_runs', { user: await member(tx) }, 6);
      await dailyRun(tx, 'codenames_runs', { user: await member(tx) }, 9);
      await dailyRun(tx, 'codenames_runs', { guest: await guest(tx) }, 2);
      await dailyRun(tx, 'codenames_runs', { user: await member(tx, { ai: true }) }, 1);
      // Odd One Out: a guest today and a member four days ago.
      await dailyRun(tx, 'dato_falso_runs', { guest: await guest(tx) }, 0);
      await dailyRun(tx, 'dato_falso_runs', { user: await member(tx) }, 4);

      const after = await counts();
      expect(delta(before, after, 'conexiones-futboleras')).toEqual({ players_7d: 3, players_3d: 2 });
      expect(delta(before, after, 'football-codenames')).toEqual({ players_7d: 4, players_3d: 2 });
      expect(delta(before, after, 'dato-falso-futbolero')).toEqual({ players_7d: 2, players_3d: 1 });
    });
  });

  it('counts members and guests who play Guess the Goal', async () => {
    await inRollback(async (tx) => {
      const before = await counts();
      const [goal] = await tx.unsafe<{ id: string }[]>(
        `INSERT INTO goal_choreographies (slug, title, options, players, steps, scorer, match_label, year)
         VALUES ($1, '{"en":"Invented goal"}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Invented Scorer', 'Invented FC v Made Up United', 2001)
         RETURNING id`,
        [`test-goal-${randomUUID()}`],
      );
      const session = (owner: { user?: string; guest?: string }) => tx.unsafe(
        `INSERT INTO guess_the_goal_sessions (user_id, guest_id, goal_id, goal_snapshot, max_points) VALUES ($1, $2, $3, '{}'::jsonb, 100)`,
        [owner.user ?? null, owner.guest ?? null, goal!.id],
      );
      await session({ guest: await guest(tx) });
      await session({ user: await member(tx) });

      expect(delta(before, await counts(), 'guess-the-goal')).toEqual({ players_7d: 2, players_3d: 2 });
    });
  });
});
