import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

/**
 * Freecroco PostHog events on real PostgreSQL, trackEvent mocked: each lifecycle event is sent once, only after its
 * transaction commits, with the users.id as distinct_id and never the partner's playerId.
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
const track = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/analytics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/analytics.js')>()),
  trackEvent: track,
}));

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
].map((f) => join(__dirname, '../../supabase/migrations', f));

const FIXTURE = `
  DROP TABLE IF EXISTS partner_ranked_entries, partner_ranked_points, partner_score_event_attempts, partner_score_events, partner_plays,
    partner_quota_days, partner_audit, partner_limit_overrides, partner_games, partner_config_versions,
    partner_sessions, partner_players, partner_operator_memberships, match_players, matches, ranked_profiles,
    audit_logs, users CASCADE;
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
  CREATE TABLE ranked_profiles (user_id uuid PRIMARY KEY REFERENCES users(id), rp integer);
  CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL, entity_type text NOT NULL, entity_id uuid, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text NOT NULL DEFAULT 'ranked',
    status text NOT NULL DEFAULT 'active', winner_user_id uuid, ended_at timestamptz, state_payload jsonb
  );
  CREATE TABLE match_players (
    match_id uuid NOT NULL REFERENCES matches(id), user_id uuid NOT NULL, seat smallint NOT NULL,
    total_points integer NOT NULL DEFAULT 0, correct_answers integer NOT NULL DEFAULT 0,
    goals integer NOT NULL DEFAULT 0, penalty_goals integer NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, user_id)
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

type Sent = { event: string; distinctId: string; props: Record<string, unknown> };

describe.skipIf(!isolated && !adminTarget)('partner analytics on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let analytics: typeof import('../../src/modules/partners/partner-analytics.js');
  let kit: typeof import('../../src/modules/partners/games/kit.js');
  let quota: typeof import('../../src/modules/partners/partner-quota.service.js');
  let entries: typeof import('../../src/modules/partners/games/ranked/ranked-entries.js');
  let sessions: typeof import('../../src/modules/partners/partner-sessions.service.js');
  let auth: typeof import('../../src/modules/partners/partner-player-auth.js');
  let partnerConfig: typeof import('../../src/modules/partners/partner-config.js');
  let delivery: typeof import('../../src/modules/partners/delivery/dispatcher.js');
  let logger: typeof import('../../src/core/logger.js')['logger'];

  beforeAll(async () => {
    process.env.PARTNER_JWT_SECRET = 'analytics-test-partner-jwt-secret-32-bytes';
    process.env.PARTNER_RESPONSE_SEAL_KEY = 'analytics-test-partner-seal-key-32-bytes!!';
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_analytics_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 8, onnotice: () => undefined });
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));

    partnerConfig = await import('../../src/modules/partners/partner-config.js');
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco',
      environment: 'test',
      inboundKeySha256: [partnerConfig.sha256Hex(KEY)],
      allowedCidrs: ['127.0.0.1/32'],
      launchBaseUrl: 'https://staging-freecroco.quizball.io',
    });
    partnerConfig.resetPartnerConfigCache();
    analytics = await import('../../src/modules/partners/partner-analytics.js');
    kit = await import('../../src/modules/partners/games/kit.js');
    quota = await import('../../src/modules/partners/partner-quota.service.js');
    entries = await import('../../src/modules/partners/games/ranked/ranked-entries.js');
    sessions = await import('../../src/modules/partners/partner-sessions.service.js');
    auth = await import('../../src/modules/partners/partner-player-auth.js');
    delivery = await import('../../src/modules/partners/delivery/dispatcher.js');
    ({ logger } = await import('../../src/core/logger.js'));
    await db.sql`UPDATE partner_games SET enabled = true, ready = true, default_limit = 3
                 WHERE partner_slug = 'freecroco' AND environment = 'test'`;
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
    track.mockClear();
  });

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;
  const config = () => partnerConfig.getFreecrocoConfig()!;

  const sent = (event?: string): Sent[] => track.mock.calls
    .map(([e, distinctId, props]) => ({ event: e as string, distinctId: distinctId as string, props: props as Record<string, unknown> }))
    .filter((s) => !event || s.event === event);

  async function launch(playerId = id('p'), language: 'en' | 'ka' = 'en') {
    const started = await sessions.initSession(config(), {
      playerId, language, channel: 'MOBILE', requestId: id('req'), username: 'nik****om',
    } as never);
    const redeemed = await sessions.redeemSession(config(), started.oneTimeToken);
    return { ...(await auth.resolvePartnerPrincipal(redeemed.accessToken)), external: playerId };
  }

  async function start(p: Awaited<ReturnType<typeof launch>>, gameId: 'countdown' | 'ranked' = 'countdown', ref = id('ref')) {
    return (await kit.startPartnerPlay(p, gameId, ref, async () => null)).play;
  }

  /** No property value anywhere equals the partner's own playerId. */
  const noExternalId = (external: string) => {
    for (const s of sent()) expect(Object.values(s.props)).not.toContain(external);
  };

  describe('sessions', () => {
    it('a redeem sends partner_session_started; the next launch replaces it (ended: replaced, not new)', async () => {
      const p = await launch(id('p'), 'ka');
      expect(sent()).toEqual([{
        event: 'partner_session_started',
        distinctId: p.userId,
        props: { language: 'ka', channel: 'MOBILE', is_new_player: true, partner_slug: 'freecroco', partner_environment: 'test' },
      }]);
      track.mockClear();
      const again = await launch(p.external);
      expect(sent().map((s) => [s.event, s.props.reason ?? s.props.is_new_player])).toEqual([
        ['partner_session_ended', 'replaced'],
        ['partner_session_started', false],
      ]);
      expect(sent().every((s) => s.distinctId === again.userId)).toBe(true);
      noExternalId(p.external);
    });

    it('a failed redeem sends nothing', async () => {
      const started = await sessions.initSession(config(), {
        playerId: id('p'), language: 'en', channel: 'WEB', requestId: id('req'),
      } as never);
      await sessions.redeemSession(config(), started.oneTimeToken);
      track.mockClear();
      await expect(sessions.redeemSession(config(), started.oneTimeToken)).rejects.toMatchObject({ code: 'token_used' });
      expect(sent()).toEqual([]);
    });
  });

  describe('plays', () => {
    it('a start sends partner_play_started once; a retried start sends nothing more', async () => {
      const p = await launch();
      track.mockClear();
      const ref = id('ref');
      const play = await start(p, 'countdown', ref);
      await start(p, 'countdown', ref);
      expect(sent()).toEqual([{
        event: 'partner_play_started',
        distinctId: p.userId,
        props: expect.objectContaining({ game_id: 'countdown', plays_used_today: 1, plays_limit: 3, partner_slug: 'freecroco' }),
      }]);
      expect(track.mock.calls[0]![3]).toMatchObject({ occurredAt: play.startedAt, uuid: expect.any(String) });
      noExternalId(p.external);
    });

    it('a start that rolls back sends nothing', async () => {
      const p = await launch();
      track.mockClear();
      await expect(kit.startPartnerPlay(p, 'countdown', id('ref'), async () => {
        throw new Error('create failed');
      })).rejects.toThrow('create failed');
      expect(sent()).toEqual([]);
    });

    it('a finish sends partner_play_finished once, after commit, never for a rolled-back finish', async () => {
      const p = await launch();
      const play = await start(p);
      track.mockClear();
      await expect(analytics.partnerBegin(async (tx) => {
        await kit.settlePartnerPlay(tx, play.id, 900, undefined, undefined, { endCause: 'completed' });
        throw new Error('result write failed');
      })).rejects.toThrow('result write failed');
      expect(sent()).toEqual([]);

      await analytics.partnerBegin((tx) => kit.settlePartnerPlay(tx, play.id, 900, undefined, undefined, { endCause: 'completed' }));
      await analytics.partnerBegin((tx) => kit.settlePartnerPlay(tx, play.id, 900));
      expect(sent()).toEqual([{
        event: 'partner_play_finished',
        distinctId: p.userId,
        props: expect.objectContaining({
          game_id: 'countdown', score: 900, max_score: 2500, end_cause: 'completed', duration_ms: expect.any(Number),
        }),
      }]);
      expect(sent()[0]!.props).not.toHaveProperty('outcome');
    });

    it('a returned play sends partner_play_cancelled (returned) once', async () => {
      const p = await launch();
      const play = await start(p);
      track.mockClear();
      await analytics.partnerBegin((tx) => quota.cancelPlay(tx, play.id, { refund: true }));
      await analytics.partnerBegin((tx) => quota.cancelPlay(tx, play.id, { refund: true }));
      expect(sent()).toEqual([{
        event: 'partner_play_cancelled',
        distinctId: p.userId,
        props: expect.objectContaining({ game_id: 'countdown', reason: 'returned', refunded: true }),
      }]);
    });

    it('a savepoint that rolls back drops its events; the enclosing commit sends the rest', async () => {
      const p = await launch();
      const kept = await start(p);
      const undone = await start(p);
      track.mockClear();
      await analytics.partnerBegin(async (tx) => {
        await expect(analytics.partnerSavepoint(tx, async (sp) => {
          await kit.settlePartnerPlay(sp, undone.id, 10);
          throw new Error('step failed');
        })).rejects.toThrow('step failed');
        await analytics.partnerSavepoint(tx, (sp) => kit.settlePartnerPlay(sp, kept.id, 20));
      });
      expect(sent().map((s) => s.props.score)).toEqual([20]);
    });

    it('an event recorded on a transaction partnerBegin did not open is dropped with an error log', async () => {
      const p = await launch();
      const play = await start(p);
      track.mockClear();
      const error = vi.spyOn(logger, 'error');
      await db.sql.begin((tx) => kit.settlePartnerPlay(tx as never, play.id, 5));
      expect(sent()).toEqual([]);
      expect(error).toHaveBeenCalledWith({ event: 'partner_play_finished' }, expect.stringMatching(/outside partnerBegin/));
      error.mockRestore();
    });
  });

  describe('block and unblock', () => {
    it('a block ends the open session and running play, once; a finish afterwards sends nothing', async () => {
      const p = await launch();
      const play = await start(p);
      track.mockClear();
      const at = new Date();
      await sessions.setPlayerStatus(config(), p.external, 'blocked', { at, reason: 'self-exclusion' });
      await sessions.setPlayerStatus(config(), p.external, 'blocked', { at, reason: null });
      expect(sent().map((s) => s.event).sort()).toEqual(['partner_play_cancelled', 'partner_player_blocked', 'partner_session_ended']);
      expect(sent('partner_play_cancelled')[0]!.props).toMatchObject({ game_id: 'countdown', reason: 'blocked', refunded: false });
      expect(sent('partner_session_ended')[0]!.props).toMatchObject({ reason: 'blocked' });
      expect(sent('partner_player_blocked')[0]).toMatchObject({
        distinctId: p.userId, props: { ended_sessions: 1, cancelled_plays: 1 },
      });
      for (const s of sent()) expect(JSON.stringify(s.props)).not.toContain('self-exclusion');

      track.mockClear();
      await analytics.partnerBegin((tx) => kit.settlePartnerPlay(tx, play.id, 100));
      expect(sent()).toEqual([]);

      await sessions.setPlayerStatus(config(), p.external, 'active', { at: new Date(at.getTime() + 1000), reason: null });
      expect(sent()).toEqual([{ event: 'partner_player_unblocked', distinctId: p.userId, props: expect.objectContaining({ partner_slug: 'freecroco' }) }]);
      noExternalId(p.external);
    });

    it('a player blocked before ever launching sends nothing (no users row to attribute it to)', async () => {
      await sessions.setPlayerStatus(config(), id('p'), 'blocked', { at: new Date(), reason: null });
      expect(sent()).toEqual([]);
    });
  });

  describe('ranked', () => {
    async function bot() {
      const [row] = await db.sql<{ id: string }[]>`
        INSERT INTO users (nickname, is_ai, ai_kind) VALUES (${id('bot')}, true, 'persistent') RETURNING id`;
      return row.id;
    }

    async function match(players: Array<{ userId: string; goals?: number }>, partnerUserIds: string[]) {
      const [m] = await db.sql<{ id: string }[]>`INSERT INTO matches (partner_pool) VALUES ('freecroco-test') RETURNING id`;
      for (const [index, pl] of players.entries()) {
        await db.sql`INSERT INTO match_players (match_id, user_id, seat, goals)
          VALUES (${m.id}, ${pl.userId}, ${index + 1}, ${pl.goals ?? 0})`;
      }
      await analytics.partnerBegin((tx) => entries.attachPartnerRankedEntriesInTx(tx, {
        matchId: m.id, lobbyId: randomUUID(), userIds: partnerUserIds,
      }));
      return m.id;
    }

    const end = (matchId: string, cause: Parameters<typeof entries.settlePartnerRankedMatchSafely>[2]) =>
      analytics.partnerBegin(async (tx) => {
        await tx`UPDATE matches SET status = 'completed', ended_at = now() WHERE id = ${matchId}`;
        await entries.settlePartnerRankedMatchSafely(tx, matchId, cause);
      });

    it('Freecroco vs Freecroco: match found for both, then win/loss with margin, once', async () => {
      const [a, b] = [await launch(), await launch()];
      await entries.reservePartnerRankedPlay(a);
      await entries.reservePartnerRankedPlay(b);
      expect(sent('partner_play_started').map((s) => s.props.game_id)).toEqual(['ranked', 'ranked']);
      track.mockClear();
      const matchId = await match([{ userId: a.userId, goals: 3 }, { userId: b.userId, goals: 1 }], [a.userId, b.userId]);
      expect(sent('partner_ranked_match_found').map((s) => [s.distinctId, s.props.opponent_kind])).toEqual([
        [a.userId, 'partner'], [b.userId, 'partner'],
      ]);
      track.mockClear();
      await end(matchId, { kind: 'natural' });
      await end(matchId, { kind: 'natural' });
      const finished = sent('partner_play_finished');
      expect(finished).toHaveLength(2);
      expect(finished.find((s) => s.distinctId === a.userId)!.props).toMatchObject({
        game_id: 'ranked', score: 150, outcome: 'win', goal_margin: 2, end_cause: 'natural', opponent_kind: 'partner',
      });
      expect(finished.find((s) => s.distinctId === b.userId)!.props).toMatchObject({
        score: 40, outcome: 'loss', goal_margin: -2, opponent_kind: 'partner',
      });
      noExternalId(a.external);
    });

    it('vs a bot: match found says bot; the bot never gets an event', async () => {
      const p = await launch();
      await entries.reservePartnerRankedPlay(p);
      const botId = await bot();
      track.mockClear();
      const matchId = await match([{ userId: p.userId, goals: 1 }, { userId: botId }], [p.userId]);
      await end(matchId, { kind: 'natural' });
      expect(sent().map((s) => [s.event, s.props.opponent_kind])).toEqual([
        ['partner_ranked_match_found', 'bot'],
        ['partner_play_finished', 'bot'],
      ]);
      expect(sent().every((s) => s.distinctId === p.userId)).toBe(true);
    });

    it('an early leave and a cancelled search send partner_play_cancelled with their reason', async () => {
      const [a, b] = [await launch(), await launch()];
      await entries.reservePartnerRankedPlay(a);
      await entries.reservePartnerRankedPlay(b);
      const matchId = await match([{ userId: a.userId }, { userId: b.userId }], [a.userId, b.userId]);
      track.mockClear();
      await end(matchId, { kind: 'early_leave', leaverUserId: a.userId });
      expect(sent('partner_play_cancelled').map((s) => [s.distinctId, s.props.reason, s.props.refunded])).toEqual([
        [a.userId, 'early_leave', false], [b.userId, 'early_leave', true],
      ].sort((x, y) => (x[0] as string).localeCompare(y[0] as string)));

      const c = await launch();
      await entries.reservePartnerRankedPlay(c);
      track.mockClear();
      await entries.releasePartnerRankedSearch(c.userId, 'test');
      expect(sent()).toEqual([{
        event: 'partner_play_cancelled', distinctId: c.userId,
        props: expect.objectContaining({ game_id: 'ranked', reason: 'search_cancelled', refunded: true }),
      }]);
    });

    it('a match creation that rolls back sends no match found', async () => {
      const p = await launch();
      await entries.reservePartnerRankedPlay(p);
      const botId = await bot();
      const [m] = await db.sql<{ id: string }[]>`INSERT INTO matches (partner_pool) VALUES ('freecroco-test') RETURNING id`;
      await db.sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${m.id}, ${p.userId}, 1), (${m.id}, ${botId}, 2)`;
      track.mockClear();
      await expect(analytics.partnerBegin(async (tx) => {
        await entries.attachPartnerRankedEntriesInTx(tx, { matchId: m.id, lobbyId: randomUUID(), userIds: [p.userId] });
        throw new Error('reservation transfer failed');
      })).rejects.toThrow('reservation transfer failed');
      expect(sent()).toEqual([]);
    });
  });

  describe('score delivery', () => {
    function dispatcher(status: number, onFinal: (o: unknown) => void) {
      return new delivery.ScoreEventDispatcher({
        sql: db.sql,
        destination: () => ({ slug: 'freecroco', environment: 'test', url: 'https://partner.invalid/score', apiKey: 'k' }),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        pollMs: 60_000,
        fetch: (async () => new Response(null, { status })) as typeof fetch,
        onFinal: onFinal as never,
      });
    }

    async function finishedPlay() {
      const p = await launch();
      const play = await start(p);
      await analytics.partnerBegin((tx) => kit.settlePartnerPlay(tx, play.id, 77));
      return { p, play };
    }

    it('delivered and dead each report once, as partner_score_delivered / partner_score_delivery_failed', async () => {
      await db.sql`UPDATE partner_score_events SET status = 'sent' WHERE status = 'pending'`;
      const ok = await finishedPlay();
      const finals: Array<{ eventId: string; status: string; attempts: number; lastError: string | null }> = [];
      const sender = dispatcher(200, (o) => finals.push(o as never));
      sender.wake();
      await sender.idle();
      expect(finals).toEqual([{ eventId: `qb_${ok.play.id}`, status: 'sent', attempts: 1, lastError: null }]);

      const bad = await finishedPlay();
      const deadSender = dispatcher(422, (o) => finals.push(o as never));
      deadSender.wake();
      await deadSender.idle();
      expect(finals[1]).toEqual({ eventId: `qb_${bad.play.id}`, status: 'dead', attempts: 1, lastError: 'http_422' });

      track.mockClear();
      for (const o of finals) await analytics.trackScoreDeliveryOutcome(o as never);
      expect(sent()).toEqual([
        {
          event: 'partner_score_delivered', distinctId: ok.p.userId,
          props: expect.objectContaining({ game_id: 'countdown', attempts: 1, delivery_delay_ms: expect.any(Number) }),
        },
        {
          event: 'partner_score_delivery_failed', distinctId: bad.p.userId,
          props: expect.objectContaining({ game_id: 'countdown', attempts: 1, final_status: 'dead', last_error: 'http_422' }),
        },
      ]);
      noExternalId(ok.p.external);
      await sender.close(1_000);
      await deadSender.close(1_000);
    });
  });
});
