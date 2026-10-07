import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

/**
 * The Freecroco overview (GET /stats) and staff accounts (/staff) on real PostgreSQL. Runs against an isolated
 * database or CI's admin connection:
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

const staff = vi.hoisted(() => ({ users: new Map<string, { id: string; role: string }>() }));
vi.mock('../../src/http/middleware/auth.js', async () => {
  const { AuthenticationError } = await import('../../src/core/errors.js');
  return {
    authenticateRequest: async (req: express.Request, token: string) => {
      const user = staff.users.get(token);
      if (!user) throw new AuthenticationError('Invalid or expired token');
      // Read the role as the real middleware would: from the database, so promotions and removals show.
      const [row] = await db.sql<{ role: string }[]>`SELECT role FROM users WHERE id = ${user.id}`;
      req.user = { id: user.id, role: row?.role ?? user.role } as never;
    },
  };
});

const isolatedUrl = process.env.PARTNER_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;

const MIGRATIONS = [
  '20261005121000_partner_core.sql',
  '20261005121001_partner_core_validate.sql',
  '20261005130000_partner_delivery.sql',
  '20261006120000_partner_ranked.sql',
  '20261006150000_partner_ranked_points.sql',
  '20261006150001_partner_ranked_points_entries.sql',
  '20261006150002_partner_ranked_points_validate.sql',
  '20261006180000_partner_ranked_opponent_shown.sql',
  '20261006160000_partner_admin_stats_staff.sql',
].map((f) => join(__dirname, '../../supabase/migrations', f));

const FIXTURE = `
  DROP TABLE IF EXISTS partner_ranked_entries, partner_ranked_points, partner_score_event_attempts, partner_score_events,
    partner_plays, partner_quota_days, partner_audit, partner_limit_overrides, partner_games, partner_config_versions,
    partner_sessions, partner_players, partner_operator_memberships, matches, user_identities, users CASCADE;
  DROP FUNCTION IF EXISTS refill_tickets_global();
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, nickname text, is_ai boolean NOT NULL DEFAULT false,
    is_guest boolean NOT NULL DEFAULT false, is_banned boolean NOT NULL DEFAULT false,
    is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz,
    pending_deletion_at timestamptz, coins integer NOT NULL DEFAULT 0, tickets integer NOT NULL DEFAULT 5,
    onboarding_complete boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now(),
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))
  );
  CREATE TABLE user_identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL, subject text NOT NULL, email text, created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (provider, subject)
  );
  CREATE TABLE matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text NOT NULL DEFAULT 'ranked');
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const BASE = '/partner-admin/v1/partners/freecroco';

describe.skipIf(!isolated && !adminTarget)('partner admin overview and staff on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let app: express.Express;
  let invites: typeof import('../../src/modules/partners/partner-staff-invites.js');
  let today: string;
  const invited: string[] = [];

  beforeAll(async () => {
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_admin_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 8, onnotice: () => undefined });
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
    // Safe to re-run.
    for (const file of MIGRATIONS.slice(-2)) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));

    const partnerConfig = await import('../../src/modules/partners/partner-config.js');
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco',
      environment: 'test',
      inboundKeySha256: [partnerConfig.sha256Hex('k'.repeat(64))],
      launchBaseUrl: 'https://staging-freecroco.quizball.io',
    });
    partnerConfig.resetPartnerConfigCache();
    invites = await import('../../src/modules/partners/partner-staff-invites.js');
    const { partnerAdminRoutes } = await import('../../src/http/routes/partner-admin.routes.js');
    app = express();
    app.use(express.json());
    app.use(BASE, partnerAdminRoutes);
    [{ today }] = await db.sql<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE 'Asia/Tbilisi')::date, 'YYYY-MM-DD') AS today`;
  }, 60_000);

  afterAll(async () => {
    invites?.setStaffInviterForTests(null);
    try {
      await db.sql?.end({ timeout: 2 });
    } finally {
      try {
        if (admin && createdDatabase) await admin.unsafe(`DROP DATABASE "${createdDatabase}" WITH (FORCE)`);
      } finally {
        await admin?.end({ timeout: 2 });
      }
    }
  }, 60_000);

  beforeEach(() => {
    invited.length = 0;
    invites.setStaffInviterForTests({
      mode: 'stub',
      async invite(email) {
        invited.push(email);
        return { authUserId: randomUUID(), invited: true };
      },
    });
  });

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;
  const shift = (day: string, days: number) => {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  };
  /** Noon Tbilisi on `day`. */
  const noon = (day: string) => `${day}T12:00:00+04:00`;

  const makeUser = async (token: string, role: 'admin' | 'user', email: string | null = null) => {
    const [user] = await db.sql<{ id: string }[]>`INSERT INTO users (email, role) VALUES (${email}, ${role}) RETURNING id`;
    staff.users.set(token, { id: user.id, role });
    return user.id;
  };
  const as = (token: string) => ({
    get: (path: string) => request(app).get(`${BASE}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: unknown) => request(app).post(`${BASE}${path}`).set('Authorization', `Bearer ${token}`).send(body as object),
    patch: (path: string, body: unknown) => request(app).patch(`${BASE}${path}`).set('Authorization', `Bearer ${token}`).send(body as object),
    delete: (path: string) => request(app).delete(`${BASE}${path}`).set('Authorization', `Bearer ${token}`),
  });

  async function player(environment = 'test', createdDay = today) {
    const [user] = await db.sql<{ id: string }[]>`
      INSERT INTO users (nickname, partner_slug) VALUES (${id('fc')}, 'freecroco') RETURNING id`;
    const [p] = await db.sql<{ id: string; external: string }[]>`
      INSERT INTO partner_players (partner_slug, environment, external_player_id, user_id, created_at)
      VALUES ('freecroco', ${environment}, ${id('ext')}, ${user.id}, ${noon(createdDay)})
      RETURNING id, external_player_id AS external`;
    const sessionId = randomUUID();
    await db.sql`
      INSERT INTO partner_sessions (id, partner_slug, environment, player_id, request_id, request_hash, launch_seq,
        token_hash, token_expires_at, channel, language)
      VALUES (${sessionId}, 'freecroco', ${environment}, ${p.id}, ${id('req')}, 'h', 1, ${id('tok')},
        now() + interval '1 minute', 'WEB', 'en')`;
    return { id: p.id, userId: user.id, external: p.external, sessionId, environment };
  }

  async function play(
    who: Awaited<ReturnType<typeof player>>,
    gameId: string,
    day: string,
    outcome: { score?: number; cancelled?: boolean; refunded?: boolean } = {},
  ) {
    const finished = outcome.score !== undefined;
    const [row] = await db.sql<{ id: string }[]>`
      INSERT INTO partner_plays (partner_slug, environment, player_id, session_id, game_id, partner_day, state, score,
        limit_snapshot, source_ref, started_at, finished_at, cancelled_at, refunded)
      VALUES ('freecroco', ${who.environment}, ${who.id}, ${who.sessionId}, ${gameId}, ${day}::date,
        ${finished ? 'finished' : outcome.cancelled ? 'cancelled' : 'started'}, ${outcome.score ?? null}, 10, ${id('src')},
        ${noon(day)}, ${finished ? noon(day) : null}, ${outcome.cancelled ? noon(day) : null}, ${outcome.refunded ?? false})
      RETURNING id`;
    return row.id;
  }

  async function scoreEvent(who: Awaited<ReturnType<typeof player>>, playId: string, gameId: string, score: number,
    day: string, status: 'sent' | 'pending' | 'dead', createdAgoSeconds = 0) {
    await db.sql`
      INSERT INTO partner_score_events (event_id, partner_slug, environment, play_id, player_id, session_id, game_id,
        score, occurred_at, payload, status, sent_at, dead_at, created_at)
      VALUES (${`qb_${playId}`}, 'freecroco', ${who.environment}, ${playId}, ${who.external}, ${who.sessionId}, ${gameId},
        ${score}, ${noon(day)}, ${db.sql.json({ score })}, ${status},
        ${status === 'sent' ? noon(day) : null}, ${status === 'dead' ? noon(day) : null},
        now() - make_interval(secs => ${createdAgoSeconds}))`;
  }

  async function rankedEntry(who: Awaited<ReturnType<typeof player>>, day: string, matchId: string | null,
    state: 'searching' | 'playing' | 'settled' | 'cancelled', refunded = false) {
    const playId = await play(who, 'ranked', day, state === 'settled' ? { score: 100 } : state === 'cancelled' ? { cancelled: true, refunded } : {});
    await db.sql`
      INSERT INTO partner_ranked_entries (play_id, partner_slug, environment, partner_player_id, user_id, state, match_id,
        score, refunded, settled_at)
      VALUES (${playId}, 'freecroco', ${who.environment}, ${who.id}, ${who.userId}, ${state}, ${matchId},
        ${state === 'settled' ? 100 : null}, ${refunded}, ${state === 'settled' || state === 'cancelled' ? noon(day) : null})`;
  }

  describe('GET /stats', () => {
    // The endpoint caches for a minute; each test reads what it just wrote.
    beforeEach(async () => (await import('../../src/modules/partners/partner-stats.service.js')).clearPartnerStatsCache());
    const ADMIN = 'stats-admin';
    const VIEWER = 'stats-viewer';
    const PLAIN = 'stats-plain';

    beforeAll(async () => {
      await makeUser(ADMIN, 'admin');
      await makeUser(PLAIN, 'user');
      const [viewer] = await db.sql<{ id: string }[]>`INSERT INTO users (role) VALUES ('partner_staff') RETURNING id`;
      await db.sql`INSERT INTO partner_operator_memberships (partner_slug, user_id, role) VALUES ('freecroco', ${viewer.id}, 'viewer')`;
      staff.users.set(VIEWER, { id: viewer.id, role: 'partner_staff' });

      const yesterday = shift(today, -1);
      const a = await player('test', today);
      const b = await player('test', yesterday);
      const c = await player('test', shift(today, -10));
      const old = await player('test', shift(today, -40));
      const other = await player('production', today);

      const aCountdown = await play(a, 'countdown', today, { score: 300 });
      await scoreEvent(a, aCountdown, 'countdown', 300, today, 'sent');
      const aTf = await play(a, 'true-false', today, { score: 100 });
      await scoreEvent(a, aTf, 'true-false', 100, today, 'pending', 90);
      await play(a, 'true-false', today);
      const bCountdown = await play(b, 'countdown', yesterday, { score: 500 });
      await scoreEvent(b, bCountdown, 'countdown', 500, yesterday, 'sent');
      const bDead = await play(b, 'pick-em', yesterday, { score: 50 });
      await scoreEvent(b, bDead, 'pick-em', 50, yesterday, 'dead');
      await play(c, 'countdown', shift(today, -10), { score: 200 });
      await play(old, 'countdown', shift(today, -40), { score: 999 });
      // Another environment's data never shows.
      const otherPlay = await play(other, 'countdown', today, { score: 2000 });
      await scoreEvent(other, otherPlay, 'countdown', 2000, today, 'sent');

      // Ranked: a and b met (two entries), c met a bot (one entry), a search was cancelled and returned.
      const [m1] = await db.sql<{ id: string }[]>`INSERT INTO matches DEFAULT VALUES RETURNING id`;
      const [m2] = await db.sql<{ id: string }[]>`INSERT INTO matches DEFAULT VALUES RETURNING id`;
      await rankedEntry(a, today, m1.id, 'settled');
      await rankedEntry(b, yesterday, m1.id, 'settled');
      await rankedEntry(c, today, m2.id, 'playing');
      await rankedEntry(c, today, null, 'cancelled', true);
    });

    it('is open to any staff member, not to plain users', async () => {
      expect((await request(app).get(`${BASE}/stats`)).status).toBe(401);
      expect((await as(PLAIN).get('/stats')).status).toBe(403);
      expect((await as(VIEWER).get('/stats')).status).toBe(200);
    });

    it('counts players, plays, ranked and deliveries by Tbilisi day for this environment only', async () => {
      const res = await as(ADMIN).get('/stats');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const s = res.body;
      expect(s.today).toBe(today);
      expect(s.to).toBe(today);
      expect(s.from).toBe(shift(today, -13));
      expect(s.daily).toHaveLength(14);
      expect(s.totals).toEqual({
        playersEver: 4, newPlayers: 3, activeToday: 2, activeYesterday: 1, activeLast7Days: 3, activeInRange: 3,
      });
      expect(s.todayStats).toEqual({
        day: today, newPlayers: 1, activePlayers: 2, playsStarted: 6, playsFinished: 3, pointsSent: 300,
      });
      expect(s.yesterdayStats).toEqual({
        day: shift(today, -1), newPlayers: 1, activePlayers: 1, playsStarted: 3, playsFinished: 3, pointsSent: 500,
      });
      expect(s.daily.at(-1)).toEqual(s.todayStats);
      expect(s.daily.find((d: { day: string }) => d.day === shift(today, -10))).toMatchObject({ newPlayers: 1, playsStarted: 1 });

      const countdown = s.games.find((g: { gameId: string }) => g.gameId === 'countdown');
      expect(countdown).toEqual({ gameId: 'countdown', plays: 3, finished: 3, averageScore: 333.3, maxScore: 500, uniquePlayers: 3 });
      const tf = s.games.find((g: { gameId: string }) => g.gameId === 'true-false');
      expect(tf).toEqual({ gameId: 'true-false', plays: 2, finished: 1, averageScore: 100, maxScore: 100, uniquePlayers: 1 });
      expect(s.games.find((g: { gameId: string }) => g.gameId === 'quiz-board')).toEqual({
        gameId: 'quiz-board', plays: 0, finished: 0, averageScore: null, maxScore: null, uniquePlayers: 0,
      });
      expect(s.games).toHaveLength(11);

      expect(s.ranked).toEqual({ plays: 4, matches: 2, vsPlayers: 1, vsBots: 1, settled: 2, cancelled: 1, returned: 1, open: 1 });
      expect(s.delivery).toMatchObject({ sent: 2, pending: 1, dead: 1, pendingNow: 1, deadNow: 1 });
      expect(s.delivery.oldestPendingSeconds).toBeGreaterThanOrEqual(89);
    });

    it('takes a range, and refuses a reversed or over-long one', async () => {
      const yesterday = shift(today, -1);
      const one = (await as(VIEWER).get(`/stats?from=${yesterday}&to=${yesterday}`)).body;
      expect(one.daily).toEqual([one.yesterdayStats]);
      expect(one.totals.newPlayers).toBe(1);
      expect(one.ranked).toMatchObject({ plays: 1, matches: 1, vsPlayers: 1 });

      const wide = await as(VIEWER).get(`/stats?from=${shift(today, -91)}&to=${today}`);
      expect(wide.status).toBe(200);
      expect(wide.body.daily).toHaveLength(92);
      expect(wide.body.totals.newPlayers).toBe(4);
      expect((await as(VIEWER).get(`/stats?from=${shift(today, -92)}&to=${today}`)).status).toBe(400);
      expect((await as(VIEWER).get(`/stats?from=${today}&to=${yesterday}`)).status).toBe(400);
      expect((await as(VIEWER).get('/stats?from=2026-02-30')).status).toBe(400);
    });

    it('reports no backlog age when nothing is pending', async () => {
      // Only the delivery state moves; the frozen-event trigger allows it.
      await db.sql`UPDATE partner_score_events SET status = 'sent' WHERE status = 'pending'`;
      try {
        const res = await as(ADMIN).get('/stats');
        expect(res.body.delivery).toMatchObject({ pendingNow: 0, oldestPendingSeconds: null });
      } finally {
        await db.sql`UPDATE partner_score_events SET status = 'pending' WHERE game_id = 'true-false' AND environment = 'test'`;
      }
    });
  });

  describe('/staff', () => {
    const ADMIN = 'staff-admin';
    const OTHER_ADMIN = 'staff-other-admin';
    const EDITOR = 'staff-editor';
    let adminId: string;
    let otherAdminEmail: string;

    beforeAll(async () => {
      adminId = await makeUser(ADMIN, 'admin', `${id('boss')}@quizball.io`);
      otherAdminEmail = `${id('admin2')}@quizball.io`;
      await makeUser(OTHER_ADMIN, 'admin', otherAdminEmail);
      const [editor] = await db.sql<{ id: string }[]>`INSERT INTO users (role) VALUES ('partner_staff') RETURNING id`;
      await db.sql`INSERT INTO partner_operator_memberships (partner_slug, user_id, role) VALUES ('freecroco', ${editor.id}, 'editor')`;
      staff.users.set(EDITOR, { id: editor.id, role: 'partner_staff' });
    });

    it('is Quizball admins only', async () => {
      expect((await as(EDITOR).get('/staff')).status).toBe(403);
      expect((await as(EDITOR).post('/staff', { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
      expect((await as(EDITOR).delete(`/staff/${staff.users.get(EDITOR)!.id}`)).status).toBe(403);
      expect(invited).toEqual([]);
    });

    it('invites a new email: creates a staff account linked to the Supabase id, audited', async () => {
      const email = `${id('New')}@Freecroco.example`;
      const res = await as(ADMIN).post('/staff', { email: `  ${email} `, role: 'viewer' });
      expect(res.status).toBe(201);
      expect(invited).toEqual([email.toLowerCase()]);
      expect(res.body).toMatchObject({
        account: 'invited',
        inviteSent: true,
        member: { email: email.toLowerCase(), role: 'viewer', addedBy: { userId: adminId }, lastSignInAt: null },
      });
      const userId = res.body.member.userId;
      const [user] = await db.sql`SELECT role, coins, tickets FROM users WHERE id = ${userId}`;
      expect(user).toEqual({ role: 'partner_staff', coins: 0, tickets: 0 });
      const identities = await db.sql`SELECT provider, email FROM user_identities WHERE user_id = ${userId}`;
      expect(identities).toEqual([{ provider: 'supabase', email: email.toLowerCase() }]);
      const [audit] = await db.sql`
        SELECT actor, action, target, after FROM partner_audit WHERE target = ${`user:${userId}`} ORDER BY id`;
      expect(audit).toMatchObject({
        actor: `user:${adminId}`, action: 'staff.add', target: `user:${userId}`,
        after: { email: email.toLowerCase(), role: 'viewer', account: 'invited', previousUserRole: 'partner_staff' },
      });

      // The new member can now read the section.
      staff.users.set('invited-token', { id: userId, role: 'partner_staff' });
      expect((await as('invited-token').get('/stats')).status).toBe(200);
      expect((await as(ADMIN).post('/staff', { email, role: 'editor' })).body.error.code).toBe('staff_exists');
    });

    it('converts an existing Quizball account, and gives it back on removal', async () => {
      const email = `${id('fan')}@example.com`;
      const userId = await makeUser('fan-token', 'user', email);
      const res = await as(ADMIN).post('/staff', { email, role: 'editor' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ account: 'existing', inviteSent: false, member: { userId, role: 'editor' } });
      expect(invited).toEqual([]);
      expect((await db.sql`SELECT role FROM users WHERE id = ${userId}`)[0].role).toBe('partner_staff');

      const list = (await as(ADMIN).get('/staff')).body.items;
      expect(list.find((m: { userId: string }) => m.userId === userId)).toMatchObject({ email, role: 'editor' });

      const patched = await as(ADMIN).patch(`/staff/${userId}`, { role: 'viewer' });
      expect(patched.status).toBe(200);
      expect(patched.body.role).toBe('viewer');
      expect((await as(ADMIN).patch(`/staff/${userId}`, { role: 'owner' })).status).toBe(400);

      expect((await as('fan-token').get('/stats')).status).toBe(200);
      expect((await as(ADMIN).delete(`/staff/${userId}`)).status).toBe(204);
      expect((await db.sql`SELECT role FROM users WHERE id = ${userId}`)[0].role).toBe('user');
      expect((await as('fan-token').get('/stats')).status).toBe(403);
      expect((await as(ADMIN).delete(`/staff/${userId}`)).status).toBe(404);
      expect((await as(ADMIN).patch(`/staff/${userId}`, { role: 'editor' })).status).toBe(404);

      const actions = await db.sql`SELECT action, before, after FROM partner_audit WHERE target = ${`user:${userId}`} ORDER BY id`;
      expect(actions).toEqual([
        { action: 'staff.add', before: null, after: { email, role: 'editor', account: 'existing', previousUserRole: 'user' } },
        { action: 'staff.update', before: { role: 'editor' }, after: { role: 'viewer' } },
        { action: 'staff.remove', before: { email, role: 'viewer' }, after: { userRole: 'user' } },
      ]);
    });

    it('refuses Quizball admins, partner players and ambiguous emails, and never changes their role', async () => {
      const refused = await as(ADMIN).post('/staff', { email: otherAdminEmail.toUpperCase(), role: 'viewer' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('staff_not_eligible');
      expect((await db.sql`SELECT role FROM users WHERE lower(email) = ${otherAdminEmail}`)[0].role).toBe('admin');

      const playerEmail = `${id('player')}@example.com`;
      await db.sql`INSERT INTO users (email, partner_slug) VALUES (${playerEmail}, 'freecroco')`;
      expect((await as(ADMIN).post('/staff', { email: playerEmail, role: 'viewer' })).body.error.code).toBe('staff_not_eligible');

      const twice = `${id('twice')}@example.com`;
      await db.sql`INSERT INTO users (email) VALUES (${twice}), (${twice})`;
      expect((await as(ADMIN).post('/staff', { email: twice, role: 'viewer' })).body.error.code).toBe('staff_not_eligible');

      // A deleted account reached through its Supabase identity is refused too.
      const gone = `${id('gone')}@example.com`;
      const subject = randomUUID();
      const [deleted] = await db.sql<{ id: string }[]>`
        INSERT INTO users (email, is_deleted, deleted_at) VALUES (${gone}, true, now()) RETURNING id`;
      await db.sql`INSERT INTO user_identities (user_id, provider, subject) VALUES (${deleted.id}, 'supabase', ${subject})`;
      invites.setStaffInviterForTests({ mode: 'stub', invite: async () => ({ authUserId: subject, invited: false }) });
      expect((await as(ADMIN).post('/staff', { email: gone, role: 'viewer' })).body.error).toMatchObject({
        code: 'staff_not_eligible', message: 'This account was deleted',
      });

      expect((await as(ADMIN).post('/staff', { email: 'not-an-email', role: 'viewer' })).status).toBe(400);
      expect((await as(ADMIN).post('/staff', { email: 'a@b.co', role: 'admin' })).status).toBe(400);
      expect((await as(ADMIN).delete('/staff/not-a-uuid')).status).toBe(400);
      expect(invited).toEqual([]);
    });

    it('never demotes an admin who somehow holds a membership', async () => {
      const [legacy] = await db.sql<{ id: string }[]>`INSERT INTO users (role) VALUES ('admin') RETURNING id`;
      await db.sql`INSERT INTO partner_operator_memberships (partner_slug, user_id, role) VALUES ('freecroco', ${legacy.id}, 'viewer')`;
      expect((await as(ADMIN).delete(`/staff/${legacy.id}`)).status).toBe(204);
      expect((await db.sql`SELECT role FROM users WHERE id = ${legacy.id}`)[0].role).toBe('admin');
    });

    it('reuses the account a Supabase identity already has instead of creating a second one', async () => {
      const email = `${id('known')}@example.com`;
      const subject = randomUUID();
      const [user] = await db.sql<{ id: string }[]>`INSERT INTO users (email) VALUES (${'different@example.com'}) RETURNING id`;
      await db.sql`INSERT INTO user_identities (user_id, provider, subject, email) VALUES (${user.id}, 'supabase', ${subject}, ${email})`;
      invites.setStaffInviterForTests({ mode: 'stub', invite: async () => ({ authUserId: subject, invited: false }) });
      const res = await as(ADMIN).post('/staff', { email, role: 'viewer' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ account: 'invited', inviteSent: false, member: { userId: user.id } });
      expect((await db.sql`SELECT count(*)::int AS n FROM user_identities WHERE subject = ${subject}`)[0].n).toBe(1);
    });

    it('a failed invite changes nothing', async () => {
      const { PartnerError } = await import('../../src/modules/partners/partner-errors.js');
      invites.setStaffInviterForTests({ mode: 'supabase', invite: async () => { throw new PartnerError('invite_failed'); } });
      const email = `${id('fail')}@example.com`;
      const res = await as(ADMIN).post('/staff', { email, role: 'viewer' });
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('invite_failed');
      expect((await db.sql`SELECT count(*)::int AS n FROM users WHERE email = ${email}`)[0].n).toBe(0);
    });

    it('reads the last sign-in from auth.users when the database has it', async () => {
      const staffService = await import('../../src/modules/partners/partner-staff.service.js');
      const email = `${id('signin')}@example.com`;
      const subject = randomUUID();
      invites.setStaffInviterForTests({ mode: 'stub', invite: async () => ({ authUserId: subject, invited: true }) });
      const added = await as(ADMIN).post('/staff', { email, role: 'viewer' });
      expect(added.body.member.lastSignInAt).toBeNull();
      await db.sql.unsafe(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, last_sign_in_at timestamptz)`);
      try {
        await db.sql`INSERT INTO auth.users (id, last_sign_in_at) VALUES (${subject}, '2026-10-05T10:00:00Z')`;
        // A subject that is not a uuid matches nothing and never fails the lookup for everyone else.
        const [{ user_id: staffUserId }] = await db.sql`
          SELECT user_id FROM user_identities WHERE provider = 'supabase' AND subject = ${subject}`;
        await db.sql`INSERT INTO user_identities (user_id, provider, subject) VALUES (${staffUserId}, 'supabase', ${`legacy-${subject}`})`;
        staffService.resetStaffSignInProbe();
        const list = (await as(ADMIN).get('/staff')).body.items;
        expect(list.find((m: { email: string }) => m.email === email).lastSignInAt).toBe('2026-10-05T10:00:00.000Z');
        const plan = await db.sql.begin(async (tx) => {
          await tx`SET LOCAL enable_seqscan = off`;
          return tx.unsafe(`
            EXPLAIN SELECT i.user_id, max(a.last_sign_in_at) FROM user_identities i
            JOIN auth.users a
              ON a.id = CASE WHEN i.subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                             THEN i.subject::uuid END
            WHERE i.provider = 'supabase' AND i.user_id = ANY('{${staffUserId}}'::uuid[]) GROUP BY i.user_id`);
        });
        expect(JSON.stringify(plan)).toContain('Index Scan using users_pkey on users a');
      } finally {
        await db.sql.unsafe('DROP SCHEMA auth CASCADE');
        staffService.resetStaffSignInProbe();
      }
    });
  });
});
