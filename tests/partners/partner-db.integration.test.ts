import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

/**
 * Real PostgreSQL: applies the partner core migrations to a minimal users table and drives the partner routes and
 * the quota service against it. Runs in CI against its PostgreSQL service (MIGRATION_TEST_DATABASE_URL: creates and
 * drops a database of its own), or locally against either that or an isolated database:
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const redis = vi.hoisted(() => ({ ready: true }));
vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ get isReady() { return redis.ready; }, ping: async () => 'PONG' }),
}));

// Staff sign in with Supabase; the bearer names the user here. The real authenticateRequest is covered in
// partner-unit.test.ts.
const staff = vi.hoisted(() => ({ users: new Map<string, { id: string; role: string }>() }));
vi.mock('../../src/http/middleware/auth.js', async () => {
  const { AuthenticationError } = await import('../../src/core/errors.js');
  return {
    authenticateRequest: async (req: express.Request, token: string) => {
      const user = staff.users.get(token);
      if (!user) throw new AuthenticationError('Invalid or expired token');
      req.user = user as never;
    },
  };
});

// Validated before anything connects; postgres.js only ever gets these options, never the raw URLs.
const isolatedUrl = process.env.PARTNER_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;

const MIGRATIONS = ['20261005121000_partner_core.sql', '20261005121001_partner_core_validate.sql', '20261006150000_partner_ranked_points.sql']
  .map((f) => join(__dirname, '../../supabase/migrations', f));
const FIXTURE = `
  DROP TABLE IF EXISTS partner_plays, partner_quota_days, partner_audit, partner_limit_overrides, partner_games,
    partner_ranked_points, partner_config_versions, partner_sessions, partner_players, partner_operator_memberships, ranked_profiles, users CASCADE;
  DROP FUNCTION IF EXISTS refill_tickets_global();
  CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, nickname text, country text, avatar_url text,
    avatar_customization jsonb, onboarding_complete boolean NOT NULL DEFAULT false, is_ai boolean NOT NULL DEFAULT false,
    ai_kind text, is_guest boolean NOT NULL DEFAULT false, is_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz,
    pending_deletion_at timestamptz, coins integer NOT NULL DEFAULT 0, tickets integer NOT NULL DEFAULT 5,
    preferred_language text NOT NULL DEFAULT 'en', total_xp integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user'))
  );
  CREATE TABLE ranked_profiles (
    user_id uuid PRIMARY KEY REFERENCES users(id), rp integer, tier text, placement_status text, placement_played integer,
    placement_required integer, placement_wins integer, current_win_streak integer, last_ranked_match_at timestamptz
  );
  CREATE UNIQUE INDEX uq_users_lower_nickname_claimable ON users (lower(nickname))
    WHERE (is_ai = false OR ai_kind = 'persistent') AND is_deleted = false AND deleted_at IS NULL
      AND pending_deletion_at IS NULL AND nickname IS NOT NULL AND length(nickname) > 0;
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const KEY = 'test-inbound-key-'.padEnd(64, 'x');
const ROTATED_KEY = 'test-rotated-key-'.padEnd(64, 'y');

describe.skipIf(!isolated && !adminTarget)('partner core on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let app: express.Express;
  let partner: typeof import('../../src/modules/partners/partner-config.js');
  let quota: typeof import('../../src/modules/partners/partner-quota.service.js');
  let events: typeof import('../../src/modules/partners/partner-events.js');

  const configure = (overrides: Record<string, unknown> = {}) => {
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco',
      environment: 'test',
      inboundKeySha256: [partner.sha256Hex(KEY), partner.sha256Hex(ROTATED_KEY)],
      allowedCidrs: ['127.0.0.1/32', '::1/128'],
      launchBaseUrl: 'https://staging-freecroco.quizball.io',
      ...overrides,
    });
    partner.resetPartnerConfigCache();
  };

  beforeAll(async () => {
    process.env.PARTNER_JWT_SECRET = 'integration-partner-jwt-secret-32-bytes';
    process.env.PARTNER_RESPONSE_SEAL_KEY = 'integration-partner-seal-key-32-bytes!!';
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_core_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 10, onnotice: () => undefined });
    // Nothing destructive runs until the pool is proven to be on the expected database.
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
    // Safe to re-run.
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATIONS[0], 'utf8')));
    // The seed ships all 11 games ready in both environments; the tests below make each game ready as they need it.
    const seeded = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM partner_games WHERE ready AND enabled`;
    expect(seeded[0].n).toBe(22);
    await db.sql`UPDATE partner_games SET ready = false`;

    partner = await import('../../src/modules/partners/partner-config.js');
    quota = await import('../../src/modules/partners/partner-quota.service.js');
    events = await import('../../src/modules/partners/partner-events.js');
    const { partnerRoutes } = await import('../../src/http/routes/partner.routes.js');
    const { errorHandler } = await import('../../src/http/middleware/error-handler.js');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(partnerRoutes);
    app.use(errorHandler);
    configure();
  }, 60_000);
  afterAll(async () => {
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
    configure();
    redis.ready = true;
  });

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;
  const init = (body: Record<string, unknown>, key = KEY) =>
    request(app).post('/partner/v1/sessions/init').set('x-api-key', key).send(body);
  const initBody = (playerId: string, extra: Record<string, unknown> = {}) =>
    ({ playerId, language: 'ka', channel: 'WEB', requestId: id('req'), username: 'nik****om', ...extra });
  const redeem = (token: string) => request(app).post('/partner/v1/sessions/redeem').send({ token });
  const launch = async (playerId: string, extra: Record<string, unknown> = {}) => {
    const started = await init(initBody(playerId, extra));
    expect(started.status).toBe(200);
    const redeemed = await redeem(started.body.oneTimeToken);
    expect(redeemed.status).toBe(200);
    return { init: started.body, access: redeemed.body.accessToken as string, player: redeemed.body.player };
  };
  const block = (playerId: string, action: 'block' | 'unblock', at: string, reason?: string) =>
    request(app).post(`/partner/v1/players/${encodeURIComponent(playerId)}/${action}`).set('x-api-key', KEY).send({ at, reason });
  const setReady = (gameId: string, ready: boolean, defaultLimit?: number) => db.sql`
    UPDATE partner_games SET ready = ${ready}, default_limit = COALESCE(${defaultLimit ?? null}::int, default_limit)
    WHERE partner_slug = 'freecroco' AND environment = 'test' AND game_id = ${gameId}`;

  it('migration: server-only tables, seeded rules for both environments, wider role check', async () => {
    const [grants] = await db.sql`
      SELECT has_table_privilege('anon', 'public.partner_players', 'SELECT') AS a,
             has_table_privilege('authenticated', 'public.partner_sessions', 'SELECT') AS b,
             (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname LIKE 'partner\\_%' AND relkind = 'r') AS rls`;
    expect(grants).toEqual({ a: false, b: false, rls: true });
    const seeded = await db.sql`SELECT environment, count(*)::int AS n, sum(default_limit)::int AS limits
      FROM partner_games GROUP BY environment ORDER BY environment`;
    expect(seeded).toEqual([{ environment: 'production', n: 11, limits: 20 }, { environment: 'test', n: 11, limits: 20 }]);
    await db.sql`INSERT INTO users (nickname, role) VALUES (${id('staff')}, 'partner_staff')`;
    await expect(db.sql`INSERT INTO users (nickname, role) VALUES (${id('x')}, 'owner')`).rejects.toMatchObject({ constraint_name: 'chk_users_role_v2' });
    await expect(db.sql`INSERT INTO users (nickname, role, partner_slug) VALUES (${id('x')}, 'admin', 'freecroco')`).rejects.toMatchObject({ constraint_name: 'chk_users_partner_slug' });
  });

  describe('machine authentication', () => {
    it('refuses a wrong or missing key, accepts both rotation keys', async () => {
      expect((await init(initBody(id('p')), 'wrong'.padEnd(64, 'z'))).body).toEqual({ error: { code: 'unknown_key', message: expect.any(String) } });
      expect((await request(app).post('/partner/v1/sessions/init').send(initBody(id('p')))).status).toBe(401);
      expect((await init(initBody(id('p')), ROTATED_KEY)).status).toBe(200);
    });

    it('refuses a caller outside the allowlist before checking the key', async () => {
      configure({ allowedCidrs: ['203.0.113.0/24'] });
      const res = await init(initBody(id('p')), 'wrong');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ip_not_allowed');
      expect((await request(app).get('/partner/v1/status').set('x-api-key', KEY)).status).toBe(403);
    });

    it('answers 503 maintenance when the deploy has no partner config', async () => {
      delete process.env.PARTNER_FREECROCO_CONFIG;
      partner.resetPartnerConfigCache();
      const res = await init(initBody(id('p')));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('maintenance');
      process.env.PARTNER_FREECROCO_CONFIG = '{"slug":"freecroco"';
      partner.resetPartnerConfigCache();
      expect((await init(initBody(id('p')))).body.error.code).toBe('maintenance');
    });
  });

  describe('sessions/init', () => {
    it('validates identifiers and fields', async () => {
      for (const bad of [
        initBody('has space'), initBody('x'.repeat(65)), initBody(''), initBody('ok', { requestId: 'a/b' }),
        initBody('ok', { language: 'de' }), initBody('ok', { channel: 'APP' }), initBody('ok', { username: 'x'.repeat(51) }),
      ]) {
        const res = await init(bad);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
      expect((await init(initBody('Player.1_a:b@c-d'))).status).toBe(200);
    });

    it('provisions a partner user once: no wallet, onboarding done, an internal handle outside the member names', async () => {
      const taken = id('Member');
      await db.sql`INSERT INTO users (nickname) VALUES (${taken})`;
      const playerId = id('p');
      const res = await init(initBody(playerId, { username: taken.toUpperCase() }));
      expect(res.status).toBe(200);
      expect(res.body.launchUrl).toBe(`https://staging-freecroco.quizball.io/?token=${res.body.oneTimeToken}`);
      expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61_000);
      const [row] = await db.sql`
        SELECT u.nickname, u.partner_slug, u.onboarding_complete, u.coins, u.tickets, u.role, p.display_name
        FROM partner_players p JOIN users u ON u.id = p.user_id WHERE p.external_player_id = ${playerId}`;
      expect(row).toMatchObject({ partner_slug: 'freecroco', onboarding_complete: true, coins: 0, tickets: 0, role: 'user', display_name: taken.toUpperCase() });
      expect(row.nickname).toMatch(/^fc_[0-9a-f]{12}$/);
      // The partner-facing name is the display name, never the handle.
      const redeemed = await redeem(res.body.oneTimeToken);
      expect(redeemed.body.player.displayName).toBe(taken.toUpperCase());
      // Stored tokens are hashes only.
      const [session] = await db.sql`SELECT token_hash, sealed_response FROM partner_sessions WHERE id = ${res.body.sessionId}`;
      expect(session.token_hash).toBe(partner.sha256Hex(res.body.oneTimeToken));
      expect(session.sealed_response).toBeNull();
      // A second launch reuses the user; a name we cannot show (filtered or invisible only) keeps the stored one.
      expect((await init(initBody(playerId, { username: '\u200b' }))).status).toBe(200);
      const [kept] = await db.sql`SELECT count(DISTINCT user_id)::int AS users, max(display_name) AS name FROM partner_players WHERE external_player_id = ${playerId}`;
      expect(kept).toEqual({ users: 1, name: taken.toUpperCase() });
      await init(initBody(playerId, { username: 'gio****li' }));
      const [renamed] = await db.sql`
        SELECT u.nickname, p.display_name FROM partner_players p JOIN users u ON u.id = p.user_id WHERE p.external_player_id = ${playerId}`;
      expect(renamed).toEqual({ nickname: row.nickname, display_name: 'gio****li' });
    });

    it('is idempotent per requestId: same values → same response (also concurrently), changed values → 409', async () => {
      const body = initBody(id('p'));
      const all = await Promise.all(Array.from({ length: 6 }, () => init(body)));
      expect(all.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(all.map((r) => JSON.stringify(r.body))).size).toBe(1);
      const again = await init(body);
      expect(again.body).toEqual(all[0].body);
      expect((await init({ ...body, username: 'other****ge' })).status).toBe(409);
      const changed = await init({ ...body, language: 'en' });
      expect(changed.status).toBe(409);
      expect(changed.body.error.code).toBe('request_conflict');
      const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM partner_sessions WHERE request_id = ${body.requestId}`;
      expect(n).toBe(1);
    });

    it('requires a username: omitted, empty, blank, null or longer than 50 → 400 invalid_request', async () => {
      const { username: _omit, ...withoutName } = initBody(id('p'));
      for (const body of [withoutName, initBody(id('p'), { username: '' }), initBody(id('p'), { username: '   ' }),
        initBody(id('p'), { username: null }), initBody(id('p'), { username: 'x'.repeat(51) })]) {
        const res = await init(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('invalid_request');
      }
    });

    it('a used or expired launch makes its requestId return 409 request_used', async () => {
      const body = initBody(id('p'));
      const first = await init(body);
      expect((await redeem(first.body.oneTimeToken)).status).toBe(200);
      const used = await init(body);
      expect(used.status).toBe(409);
      expect(used.body.error.code).toBe('request_used');

      const late = initBody(id('p'));
      const issued = await init(late);
      await db.sql`UPDATE partner_sessions SET token_expires_at = now() - interval '1 second' WHERE id = ${issued.body.sessionId}`;
      expect((await init(late)).body.error.code).toBe('request_used');
    });

    it('one active session per player: opening a new launch (not init) ends the previous session', async () => {
      const playerId = id('p');
      const first = await launch(playerId);
      const pending = await init(initBody(playerId));
      const me = (access: string) => request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${access}`);
      expect((await me(first.access)).status).toBe(200);
      const opened = await redeem(pending.body.oneTimeToken);
      expect(opened.status).toBe(200);
      const ended = await me(first.access);
      expect(ended.status).toBe(401);
      expect(ended.body.error).toMatchObject({ code: 'session_ended', reason: 'replaced' });
      const refused = await request(app).post('/partner/v1/sessions/refresh').set('Authorization', `Bearer ${first.access}`);
      expect(refused.body.error).toMatchObject({ code: 'session_ended', reason: 'replaced' });
      expect((await me(opened.body.accessToken)).status).toBe(200);
    });

    it('orders launches by a per-player sequence, not by time: same-millisecond launches still revoke', async () => {
      const playerId = id('p');
      const a = await init(initBody(playerId));
      const b = await init(initBody(playerId));
      const c = await init(initBody(playerId));
      // Same instant for all three: only the sequence can tell them apart.
      await db.sql`UPDATE partner_sessions SET created_at = '2026-10-05T12:00:00.000Z' WHERE id IN (${a.body.sessionId}, ${b.body.sessionId}, ${c.body.sessionId})`;
      const seqs = await db.sql`SELECT launch_seq::int AS seq FROM partner_sessions WHERE id IN (${a.body.sessionId}, ${b.body.sessionId}, ${c.body.sessionId}) ORDER BY launch_seq`;
      expect(seqs.map((r) => r.seq)).toEqual([seqs[0].seq, seqs[0].seq + 1, seqs[0].seq + 2]);
      expect((await redeem(b.body.oneTimeToken)).status).toBe(200);
      expect((await redeem(a.body.oneTimeToken)).body.error.code).toBe('token_used');
      // A later launch is still openable and replaces b.
      expect((await redeem(c.body.oneTimeToken)).status).toBe(200);
    });

    it('a requestId reused by another player is a conflict, also when both arrive at once', async () => {
      const requestId = id('shared-req');
      const [x, y] = await Promise.all([
        init({ ...initBody(id('p')), requestId }),
        init({ ...initBody(id('p')), requestId }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      expect([x, y].find((r) => r.status === 409)!.body.error.code).toBe('request_conflict');
      const [{ n }] = await db.sql`SELECT count(*)::int AS n FROM partner_sessions WHERE request_id = ${requestId}`;
      expect(n).toBe(1);
    });

    it('two launches opened at once leave exactly one live session', async () => {
      const playerId = id('p');
      const a = await init(initBody(playerId));
      const b = await init(initBody(playerId));
      const [ra, rb] = await Promise.all([redeem(a.body.oneTimeToken), redeem(b.body.oneTimeToken)]);
      // b is newer: it always opens; a opens only if it got there first (then b replaces it).
      expect(rb.status).toBe(200);
      expect([200, 400]).toContain(ra.status);
      const [{ live }] = await db.sql`
        SELECT count(*)::int AS live FROM partner_sessions s JOIN partner_players p ON p.id = s.player_id
        WHERE p.external_player_id = ${playerId} AND s.state = 'redeemed'`;
      expect(live).toBe(1);
    });
  });

  describe('sessions/redeem', () => {
    it('an older unused launch cannot be opened once a newer one has been', async () => {
      const playerId = id('p');
      const older = await init(initBody(playerId));
      const newer = await init(initBody(playerId));
      expect((await redeem(newer.body.oneTimeToken)).status).toBe(200);
      const stale = await redeem(older.body.oneTimeToken);
      expect(stale.status).toBe(400);
      expect(stale.body.error.code).toBe('token_used');
    });

    it('answers malformed JSON in the partner error format', async () => {
      const res = await request(app).post('/partner/v1/sessions/redeem').set('Content-Type', 'application/json').send('{"token":');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: { code: 'invalid_request', message: expect.any(String) } });
    });

    it('is single use and returns a partner access token', async () => {
      const started = await init(initBody(id('p')));
      const ok = await redeem(started.body.oneTimeToken);
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.headers['referrer-policy']).toBe('no-referrer');
      expect(ok.body).toMatchObject({
        accessToken: expect.any(String),
        player: { id: expect.any(String), displayName: 'nik****om', language: 'ka' },
        partner: { slug: 'freecroco', name: 'Freecroco' },
      });
      const exp = new Date(ok.body.accessTokenExpiresAt).getTime() - Date.now();
      expect(exp).toBeGreaterThan(29 * 60_000);
      expect(exp).toBeLessThanOrEqual(30 * 60_000);
      const again = await redeem(started.body.oneTimeToken);
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('token_used');
    });

    it('refuses expired and unknown tokens', async () => {
      const started = await init(initBody(id('p')));
      await db.sql`UPDATE partner_sessions SET token_expires_at = now() - interval '1 millisecond' WHERE id = ${started.body.sessionId}`;
      const expired = await redeem(started.body.oneTimeToken);
      expect(expired.status).toBe(400);
      expect(expired.body.error.code).toBe('token_expired');
      const [row] = await db.sql`SELECT state, end_reason FROM partner_sessions WHERE id = ${started.body.sessionId}`;
      expect(row).toEqual({ state: 'expired', end_reason: 'expired' });
      expect((await redeem(`qbl_${'A'.repeat(43)}`)).body.error.code).toBe('token_unknown');
      expect((await redeem('short')).body.error.code).toBe('invalid_request');
    });

    it('lets exactly one of many concurrent redeems win', async () => {
      const started = await init(initBody(id('p')));
      const results = await Promise.all(Array.from({ length: 8 }, () => redeem(started.body.oneTimeToken)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status !== 200).map((r) => r.body.error.code)).toEqual(Array(7).fill('token_used'));
    });

    it('refresh issues a new token, never past the 12 h session end', async () => {
      const { access, init: started } = await launch(id('p'));
      const refreshed = await request(app).post('/partner/v1/sessions/refresh').set('Authorization', `Bearer ${access}`);
      expect(refreshed.status).toBe(200);
      await db.sql`UPDATE partner_sessions SET session_expires_at = now() + interval '10 seconds' WHERE id = ${started.sessionId}`;
      const capped = await request(app).post('/partner/v1/sessions/refresh').set('Authorization', `Bearer ${access}`);
      expect(new Date(capped.body.accessTokenExpiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10_000);
      await db.sql`UPDATE partner_sessions SET session_expires_at = now() - interval '1 second' WHERE id = ${started.sessionId}`;
      const over = await request(app).post('/partner/v1/sessions/refresh').set('Authorization', `Bearer ${access}`);
      expect(over.status).toBe(401);
      expect(over.body.error).toMatchObject({ code: 'session_ended', reason: 'expired' });
    });

    it('player routes take a bearer only, never a cookie or a launch token', async () => {
      const { access } = await launch(id('p'));
      expect((await request(app).get('/partner/v1/me/games').set('Cookie', `qb_access_token=${access}`)).body.error.code).toBe('partner_session_required');
      expect((await request(app).get('/partner/v1/me/games').set('Authorization', 'Bearer qbl_x')).status).toBe(401);
    });
  });

  describe('block / unblock', () => {
    it('blocks at once: sessions and unused tokens are revoked, init refused, unblock revives nothing', async () => {
      const playerId = id('p');
      const live = await launch(playerId);
      const pending = await init(initBody(playerId));
      const blocked = await block(playerId, 'block', new Date().toISOString(), 'fraud');
      expect(blocked.status).toBe(200);
      expect(blocked.body).toEqual({ playerId, status: 'blocked' });
      expect((await block(playerId, 'block', new Date().toISOString())).body).toEqual({ playerId, status: 'blocked' });
      const me = await request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${live.access}`);
      expect(me.status).toBe(401);
      expect(me.body.error).toMatchObject({ code: 'session_ended', reason: 'blocked' });
      expect((await redeem(pending.body.oneTimeToken)).body.error.code).toBe('player_blocked');
      const refused = await init(initBody(playerId));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('player_blocked');
      // A token revoked by the block behaves as used: its init retry is request_used.
      const [{ request_id: revokedRequest }] = await db.sql`SELECT request_id FROM partner_sessions WHERE id = ${pending.body.sessionId}`;
      expect((await init({ ...initBody(playerId), requestId: revokedRequest })).body.error.code).toBe('request_used');

      expect((await block(playerId, 'unblock', new Date().toISOString())).body).toEqual({ playerId, status: 'active' });
      expect((await request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${live.access}`)).status).toBe(401);
      const revoked = await redeem(pending.body.oneTimeToken);
      expect(revoked.status).toBe(400);
      expect(revoked.body.error.code).toBe('token_used');
      await launch(playerId);
      const audit = await db.sql`SELECT action, after->>'reason' AS reason FROM partner_audit WHERE target = ${playerId} ORDER BY id`;
      expect(audit).toEqual([{ action: 'player.block', reason: 'fraud' }, { action: 'player.unblock', reason: null }]);
    });

    it('applies a call only when its `at` is later than the last applied, always answering the current status', async () => {
      const playerId = id('p');
      await block(playerId, 'block', '2026-10-07T12:00:00.000Z');
      const stale = await block(playerId, 'unblock', '2026-10-07T11:59:59.000Z');
      expect(stale.status).toBe(200);
      expect(stale.body).toEqual({ playerId, status: 'blocked' });
      expect((await block(playerId, 'unblock', '2026-10-07T12:00:00.000Z')).body).toEqual({ playerId, status: 'blocked' });
      expect((await block(playerId, 'unblock', '2026-10-07T12:00:01+00:00')).body.status).toBe('active');
      expect((await block(playerId, 'block', '2026-10-07T12:00:00.500Z')).body.status).toBe('active');
    });

    it('can block a player before their first visit; the block applies from it', async () => {
      const playerId = id('unseen');
      expect((await block(playerId, 'block', new Date().toISOString())).status).toBe(200);
      const [row] = await db.sql`SELECT user_id, status FROM partner_players WHERE external_player_id = ${playerId}`;
      expect(row).toEqual({ user_id: null, status: 'blocked' });
      expect((await init(initBody(playerId))).body.error.code).toBe('player_blocked');
    });

    it('answers a malformed %-encoded playerId with 400 invalid_request', async () => {
      const res = await request(app).post('/partner/v1/players/%E0%A4%A/block').set('x-api-key', KEY).send({ at: new Date().toISOString() });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_request');
    });

    it('validates the body and the playerId', async () => {
      expect((await request(app).post('/partner/v1/players/p1/block').set('x-api-key', KEY).send({})).body.error.code).toBe('invalid_request');
      expect((await block('p1', 'block', 'yesterday')).status).toBe(400);
      expect((await block('p1', 'block', new Date().toISOString(), 'x'.repeat(201))).status).toBe(400);
      expect((await block('bad id', 'block', new Date().toISOString())).status).toBe(400);
    });
  });

  describe('status', () => {
    it('reports components; 503 only when something is down', async () => {
      const res = await request(app).get('/partner/v1/status').set('x-api-key', KEY);
      expect(res.status).toBe(200);
      expect(res.body.components.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([
        ['api', 'ok'], ['database', 'ok'], ['realtime', 'ok'], ['score_delivery', 'unknown'],
      ]);
      expect(res.body.status).toBe('degraded');
      redis.ready = false;
      await new Promise((r) => setTimeout(r, 5_100));
      const down = await request(app).get('/partner/v1/status').set('x-api-key', KEY);
      expect(down.status).toBe(503);
      expect(down.body.status).toBe('down');
    }, 15_000);
  });

  describe('games and quota', () => {
    it('me/games: enabled games in order (ranked first), date override beats default, limit 0 hidden', async () => {
      const { access } = await launch(id('p'));
      await setReady('true-false', true);
      const today = (await db.sql`SELECT to_char((now() AT TIME ZONE 'Asia/Tbilisi')::date, 'YYYY-MM-DD') AS d`)[0].d;
      await db.sql`INSERT INTO partner_limit_overrides (partner_slug, environment, date, game_id, plays_limit)
        VALUES ('freecroco', 'test', ${today}::date, 'countdown', 3), ('freecroco', 'test', ${today}::date, 'pick-em', 0)
        ON CONFLICT (partner_slug, environment, date, game_id) DO UPDATE SET plays_limit = EXCLUDED.plays_limit`;
      const res = await request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${access}`);
      expect(res.status).toBe(200);
      expect(res.body.partnerDay).toBe(today);
      expect(new Date(res.body.resetsAt).getUTCHours()).toBe(20);
      const ids = res.body.games.map((g: { gameId: string }) => g.gameId);
      expect(ids[0]).toBe('ranked');
      expect(ids).not.toContain('pick-em');
      expect(res.body.games.find((g: { gameId: string }) => g.gameId === 'countdown')).toEqual({
        gameId: 'countdown', playsLimit: 3, playsUsed: 0, playsLeft: 3, maxScore: 2500, available: false, inProgress: false, lastResult: null,
      });
      expect(res.body.games.find((g: { gameId: string }) => g.gameId === 'true-false').available).toBe(true);
      await db.sql`DELETE FROM partner_limit_overrides WHERE date = ${today}::date`;
      await setReady('true-false', false);
    });

    it('reservePlay never exceeds the limit under concurrency, and a retried start reuses its play', async () => {
      const { init: started, player } = await launch(id('p'));
      await setReady('career-path', true, 2);
      const attempt = (sourceRef: string) =>
        db.sql.begin((tx) => quota.reservePlay(tx, { playerId: player.id, sessionId: started.sessionId, gameId: 'career-path', sourceRef }))
          .then((play) => ({ ok: true as const, play }), (error: { code?: string }) => ({ ok: false as const, code: error.code }));
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt(`run-${started.sessionId}-${i}`)));
      expect(results.filter((r) => r.ok)).toHaveLength(2);
      expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.code)).toEqual(Array(6).fill('quota_exhausted'));
      const won = results.find((r) => r.ok)!;
      const retried = await attempt(won.ok ? won.play.sourceRef : '');
      expect(retried.ok && won.ok && retried.play.id === won.play.id).toBe(true);
      const [{ used }] = await db.sql`SELECT plays_used AS used FROM partner_quota_days WHERE player_id = ${player.id} AND game_id = 'career-path'`;
      expect(used).toBe(2);

      // Cancel with refund returns a play; finish is idempotent; a finished play cannot be cancelled.
      if (!won.ok) throw new Error('unreachable');
      await db.sql.begin((tx) => quota.cancelPlay(tx, won.play.id, { refund: true }));
      expect((await attempt(`run-${started.sessionId}-again`)).ok).toBe(true);
      const other = results.filter((r) => r.ok).map((r) => r.ok && r.play)[1] || null;
      if (other) {
        const endedAt = new Date('2026-10-05T19:59:59.000Z');
        const first = await db.sql.begin((tx) => quota.finishPlay(tx, other.id, 300, { at: endedAt }));
        expect(first.finishedAt).toEqual(endedAt);
        const second = await db.sql.begin((tx) => quota.finishPlay(tx, other.id, 300));
        expect(first).toMatchObject({ state: 'finished', score: 300 });
        expect(second.finishedAt).toEqual(first.finishedAt);
        await expect(db.sql.begin((tx) => quota.cancelPlay(tx, other.id, { refund: true }))).rejects.toMatchObject({ code: 'play_not_active' });
      }

      // A zero limit refuses the first play of the day and counts nothing.
      await setReady('career-path', true, 0);
      const { init: zeroStarted, player: zero } = await launch(id('p'));
      await expect(db.sql.begin((tx) => quota.reservePlay(tx, {
        playerId: zero.id, sessionId: zeroStarted.sessionId, gameId: 'career-path', sourceRef: `zero-${zeroStarted.sessionId}`,
      }))).rejects.toMatchObject({ code: 'quota_exhausted' });
      expect(await db.sql`SELECT 1 FROM partner_quota_days WHERE player_id = ${zero.id}`).toHaveLength(0);
      await setReady('career-path', false, 1);
    });

    it('a rules save waits for a start in progress, so a lowered limit is never exceeded', async () => {
      const { init: started, player } = await launch(id('p'));
      await setReady('guess-the-goal', true, 2);
      staff.users.set('race-admin', { id: (await db.sql`INSERT INTO users (nickname, role) VALUES (${id('ra')}, 'admin') RETURNING id`)[0].id, role: 'admin' });
      const loaded = (await request(app).get('/partner-admin/v1/partners/freecroco/games').set('Authorization', 'Bearer race-admin')).body;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = db.sql.begin(async (tx) => {
        const play = await quota.reservePlay(tx, { playerId: player.id, sessionId: started.sessionId, gameId: 'guess-the-goal', sourceRef: `${started.sessionId}-race-1` });
        await gate;
        return play;
      });
      await new Promise((r) => setTimeout(r, 150));
      let saved = false;
      const lowered = request(app).put('/partner-admin/v1/partners/freecroco/games').set('Authorization', 'Bearer race-admin')
        .send({ ...loaded, games: loaded.games.map((g: { gameId: string }) => (g.gameId === 'guess-the-goal' ? { ...g, defaultLimit: 1 } : g)) })
        .then((r) => { saved = true; return r; });
      await new Promise((r) => setTimeout(r, 300));
      expect(saved).toBe(false);
      release();
      await first;
      expect((await lowered).status).toBe(200);
      await expect(db.sql.begin((tx) => quota.reservePlay(tx, {
        playerId: player.id, sessionId: started.sessionId, gameId: 'guess-the-goal', sourceRef: `${started.sessionId}-race-2`,
      }))).rejects.toMatchObject({ code: 'quota_exhausted' });
      const restored = (await request(app).get('/partner-admin/v1/partners/freecroco/games').set('Authorization', 'Bearer race-admin')).body;
      await request(app).put('/partner-admin/v1/partners/freecroco/games').set('Authorization', 'Bearer race-admin')
        .send({ ...restored, games: loaded.games });
      await setReady('guess-the-goal', false, 1);
    });

    it('counts plays on the Tbilisi day the play starts (midnight = 20:00 UTC)', async () => {
      const { init: started, player } = await launch(id('p'));
      await setReady('higher-lower', true, 1);
      const at = (iso: string, ref: string) => db.sql.begin((tx) => quota.reservePlay(tx, {
        playerId: player.id, sessionId: started.sessionId, gameId: 'higher-lower', sourceRef: `${started.sessionId}-${ref}`, at: new Date(iso),
      }));
      const late = await at('2026-10-05T19:59:59.999Z', 'late');
      expect(late.partnerDay).toBe('2026-10-05');
      await expect(at('2026-10-05T19:00:00.000Z', 'same-day')).rejects.toMatchObject({ code: 'quota_exhausted' });
      const early = await at('2026-10-05T20:00:00.000Z', 'next-day');
      expect(early.partnerDay).toBe('2026-10-06');
      await setReady('higher-lower', false, 1);
    });

    it('me/games marks a started, unfinished play as in progress even with no plays left (so it can be reopened)', async () => {
      const { init: started, player, access } = await launch(id('p'));
      await setReady('pick-em', true, 1);
      const play = await db.sql.begin((tx) =>
        quota.reservePlay(tx, { playerId: player.id, sessionId: started.sessionId, gameId: 'pick-em', sourceRef: `${started.sessionId}-open` }));
      const tile = async () => (await request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${access}`))
        .body.games.find((g: { gameId: string }) => g.gameId === 'pick-em');
      expect(await tile()).toMatchObject({ playsLeft: 0, inProgress: true });
      await db.sql.begin((tx) => quota.finishPlay(tx, play.id, 0));
      // Ended (here: as a sweeper would while the player was away): the tile carries the result to show instead.
      expect(await tile()).toMatchObject({ playsLeft: 0, inProgress: false, lastResult: { playId: play.id, score: 0 } });
      // Two plays finished today: the latest one is the result shown.
      await setReady('pick-em', true, 2);
      const second = await db.sql.begin((tx) =>
        quota.reservePlay(tx, { playerId: player.id, sessionId: started.sessionId, gameId: 'pick-em', sourceRef: `${started.sessionId}-second` }));
      await db.sql.begin((tx) => quota.finishPlay(tx, second.id, 250));
      expect(await tile()).toMatchObject({ lastResult: { playId: second.id, score: 250 } });
      await setReady('pick-em', false, 1);
    });

    it('refuses games that are off or not ready, and blocked players; a play finished after a block is cancelled', async () => {
      const playerId = id('p');
      const { init: started, player } = await launch(playerId);
      const reserve = (gameId: 'quiz-board' | 'pick-em', ref: string) => db.sql.begin((tx) =>
        quota.reservePlay(tx, { playerId: player.id, sessionId: started.sessionId, gameId, sourceRef: `${started.sessionId}-${ref}` }));
      await expect(reserve('quiz-board', 'a')).rejects.toMatchObject({ code: 'game_not_available' });
      await setReady('pick-em', true, 1);
      const play = await reserve('pick-em', 'b');
      await block(playerId, 'block', new Date(Date.now() - 1000).toISOString());
      // Unblocked before the game reports: the play stays cancelled (no event), still used.
      await block(playerId, 'unblock', new Date().toISOString());
      const finished = await db.sql.begin((tx) => quota.finishPlay(tx, play.id, 250));
      expect(finished).toMatchObject({ state: 'cancelled', refunded: false, score: null });
      await block(playerId, 'block', new Date(Date.now() + 1000).toISOString());
      await expect(reserve('pick-em', 'c')).rejects.toMatchObject({ code: 'player_blocked' });
      await setReady('pick-em', false, 1);
    });
  });

  describe('isolation from Quizball members', () => {
    it('the ticket refill tops up members only, never partner players or partner staff', async () => {
      const [member] = await db.sql`INSERT INTO users (nickname, tickets) VALUES (${id('m')}, 0) RETURNING id`;
      const [staffer] = await db.sql`INSERT INTO users (nickname, tickets, role) VALUES (${id('s')}, 0, 'partner_staff') RETURNING id`;
      const playerId = id('p');
      await init(initBody(playerId));
      const [{ user_id: partnerUser }] = await db.sql`SELECT user_id FROM partner_players WHERE external_player_id = ${playerId}`;
      await db.sql`SELECT refill_tickets_global()`;
      const rows = await db.sql`SELECT id, tickets FROM users WHERE id IN (${member.id}, ${staffer.id}, ${partnerUser})`;
      const tickets = Object.fromEntries(rows.map((r) => [r.id, r.tickets]));
      expect(tickets).toEqual({ [member.id]: 1, [staffer.id]: 0, [partnerUser]: 0 });
    });

    it('friend search and open-by-nickname never find partner players or partner staff', async () => {
      const { usersRepo } = await import('../../src/modules/users/users.repo.js');
      const stem = id('zz');
      await db.sql`INSERT INTO users (nickname) VALUES (${`${stem}-member`})`;
      await db.sql`INSERT INTO users (nickname, role) VALUES (${`${stem}-staff`}, 'partner_staff')`;
      await db.sql`INSERT INTO users (nickname, partner_slug) VALUES (${`${stem}-partner`}, 'freecroco')`;
      const found = await usersRepo.searchByNickname(stem, randomUUID());
      expect(found.map((u) => u.nickname)).toEqual([`${stem}-member`]);
      expect(await usersRepo.findClaimableByNickname(`${stem}-member`)).not.toBeNull();
      expect(await usersRepo.findClaimableByNickname(`${stem}-staff`)).toBeNull();
      expect(await usersRepo.findClaimableByNickname(`${stem}-partner`)).toBeNull();
    });

    it('a block tells realtime subscribers which sessions and plays it ended, after it commits', async () => {
      const playerId = id('p');
      const { init: started, player } = await launch(playerId);
      await setReady('countdown', true, 1);
      const play = await db.sql.begin((tx) => quota.reservePlay(tx, {
        playerId: player.id, sessionId: started.sessionId, gameId: 'countdown', sourceRef: `${started.sessionId}-hook`,
      }));
      const seen: unknown[] = [];
      const off = events.onPartnerPlayerBlocked(async (e) => {
        const [row] = await db.sql`SELECT status FROM partner_players WHERE id = ${e.playerId}`;
        seen.push({ ...e, committedStatus: row.status });
      });
      try {
        await block(playerId, 'block', new Date().toISOString());
        await block(playerId, 'block', new Date().toISOString());
      } finally {
        off();
        await setReady('countdown', false, 1);
      }
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        playerId: player.id, externalPlayerId: playerId, userId: expect.any(String),
        revokedSessionIds: [started.sessionId], cancelledPlayIds: [play.id], committedStatus: 'blocked',
      });
      expect(seen[1]).toMatchObject({ revokedSessionIds: [], cancelledPlayIds: [] });
    });
  });

  describe('admin API', () => {
    const ADMIN = 'admin-token';
    const EDITOR = 'editor-token';
    const VIEWER = 'viewer-token';
    const OUTSIDER = 'outsider-token';
    const MEMBER = 'member-token';
    const base = '/partner-admin/v1/partners/freecroco';

    beforeAll(async () => {
      const make = async (token: string, role: string, membership?: 'viewer' | 'editor') => {
        const [user] = await db.sql`INSERT INTO users (nickname, role) VALUES (${id(token)}, ${role}) RETURNING id`;
        if (membership) await db.sql`INSERT INTO partner_operator_memberships (partner_slug, user_id, role) VALUES ('freecroco', ${user.id}, ${membership})`;
        staff.users.set(token, { id: user.id, role });
      };
      await make(ADMIN, 'admin');
      await make(EDITOR, 'partner_staff', 'editor');
      await make(VIEWER, 'partner_staff', 'viewer');
      await make(OUTSIDER, 'partner_staff');
      await make(MEMBER, 'user', 'editor');
    });

    const as = (token: string) => ({
      get: (path: string) => request(app).get(`${base}${path}`).set('Authorization', `Bearer ${token}`),
      put: (path: string, body: unknown) => request(app).put(`${base}${path}`).set('Authorization', `Bearer ${token}`).send(body),
    });

    it('requires a bearer from an admin or a member of this partner; writes need an editor', async () => {
      expect((await request(app).get(`${base}/games`)).body.error.code).toBe('unauthorized');
      expect((await request(app).get(`${base}/games`).set('Cookie', `qb_access_token=${ADMIN}`)).status).toBe(401);
      expect((await as('nobody').get('/games')).status).toBe(401);
      expect((await as(OUTSIDER).get('/games')).status).toBe(403);
      expect((await as(MEMBER).get('/games')).status).toBe(403);
      expect((await as(VIEWER).get('/games')).status).toBe(200);
      const current = (await as(VIEWER).get('/games')).body;
      expect((await as(VIEWER).put('/games', current)).status).toBe(403);
    });

    it('games: compare-and-set, bounds, ready is read-only, every save audited', async () => {
      const loaded = (await as(EDITOR).get('/games')).body;
      expect(loaded.games.map((g: { gameId: string }) => g.gameId)).toEqual([
        'ranked', 'guess-the-goal', 'true-false', 'countdown', 'pick-em', 'career-path', 'higher-lower',
        'card-detective', 'road-to-goal', 'trivia-mines', 'quiz-board',
      ]);
      const swapped = {
        version: loaded.version,
        games: loaded.games.map((g: { gameId: string; order: number }) => ({
          ...g,
          order: g.gameId === 'ranked' ? 2 : g.gameId === 'guess-the-goal' ? 1 : g.order,
          enabled: g.gameId !== 'quiz-board',
          defaultLimit: g.gameId === 'ranked' ? 30 : 2,
          ready: true,
        })),
      };
      const saved = await as(EDITOR).put('/games', swapped);
      expect(saved.status).toBe(200);
      expect(saved.body.version).toBe(loaded.version + 1);
      expect(saved.body.games[0]).toMatchObject({ gameId: 'guess-the-goal', order: 1, defaultLimit: 2, ready: false });
      expect(saved.body.games.find((g: { gameId: string }) => g.gameId === 'quiz-board').enabled).toBe(false);

      const stale = await as(ADMIN).put('/games', swapped);
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('stale_version');

      const next = { ...saved.body };
      const bad = (games: unknown) => as(ADMIN).put('/games', { ...next, games });
      expect((await bad(next.games.map((g: { gameId: string }) => ({ ...g, defaultLimit: g.gameId === 'ranked' ? 31 : 1 })))).status).toBe(400);
      expect((await bad(next.games.map((g: { gameId: string }) => ({ ...g, defaultLimit: g.gameId === 'countdown' ? 11 : 1 })))).status).toBe(400);
      expect((await bad(next.games.map((g: object) => ({ ...g, order: 1 })))).status).toBe(400);
      expect((await bad(next.games.slice(1))).status).toBe(400);
      expect((await bad([...next.games.slice(1), next.games[1]])).status).toBe(400);

      // Restore the seeded order for the other tests.
      const restored = await as(ADMIN).put('/games', { version: saved.body.version, games: loaded.games });
      expect(restored.status).toBe(200);
      const audits = await db.sql`SELECT actor, action FROM partner_audit WHERE action = 'games.update' ORDER BY id DESC LIMIT 2`;
      expect(audits).toEqual([
        { actor: `user:${staff.users.get(ADMIN)!.id}`, action: 'games.update' },
        { actor: `user:${staff.users.get(EDITOR)!.id}`, action: 'games.update' },
      ]);
    });

    it('two saves of the same version at once: exactly one wins', async () => {
      const loaded = (await as(EDITOR).get('/games')).body;
      const [a, b] = await Promise.all([as(EDITOR).put('/games', loaded), as(ADMIN).put('/games', loaded)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect((await as(VIEWER).get('/games')).body.version).toBe(loaded.version + 1);
      const cal = (await as(VIEWER).get('/calendar')).body;
      const [c, d] = await Promise.all([as(EDITOR).put('/calendar', { version: cal.version, changes: [] }), as(ADMIN).put('/calendar', { version: cal.version, changes: [] })]);
      expect([c.status, d.status].sort()).toEqual([200, 409]);
    });

    it('calendar: today..+90 only, at most 100 changes, null removes, compare-and-set', async () => {
      const today = (await db.sql`SELECT to_char((now() AT TIME ZONE 'Asia/Tbilisi')::date, 'YYYY-MM-DD') AS d`)[0].d as string;
      const plus = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
      const loaded = (await as(VIEWER).get('/calendar')).body;
      const saved = await as(EDITOR).put('/calendar', {
        version: loaded.version,
        changes: [{ date: today, gameId: 'ranked', limit: 20 }, { date: plus(90), gameId: 'countdown', limit: 0 }],
      });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        version: loaded.version + 1,
        overrides: [{ date: today, gameId: 'ranked', limit: 20 }, { date: plus(90), gameId: 'countdown', limit: 0 }],
      });
      const bad = (changes: unknown) => as(EDITOR).put('/calendar', { version: saved.body.version, changes });
      expect((await bad([{ date: plus(-1), gameId: 'ranked', limit: 1 }])).status).toBe(400);
      expect((await bad([{ date: plus(91), gameId: 'ranked', limit: 1 }])).status).toBe(400);
      expect((await bad([{ date: today, gameId: 'ranked', limit: 31 }])).status).toBe(400);
      expect((await bad([{ date: today, gameId: 'pick-em', limit: 11 }])).status).toBe(400);
      expect((await bad([{ date: '2026-02-30', gameId: 'ranked', limit: 1 }])).status).toBe(400);
      expect((await bad(Array.from({ length: 101 }, (_, i) => ({ date: plus(i % 90), gameId: 'ranked', limit: 1 })))).status).toBe(400);
      expect((await bad([{ date: today, gameId: 'ranked', limit: 1 }, { date: today, gameId: 'ranked', limit: 2 }])).status).toBe(400);
      expect((await as(EDITOR).put('/calendar', { version: loaded.version, changes: [] })).body.error.code).toBe('stale_version');

      const removed = await bad([{ date: today, gameId: 'ranked', limit: null }]);
      expect(removed.body.overrides).toEqual([{ date: plus(90), gameId: 'countdown', limit: 0 }]);
      const window = await as(VIEWER).get(`/calendar?from=${plus(80)}&to=${plus(90)}`);
      expect(window.body.overrides).toHaveLength(1);
      expect((await as(VIEWER).get(`/calendar?from=${plus(5)}&to=${plus(1)}`)).status).toBe(400);

      // Insert, update and remove (of a date with nothing set) in one save; the audit keeps the previous values in
      // the order of the changes.
      const lastAudit = async () => (await db.sql`
        SELECT actor, before, after FROM partner_audit WHERE action = 'calendar.update' ORDER BY id DESC LIMIT 1`)[0];
      const mixedChanges = [
        { date: plus(3), gameId: 'pick-em', limit: 3 },
        { date: plus(90), gameId: 'countdown', limit: 5 },
        { date: plus(2), gameId: 'ranked', limit: null },
      ];
      const mixed = await as(ADMIN).put('/calendar', { version: removed.body.version, changes: mixedChanges });
      expect(mixed.status).toBe(200);
      expect(mixed.body).toEqual({
        version: removed.body.version + 1,
        overrides: [{ date: plus(3), gameId: 'pick-em', limit: 3 }, { date: plus(90), gameId: 'countdown', limit: 5 }],
      });
      expect(await lastAudit()).toEqual({
        actor: `user:${staff.users.get(ADMIN)!.id}`,
        before: [{ date: plus(90), gameId: 'countdown', limit: 0 }],
        after: mixedChanges,
      });

      // The full 100 changes in one save.
      const many = [
        ...Array.from({ length: 99 }, (_, i) => ({ date: plus(Math.floor(i / 2) + 10), gameId: i % 2 ? 'ranked' : 'countdown', limit: 1 })),
        { date: plus(3), gameId: 'pick-em', limit: null },
      ];
      const full = await as(EDITOR).put('/calendar', { version: mixed.body.version, changes: many });
      expect(full.status).toBe(200);
      expect(full.body.version).toBe(mixed.body.version + 1);
      expect(full.body.overrides).toHaveLength(100);
      expect(full.body.overrides.some((o: { gameId: string }) => o.gameId === 'pick-em')).toBe(false);
      expect(await lastAudit()).toMatchObject({ before: [{ date: plus(3), gameId: 'pick-em', limit: 3 }], after: many });
      const [{ by }] = await db.sql`SELECT DISTINCT updated_by::text AS by FROM partner_limit_overrides WHERE date = ${plus(10)}::date`;
      expect(by).toBe(staff.users.get(EDITOR)!.id);
      expect((await as(ADMIN).put('/calendar', { version: mixed.body.version, changes: [] })).status).toBe(409);
      await db.sql`DELETE FROM partner_limit_overrides`;
    });

    it('ranked points: staff read, Quizball admins save; compare-and-set, bounds, audited; me/games follows', async () => {
      const loaded = (await as(VIEWER).get('/ranked-points')).body;
      expect(loaded).toMatchObject({ maxScore: 500, points: { drawAfterPenalties: 60, leftNotAhead: 100 } });
      expect(loaded.points.margins).toHaveLength(6);
      const edited = { ...loaded.points, leftNotAhead: 700 };
      expect((await as(EDITOR).put('/ranked-points', { version: loaded.version, points: edited })).status).toBe(403);
      expect((await as(VIEWER).put('/ranked-points', { version: loaded.version, points: edited })).status).toBe(403);

      const bad = (points: unknown) => as(ADMIN).put('/ranked-points', { version: loaded.version, points });
      expect((await bad({ ...loaded.points, leftNotAhead: 5001 })).status).toBe(400);
      expect((await bad({ ...loaded.points, drawAfterPenalties: 1.5 })).status).toBe(400);
      expect((await bad({ ...loaded.points, margins: loaded.points.margins.slice(1) })).status).toBe(400);
      expect((await bad({ ...loaded.points, penaltyWin: { winner: 40, loser: 50 } })).status).toBe(400);

      const saved = await as(ADMIN).put('/ranked-points', { version: loaded.version, points: edited });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({ version: loaded.version + 1, points: edited, maxScore: 700 });
      const stale = await as(ADMIN).put('/ranked-points', { version: loaded.version, points: loaded.points });
      expect(stale.status).toBe(409);
      expect(stale.body.error.code).toBe('stale_version');
      const [audit] = await db.sql`SELECT actor, before->'points'->>'leftNotAhead' AS before, after->'points'->>'leftNotAhead' AS after
        FROM partner_audit WHERE action = 'ranked_points.update' ORDER BY id DESC LIMIT 1`;
      expect(audit).toEqual({ actor: `user:${staff.users.get(ADMIN)!.id}`, before: '100', after: '700' });

      const { access } = await launch(id('p'));
      const me = await request(app).get('/partner/v1/me/games').set('Authorization', `Bearer ${access}`);
      expect(me.body.games.find((g: { gameId: string }) => g.gameId === 'ranked').maxScore).toBe(700);
      expect((await as(ADMIN).put('/ranked-points', { version: saved.body.version, points: loaded.points })).status).toBe(200);
    });

    it('players: the view of one partner player, 404 for an unknown one', async () => {
      const playerId = id('p');
      await launch(playerId);
      const view = await as(VIEWER).get(`/players/${playerId}`);
      expect(view.status).toBe(200);
      expect(view.body).toMatchObject({ playerId, displayName: 'nik****om', status: 'active', lastSeenAt: expect.any(String) });
      expect(view.body.today[0]).toEqual({ gameId: 'ranked', playsUsed: 0, playsLimit: 10 });
      const missing = await as(VIEWER).get('/players/nobody-here');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('unknown_player');
    });
  });
});
