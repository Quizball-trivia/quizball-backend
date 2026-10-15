import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { ADMIN_DATABASE, testDbOptions } from '../partners/test-db.js';

/**
 * Real PostgreSQL: applies the Guess the Goal migrations in order to a fresh schema, with a member's session and solve
 * stored before the guest migration (as on prod), then runs the repo and the service against it. Locally on an
 * isolated database; in CI on a database created from MIGRATION_TEST_DATABASE_URL and dropped afterwards.
 *   GGT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_ggt_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({
  get sql() { return db.sql; },
}));
const rewards = vi.hoisted(() => ({ coins: vi.fn(), log: vi.fn(), xp: vi.fn() }));
vi.mock('../../src/modules/store/store.repo.js', () => ({
  storeRepo: { addCoinsInTx: rewards.coins, insertTransactionLogInTx: rewards.log },
}));
vi.mock('../../src/modules/progression/progression.repo.js', () => ({
  progressionRepo: { grantXpInTx: rewards.xp },
}));

const url = process.env.GGT_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:543(?:2|6)\/quizball_ggt_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local Guess the Goal test database required');
const admin = !url && process.env.MIGRATION_TEST_DATABASE_URL ? testDbOptions(process.env.MIGRATION_TEST_DATABASE_URL, ADMIN_DATABASE) : null;

const MIGRATIONS = join(__dirname, '../../supabase/migrations');
const BEFORE_GUESTS = [
  '20260819100000_guess_the_goal.sql',
  '20260819100001_guess_the_goal_validate_checks.sql',
  '20260820120000_ggt_video_links.sql',
  '20260822120000_ggt_video_clip_windows.sql',
  '20260901180000_goal_choreographies_mirrored_url.sql',
  '20260901210000_goal_featured_rank.sql',
];
const GUEST_MIGRATION = '20261015120000_guess_the_goal_guest_sessions.sql';
const FIXTURE = `
  DROP TABLE IF EXISTS guess_the_goal_solves, guess_the_goal_sessions, goal_choreographies, store_transaction_logs,
    user_xp_events, guest_sessions, users CASCADE;
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE, last_seen_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE store_transaction_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, event_type text NOT NULL, outcome text,
    coins_delta integer, idempotency_key text, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE user_xp_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, source_type text NOT NULL, xp_delta integer);
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const option = (id: string, en: string, correct: boolean) => ({ id, text: { en, ka: en }, is_correct: correct });

describe.skipIf(!url && !admin)('guess the goal on real Postgres', () => {
  let service: typeof import('../../src/modules/guess-the-goal/guess-the-goal.service.js').guessTheGoalService;
  let repo: typeof import('../../src/modules/guess-the-goal/guess-the-goal.repo.js').guessTheGoalRepo;
  let legacyMember = '';
  const goals: string[] = [];

  const apply = (file: string) => db.sql.begin((tx) => tx.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8')));
  const goal = async (slug: string) => {
    const [row] = await db.sql`
      INSERT INTO goal_choreographies (slug, status, difficulty, title, options, bonus, players, steps, scorer, match_label, year)
      VALUES (${slug}, 'published', 'easy', ${db.sql.json({ en: slug, ka: slug })},
        ${db.sql.json([option('a', 'Right', true), option('b', 'Wrong 1', false), option('c', 'Wrong 2', false), option('d', 'Wrong 3', false)])},
        ${db.sql.json({ question: { en: 'Assist?', ka: 'Assist?' }, options: [option('a', 'Yes', true), option('b', 'No', false), option('c', 'Maybe', false), option('d', 'Never', false)] })},
        ${db.sql.json([{ id: 'p1', team: 'attack', at: [30, 80] }, { id: 'gk', team: 'keeper', at: [34, 103] }])},
        ${db.sql.json([{ kind: 'shot', player: 'p1', to: [34, 105], duration: 1 }])},
        ${slug}, ${slug + ' match'}, 2000)
      RETURNING id`;
    return row.id as string;
  };
  const guestSession = async () => (await db.sql`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`)[0].id as string;
  const member = async () => (await db.sql`INSERT INTO users (nickname) VALUES ('m') RETURNING id`)[0].id as string;
  const correctBonusId = async (sessionId: string) => {
    const [row] = await db.sql<{ goal_snapshot: { bonus: { options: Array<{ id: string; is_correct: boolean }> } } }[]>`
      SELECT goal_snapshot FROM guess_the_goal_sessions WHERE id = ${sessionId}`;
    return row.goal_snapshot.bonus.options.find((o) => o.is_correct)!.id;
  };
  const correctId = async (sessionId: string) => {
    const [row] = await db.sql<{ goal_snapshot: { options: Array<{ id: string; is_correct: boolean }> } }[]>`
      SELECT goal_snapshot FROM guess_the_goal_sessions WHERE id = ${sessionId}`;
    return row.goal_snapshot.options.find((o) => o.is_correct)!.id;
  };

  let created: { admin: ReturnType<typeof postgres>; database: string } | null = null;

  beforeAll(async () => {
    if (url) db.sql = postgres(url, { max: 4, onnotice: () => undefined });
    else {
      const database = `ggt_guest_${randomUUID().replaceAll('-', '')}`;
      const adminSql = postgres({ ...admin!, max: 1, onnotice: () => undefined });
      // CREATE DATABASE copies template1 and fails while another suite is connected to it: retry.
      for (let attempt = 1; ; attempt += 1) {
        try { await adminSql`CREATE DATABASE ${adminSql(database)}`; break; } catch (error) {
          if ((error as { code?: string }).code !== '55006' || attempt >= 10) throw error;
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
        }
      }
      created = { admin: adminSql, database };
      db.sql = postgres({ ...admin!, database, max: 4, onnotice: () => undefined });
    }
    await db.sql.unsafe(FIXTURE);
    for (const file of BEFORE_GUESTS) await apply(file);
    for (const slug of ['g-one', 'g-two', 'g-three']) goals.push(await goal(slug));
    // What prod holds before the guest migration: a member's solved session.
    legacyMember = await member();
    const [s] = await db.sql`
      INSERT INTO guess_the_goal_sessions (user_id, goal_id, goal_snapshot, max_points, state, guessed_at, guess_option_id, guess_correct, points, first_solve, coins_awarded)
      VALUES (${legacyMember}, ${goals[0]}, '{}'::jsonb, 100, 'complete', now(), 'a', true, 100, true, 25) RETURNING id`;
    await db.sql`INSERT INTO guess_the_goal_solves (user_id, goal_id, session_id) VALUES (${legacyMember}, ${goals[0]}, ${s.id})`;
    await apply(GUEST_MIGRATION);
    ({ guessTheGoalService: service } = await import('../../src/modules/guess-the-goal/guess-the-goal.service.js'));
    ({ guessTheGoalRepo: repo } = await import('../../src/modules/guess-the-goal/guess-the-goal.repo.js'));
  });
  afterAll(async () => {
    await db.sql?.end();
    if (created) {
      await created.admin.unsafe(`DROP DATABASE IF EXISTS "${created.database}" WITH (FORCE)`);
      await created.admin.end({ timeout: 2 });
    }
  });
  beforeEach(() => {
    rewards.coins.mockReset().mockResolvedValue({ coins: 100 });
    rewards.log.mockReset().mockResolvedValue(undefined);
    rewards.xp.mockReset().mockResolvedValue({ totalXp: 10 });
  });

  const expectPgError = (p: Promise<unknown>, constraint: string) => expect(p).rejects.toMatchObject({ constraint_name: constraint });

  describe('migration', () => {
    it('keeps the member session and solve; reapplying it is a no-op', async () => {
      const [row] = await db.sql`SELECT user_id, guest_id, coins_awarded FROM guess_the_goal_sessions WHERE user_id = ${legacyMember}`;
      expect(row).toEqual({ user_id: legacyMember, guest_id: null, coins_awarded: 25 });
      await apply(GUEST_MIGRATION);
      expect(await repo.countSolved({ kind: 'member', userId: legacyMember })).toBe(1);
    });

    it('a session has exactly one owner, and a guest session can never carry rewards', async () => {
      const guest = await guestSession();
      const user = await member();
      const insert = (userId: string | null, guestId: string | null, coins = 0) => db.sql`
        INSERT INTO guess_the_goal_sessions (user_id, guest_id, goal_id, goal_snapshot, max_points, coins_awarded)
        VALUES (${userId}, ${guestId}, ${goals[1]}, '{}'::jsonb, 100, ${coins})`;
      await expectPgError(insert(null, null), 'chk_ggt_sessions_owner');
      await expectPgError(insert(user, guest), 'chk_ggt_sessions_owner');
      await expectPgError(insert(null, guest, 5), 'chk_ggt_sessions_guest_unrewarded');
    });
  });

  describe('a guest plays', () => {
    it('start → correct guess → bonus: scored, no solves row, no rewards, counted as solved', async () => {
      const guest = { kind: 'guest' as const, guestId: await guestSession() };
      const started = await service.startSession(guest, 'nonce-1');
      expect(started.goal.options.every((o) => !('is_correct' in o))).toBe(true);

      const right = await correctId(started.session_id);
      const outcome = await service.guess(guest, started.session_id, right);
      expect(outcome).toMatchObject({ correct: true, points: 100, session_state: 'guessed', awards: { first_solve: false, coins: 0, xp: 0 } });
      // a lost response is retried with the same option and replays the stored result
      expect(await service.guess(guest, started.session_id, right)).toMatchObject({ correct: true, points: 100 });

      await expect(service.answerBonus(guest, started.session_id, 'x-unknown')).rejects.toThrow(/Unknown option/);
      const bonusRight = await correctBonusId(started.session_id);
      const bonus = await service.answerBonus(guest, started.session_id, bonusRight);
      expect(bonus).toMatchObject({ correct: true, bonus_points: 40, awards: { coins: 0, xp: 0 } });
      expect(await service.answerBonus(guest, started.session_id, bonusRight)).toMatchObject({ correct: true, bonus_points: 40 });
      const [settled] = await db.sql`SELECT state, bonus_points, bonus_coins_awarded, bonus_xp_awarded FROM guess_the_goal_sessions WHERE id = ${started.session_id}`;
      expect(settled).toEqual({ state: 'complete', bonus_points: 40, bonus_coins_awarded: 0, bonus_xp_awarded: 0 });

      expect(rewards.coins).not.toHaveBeenCalled();
      expect(rewards.xp).not.toHaveBeenCalled();
      const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM guess_the_goal_solves WHERE session_id = ${started.session_id}`;
      expect(n).toBe(0);
      expect(await repo.countSolved(guest)).toBe(1);
      const gallery = await service.getGallery(guest);
      expect(gallery).toMatchObject({ solved: 1, total: 3, coins_earned: 0, xp_earned: 0, goals_today: 1 });
    });

    it('never serves a goal the guest already solved while unsolved ones remain', async () => {
      const guest = { kind: 'guest' as const, guestId: await guestSession() };
      const solved = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const s = await service.startSession(guest, `n-${i}`);
        const [{ goal_id }] = await db.sql`SELECT goal_id FROM guess_the_goal_sessions WHERE id = ${s.session_id}`;
        expect(solved.has(goal_id)).toBe(false);
        await service.guess(guest, s.session_id, await correctId(s.session_id));
        solved.add(goal_id);
      }
      expect(solved.size).toBe(3);
      expect(await service.getStats(guest)).toMatchObject({ solved: 3, total: 3, pool_exhausted: true, daily_max_coins: 0 });
    });

    it('a retried start with the same nonce returns the same session; the daily limit holds per guest', async () => {
      const guest = { kind: 'guest' as const, guestId: await guestSession() };
      const first = await service.startSession(guest, 'same');
      expect((await service.startSession(guest, 'same')).session_id).toBe(first.session_id);
      for (let i = 0; i < 4; i++) await service.startSession(guest, `more-${i}`);
      await expect(service.startSession(guest, 'sixth')).rejects.toThrow(/Daily goal limit/);
    });

    it('cannot act on another guest\'s or a member\'s session, and they cannot act on its', async () => {
      const a = { kind: 'guest' as const, guestId: await guestSession() };
      const b = { kind: 'guest' as const, guestId: await guestSession() };
      const m = { kind: 'member' as const, userId: await member() };
      const sa = await service.startSession(a, 'a1');
      const sm = await service.startSession(m, 'm1');
      await expect(service.guess(b, sa.session_id, 'a')).rejects.toThrow(/No such active session/);
      await expect(service.guess(m, sa.session_id, 'a')).rejects.toThrow(/No such active session/);
      await expect(service.guess(a, sm.session_id, 'a')).rejects.toThrow(/No such active session/);
      await expect(service.getCurrent(b)).rejects.toThrow(/No active session/);
    });

    it('a member still gets a solves row and rewards', async () => {
      const m = { kind: 'member' as const, userId: await member() };
      const s = await service.startSession(m, 'm-reward');
      const outcome = await service.guess(m, s.session_id, await correctId(s.session_id));
      expect(outcome.awards.first_solve).toBe(true);
      expect(rewards.coins).toHaveBeenCalled();
      const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM guess_the_goal_solves WHERE user_id = ${m.userId}`;
      expect(n).toBe(1);
    });

    it('retiring the guest session removes its Guess the Goal sessions and nothing else', async () => {
      const guestId = await guestSession();
      const s = await service.startSession({ kind: 'guest', guestId }, 'bye');
      await service.guess({ kind: 'guest', guestId }, s.session_id, await correctId(s.session_id));
      await db.sql`DELETE FROM guest_sessions WHERE id = ${guestId}`;
      const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM guess_the_goal_sessions WHERE guest_id = ${guestId}`;
      expect(n).toBe(0);
      expect(await repo.countSolved({ kind: 'member', userId: legacyMember })).toBe(1);
    });
  });
});
