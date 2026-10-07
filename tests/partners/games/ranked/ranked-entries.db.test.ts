import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from '../../test-db.js';
import { DEFAULT_RANKED_POINTS } from '../../../../src/modules/partners/games/ranked/ranked-points.js';

/**
 * Freecroco ranked plays on real PostgreSQL: reservation on queue join, the pre-match refund, admission and attach at
 * match creation, settlement by the contract §7.1 tables (one event per Freecroco player, none for a blocked one),
 * idempotency and the reconciler. Runs against an isolated database or CI's admin connection:
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

// The socket layer around the block hook; the partner state it reads and changes stays on real Postgres.
const rt = vi.hoisted(() => ({
  forfeit: vi.fn(),
  queueCleanup: vi.fn(),
  /** Runs between the reconciler's scan and its per-player work (the batched state read sits there). */
  afterScan: async () => undefined as void,
  batchedState: 'IDLE',
}));
vi.mock('../../../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    withUserSessionLock: async (_userId: string, work: () => Promise<unknown>) => work(),
    cleanupRankedQueueArtifacts: (...a: unknown[]) => rt.queueCleanup(...a),
    resolveStates: async (userIds: string[]) => {
      await rt.afterScan();
      return new Map(userIds.map((u) => [u, { state: rt.batchedState, activeMatchId: null }]));
    },
    resolveState: async () => ({ state: 'IDLE', activeMatchId: null }),
  },
}));
vi.mock('../../../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: async (matchId: string) =>
      (await db.sql`SELECT id, status, 0 AS current_q_index FROM matches WHERE id = ${matchId}`)[0] ?? null,
  },
}));
vi.mock('../../../../src/realtime/services/match-participants.helpers.js', () => ({
  getParticipantSnapshot: async (matchId: string) => ({
    participants: await db.sql`SELECT user_id, seat FROM match_players WHERE match_id = ${matchId}`,
    cache: null,
  }),
}));
vi.mock('../../../../src/realtime/services/match-presence.service.js', () => ({
  resolveMatchPresence: async () => ({ absentPlayers: [], presentPlayers: [], exitPendingUserIds: [] }),
}));
vi.mock('../../../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...a: unknown[]) => rt.forfeit(...a),
  buildOpponentForfeitPendingPayload: () => ({}),
}));
vi.mock('../../../../src/realtime/possession-completion.js', () => ({ completePossessionMatchFromProgress: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-disconnect.service.js', () => ({ abandonPossessionTerminalMatch: vi.fn() }));
vi.mock('../../../../src/realtime/services/match-final-results.service.js', () => ({
  buildFinalResultsPayload: async () => null,
  emitFinalResultsToMatchParticipants: vi.fn(),
}));
vi.mock('../../../../src/realtime/match-flow.js', () => ({ cancelMatchQuestionTimer: vi.fn() }));
vi.mock('../../../../src/realtime/possession-match-flow.js', () => ({ cancelPossessionHalftimeTimer: vi.fn() }));

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
].map((f) => join(__dirname, '../../../../supabase/migrations', f));

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

describe.skipIf(!isolated && !adminTarget)('partner ranked plays on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let entries: typeof import('../../../../src/modules/partners/games/ranked/ranked-entries.js');
  let sessions: typeof import('../../../../src/modules/partners/partner-sessions.service.js');
  let auth: typeof import('../../../../src/modules/partners/partner-player-auth.js');
  let partnerConfig: typeof import('../../../../src/modules/partners/partner-config.js');
  let partnerAdmin: typeof import('../../../../src/modules/partners/partner-admin.service.js');
  let realtime: typeof import('../../../../src/modules/partners/games/ranked/ranked-realtime.js');
  let partnerEvents: typeof import('../../../../src/modules/partners/partner-events.js');

  beforeAll(async () => {
    process.env.PARTNER_JWT_SECRET = 'ranked-test-partner-jwt-secret-32-bytes';
    process.env.PARTNER_RESPONSE_SEAL_KEY = 'ranked-test-partner-seal-key-32-bytes!!';
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_ranked_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 8, onnotice: () => undefined });
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));

    partnerConfig = await import('../../../../src/modules/partners/partner-config.js');
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco',
      environment: 'test',
      inboundKeySha256: [partnerConfig.sha256Hex(KEY)],
      allowedCidrs: ['127.0.0.1/32'],
      launchBaseUrl: 'https://staging-freecroco.quizball.io',
    });
    partnerConfig.resetPartnerConfigCache();
    entries = await import('../../../../src/modules/partners/games/ranked/ranked-entries.js');
    sessions = await import('../../../../src/modules/partners/partner-sessions.service.js');
    auth = await import('../../../../src/modules/partners/partner-player-auth.js');
    partnerAdmin = await import('../../../../src/modules/partners/partner-admin.service.js');
    realtime = await import('../../../../src/modules/partners/games/ranked/ranked-realtime.js');
    partnerEvents = await import('../../../../src/modules/partners/partner-events.js');
    await db.sql`UPDATE partner_games SET ready = true, default_limit = 3
                 WHERE partner_slug = 'freecroco' AND environment = 'test' AND game_id = 'ranked'`;
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

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;

  async function launch(playerId = id('p')) {
    const config = partnerConfig.getFreecrocoConfig()!;
    const started = await sessions.initSession(config, {
      playerId, language: 'en', channel: 'WEB', requestId: id('req'), username: 'nik****om',
    } as never);
    const redeemed = await sessions.redeemSession(config, started.oneTimeToken);
    return auth.resolvePartnerPrincipal(redeemed.accessToken);
  }

  async function bot() {
    const [row] = await db.sql<{ id: string }[]>`
      INSERT INTO users (nickname, is_ai, ai_kind) VALUES (${id('bot')}, true, 'persistent') RETURNING id`;
    return row.id;
  }

  /** A match with its players' final tally, partner plays attached as at creation. */
  async function match(
    players: Array<{ userId: string; goals?: number; pens?: number; correct?: number }>,
    partnerUserIds: string[],
  ) {
    const [m] = await db.sql<{ id: string }[]>`INSERT INTO matches (partner_pool) VALUES ('freecroco-test') RETURNING id`;
    for (const [index, p] of players.entries()) {
      await db.sql`INSERT INTO match_players (match_id, user_id, seat, goals, penalty_goals, correct_answers)
        VALUES (${m.id}, ${p.userId}, ${index + 1}, ${p.goals ?? 0}, ${p.pens ?? 0}, ${p.correct ?? 0})`;
    }
    await db.sql.begin((tx) => entries.attachPartnerRankedEntriesInTx(tx, { matchId: m.id, lobbyId: randomUUID(), userIds: partnerUserIds }));
    return m.id;
  }

  async function end(matchId: string, cause: Parameters<typeof entries.settlePartnerRankedMatchInTx>[2]) {
    return db.sql.begin(async (tx) => {
      await tx`UPDATE matches SET status = 'completed', ended_at = now() WHERE id = ${matchId}`;
      return entries.settlePartnerRankedMatchInTx(tx, matchId, cause);
    });
  }

  const events = (playId: string) => db.sql<{ score: number }[]>`SELECT score FROM partner_score_events WHERE play_id = ${playId}`;
  const play = async (playId: string) => (await db.sql<{ state: string; score: number | null; refunded: boolean }[]>`
    SELECT state, score, refunded FROM partner_plays WHERE id = ${playId}`)[0];
  const used = async (playerId: string) => (await db.sql<{ n: number }[]>`
    SELECT COALESCE(sum(plays_used), 0)::int AS n FROM partner_quota_days WHERE player_id = ${playerId} AND game_id = 'ranked'`)[0].n;

  it('a queue join reserves one play and a repeated join reuses it', async () => {
    const p = await launch();
    const first = await entries.reservePartnerRankedPlay(p);
    const again = await entries.reservePartnerRankedPlay(p);
    expect(first.reused).toBe(false);
    expect(again).toMatchObject({ reused: true, entry: { playId: first.entry.playId, state: 'searching' } });
    expect(await used(p.playerId)).toBe(1);
  });

  it('cancelling the search before a match returns the play; the quota is enforced', async () => {
    const p = await launch();
    const { entry } = await entries.reservePartnerRankedPlay(p);
    expect(await entries.releasePartnerRankedSearch(p.userId, 'test')).toBe(true);
    expect(await play(entry.playId)).toMatchObject({ state: 'cancelled', refunded: true });
    expect(await used(p.playerId)).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      await entries.reservePartnerRankedPlay(p);
      await db.sql`UPDATE partner_ranked_entries SET state = 'settled', settled_at = now() WHERE user_id = ${p.userId} AND state = 'searching'`;
    }
    await expect(entries.reservePartnerRankedPlay(p)).rejects.toMatchObject({ code: 'quota_exhausted' });
  });

  it('before an opponent is shown a cancel always returns the play', async () => {
    const p = await launch();
    const { entry } = await entries.reservePartnerRankedPlay(p);
    expect(await entries.releasePartnerRankedSearch(p.userId, 'test', undefined, { left: true })).toBe(true);
    expect(await play(entry.playId)).toMatchObject({ state: 'cancelled', refunded: true });
  });

  it('after the opponent is shown: the one who left keeps the play used, the other gets it back (no free re-roll)', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    await entries.markPartnerRankedOpponentShown([a.userId, b.userId]);
    expect(await entries.releasePartnerRankedSearch(a.userId, 'test', undefined, { left: true })).toBe(true);
    expect(await entries.releasePartnerRankedSearch(b.userId, 'test')).toBe(true);
    expect(await play(ea.playId)).toMatchObject({ state: 'cancelled', refunded: false });
    expect(await play(eb.playId)).toMatchObject({ state: 'cancelled', refunded: true });
    expect(await used(a.playerId)).toBe(1);
    expect(await used(b.playerId)).toBe(0);
    const [row] = await db.sql`SELECT terminal_cause, refunded FROM partner_ranked_entries WHERE id = ${ea.id}`;
    expect(row).toEqual({ terminal_cause: 'early_leave', refunded: false });
    expect(await events(ea.playId)).toHaveLength(0);
  });

  it('recording a reveal is all or nothing: a player without a searching play means nobody is marked', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    expect(await entries.markPartnerRankedOpponentShown([a.userId, b.userId])).toBe(false);
    const [row] = await db.sql`SELECT opponent_shown_at FROM partner_ranked_entries WHERE id = ${ea.id}`;
    expect(row.opponent_shown_at).toBeNull();
    await entries.reservePartnerRankedPlay(b);
    expect(await entries.markPartnerRankedOpponentShown([a.userId, b.userId])).toBe(true);
  });

  it(`after a reveal, an ending nobody is blamed for returns the play at most ${2} times a day`, async () => {
    const p = await launch();
    const refunds: boolean[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { entry } = await entries.reservePartnerRankedPlay(p);
      await entries.markPartnerRankedOpponentShown([p.userId]);
      await entries.releasePartnerRankedSearch(p.userId, 'test');
      refunds.push((await play(entry.playId)).refunded);
    }
    expect(refunds).toEqual([true, true, false]);
    expect(entries.RANKED_RETURNS_AFTER_REVEAL_PER_DAY).toBe(2);
  });

  it('plays returned because the opponent left never count toward the allowance', async () => {
    const p = await launch();
    for (let i = 0; i < 3; i += 1) {
      const { entry } = await entries.reservePartnerRankedPlay(p);
      await entries.markPartnerRankedOpponentShown([p.userId]);
      await entries.releasePartnerRankedSearch(p.userId, 'test', undefined, { opponentLeft: true });
      expect(await play(entry.playId)).toMatchObject({ refunded: true });
      const [row] = await db.sql`SELECT terminal_cause FROM partner_ranked_entries WHERE id = ${entry.id}`;
      expect(row.terminal_cause).toBe('early_leave');
    }
    const { entry } = await entries.reservePartnerRankedPlay(p);
    await entries.markPartnerRankedOpponentShown([p.userId]);
    await entries.releasePartnerRankedSearch(p.userId, 'test');
    expect(await play(entry.playId)).toMatchObject({ refunded: true });
  });

  it('a release retried without context (the reconciler) still uses the leaver recorded before the teardown', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    await entries.markPartnerRankedOpponentShown([a.userId, b.userId]);
    await entries.recordPartnerRankedLeaver([a.userId, b.userId], a.userId);
    await entries.releasePartnerRankedSearch(b.userId, 'reconciler_idle_search');
    await entries.releasePartnerRankedSearch(a.userId, 'reconciler_idle_search');
    expect(await play(ea.playId)).toMatchObject({ refunded: false });
    expect(await play(eb.playId)).toMatchObject({ refunded: true });
    const rows = await db.sql`SELECT user_id, terminal_cause FROM partner_ranked_entries WHERE id IN (${ea.id}, ${eb.id})`;
    expect(rows.map((r) => r.terminal_cause)).toEqual(['early_leave', 'early_leave']);
  });

  it('a match that ends with no result counts toward the same daily allowance', async () => {
    const [a, b] = [await launch(), await launch()];
    for (let i = 0; i < 2; i += 1) {
      await entries.reservePartnerRankedPlay(a);
      await entries.markPartnerRankedOpponentShown([a.userId]);
      await entries.releasePartnerRankedSearch(a.userId, 'test');
    }
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId }, { userId: b.userId }], [a.userId, b.userId]);
    expect(await end(matchId, { kind: 'server_failure' })).toBe(true);
    expect(await play(ea.playId)).toMatchObject({ state: 'cancelled', refunded: false });
    expect(await play(eb.playId)).toMatchObject({ state: 'cancelled', refunded: true });
  });

  it('settles a win by margin for both Freecroco players, once', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    expect(await entries.checkPartnerRankedAdmission([a.userId, b.userId])).toEqual({ ok: true });
    const matchId = await match([{ userId: a.userId, goals: 3 }, { userId: b.userId, goals: 1 }], [a.userId, b.userId]);
    expect(await end(matchId, { kind: 'natural' })).toBe(true);
    expect(await events(ea.playId)).toEqual([{ score: 150 }]);
    expect(await events(eb.playId)).toEqual([{ score: 40 }]);
    expect(await end(matchId, { kind: 'natural' })).toBe(false);
    expect(await events(ea.playId)).toHaveLength(1);
    expect(await entries.getPartnerRankedResult(a.userId, matchId)).toMatchObject({ state: 'settled', score: 150, outcome: 'win' });
  });

  it('vs a bot: a leaver scores 0 even when ahead; the bot gets no event', async () => {
    const p = await launch();
    const e = (await entries.reservePartnerRankedPlay(p)).entry;
    const botId = await bot();
    const matchId = await match([{ userId: p.userId, goals: 2 }, { userId: botId }], [p.userId]);
    await end(matchId, { kind: 'left', leaverUserId: p.userId });
    expect(await events(e.playId)).toEqual([{ score: 0 }]);
    expect(await db.sql`SELECT 1 FROM partner_score_events e JOIN partner_plays pl ON pl.id = e.play_id
      WHERE pl.player_id NOT IN (SELECT id FROM partner_players)`).toHaveLength(0);
  });

  it('an early leave cancels: the leaver keeps the play used, the opponent gets it back, no events', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId }, { userId: b.userId }], [a.userId, b.userId]);
    await end(matchId, { kind: 'early_leave', leaverUserId: a.userId });
    expect(await play(ea.playId)).toMatchObject({ state: 'cancelled', refunded: false });
    expect(await play(eb.playId)).toMatchObject({ state: 'cancelled', refunded: true });
    expect([...(await events(ea.playId)), ...(await events(eb.playId))]).toHaveLength(0);
  });

  it('a blocked player gets no event; the opponent still does', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId, goals: 1 }, { userId: b.userId }], [a.userId, b.userId]);
    const [player] = await db.sql<{ external_player_id: string }[]>`SELECT external_player_id FROM partner_players WHERE id = ${a.playerId}`;
    await sessions.setPlayerStatus(partnerConfig.getFreecrocoConfig()!, player.external_player_id, 'blocked', { at: new Date(), reason: null });
    await end(matchId, { kind: 'left', leaverUserId: a.userId });
    expect(await events(ea.playId)).toHaveLength(0);
    expect(await events(eb.playId)).toEqual([{ score: 100 }]);
    expect(await entries.getPartnerRankedResult(a.userId, matchId)).toMatchObject({ state: 'cancelled', terminalCause: 'blocked' });
  });

  it('counts the matches two players had against each other today (anti-collusion cap input)', async () => {
    const [a, b] = [await launch(), await launch()];
    for (let i = 0; i < 2; i += 1) {
      await entries.reservePartnerRankedPlay(a);
      await entries.reservePartnerRankedPlay(b);
      const matchId = await match([{ userId: a.userId }, { userId: b.userId }], [a.userId, b.userId]);
      await end(matchId, { kind: 'natural' });
    }
    expect(await entries.countPartnerMatchesBetweenToday(a.userId, b.userId)).toBe(2);
    expect(await entries.countPartnerMatchesBetweenToday(b.userId, a.userId)).toBe(2);
  });

  it('a block during the search keeps the play used and records the block', async () => {
    const p = await launch();
    const { entry } = await entries.reservePartnerRankedPlay(p);
    const [player] = await db.sql<{ external_player_id: string }[]>`SELECT external_player_id FROM partner_players WHERE id = ${p.playerId}`;
    await sessions.setPlayerStatus(partnerConfig.getFreecrocoConfig()!, player.external_player_id, 'blocked', { at: new Date(), reason: null });
    await entries.releasePartnerRankedSearch(p.userId, 'blocked');
    expect(await play(entry.playId)).toMatchObject({ state: 'cancelled', refunded: false });
    const [row] = await db.sql`SELECT state, terminal_cause FROM partner_ranked_entries WHERE id = ${entry.id}`;
    expect(row).toEqual({ state: 'cancelled', terminal_cause: 'blocked' });
  });

  it('a match row without a ledger row for a partner player does not settle', async () => {
    const [a, b] = [await launch(), await launch()];
    await entries.reservePartnerRankedPlay(a);
    const [m] = await db.sql<{ id: string }[]>`INSERT INTO matches (partner_pool) VALUES ('freecroco-test') RETURNING id`;
    await db.sql`INSERT INTO match_players (match_id, user_id, seat) VALUES (${m.id}, ${a.userId}, 1), (${m.id}, ${b.userId}, 2)`;
    await db.sql.begin((tx) => entries.attachPartnerRankedEntriesInTx(tx, { matchId: m.id, lobbyId: randomUUID(), userIds: [a.userId] }));
    await expect(end(m.id, { kind: 'natural' })).rejects.toThrow(/without a play/);
  });

  it('a block whose forfeit never ran: the reconciler finds the active match, and a natural end scores it as a leave', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId, goals: 3 }, { userId: b.userId }], [a.userId, b.userId]);
    const [player] = await db.sql<{ external_player_id: string }[]>`SELECT external_player_id FROM partner_players WHERE id = ${a.playerId}`;
    await sessions.setPlayerStatus(partnerConfig.getFreecrocoConfig()!, player.external_player_id, 'blocked', { at: new Date(), reason: null });
    expect((await entries.listPartnerRankedReconcileWork(30)).blockedInActiveMatch).toContainEqual({ userId: a.userId, playId: ea.playId });
    await end(matchId, { kind: 'natural' });
    expect(await events(ea.playId)).toHaveLength(0);
    expect(await events(eb.playId)).toEqual([{ score: 100 }]);
    expect((await entries.listPartnerRankedReconcileWork(30)).blockedInActiveMatch.map((w) => w.userId)).not.toContain(a.userId);
  });

  it('blocked while the opponent had already dropped: both dropped, the trailing opponent gets its loser points, no event for the blocked player', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId }, { userId: b.userId, goals: 3 }], [a.userId, b.userId]);
    const [player] = await db.sql<{ external_player_id: string }[]>`SELECT external_player_id FROM partner_players WHERE id = ${b.playerId}`;
    await sessions.setPlayerStatus(partnerConfig.getFreecrocoConfig()!, player.external_player_id, 'blocked', { at: new Date(), reason: null });
    await end(matchId, { kind: 'both_dropped' });
    expect(await events(ea.playId)).toEqual([{ score: 30 }]);
    expect(await events(eb.playId)).toHaveLength(0);
  });

  it('admission refuses a player without a started play', async () => {
    const p = await launch();
    expect(await entries.checkPartnerRankedAdmission([p.userId])).toMatchObject({ ok: false, reason: 'no_play' });
  });

  it('the reconciler settles a match that ended without its settlement (staged or derived cause)', async () => {
    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const matchId = await match([{ userId: a.userId, goals: 1 }, { userId: b.userId, goals: 1, pens: 3 }], [a.userId, b.userId]);
    await db.sql`UPDATE matches SET status = 'completed', ended_at = now() WHERE id = ${matchId}`;
    const work = await entries.listPartnerRankedReconcileWork(30);
    expect(work.endedMatchIds).toContain(matchId);
    expect(await entries.reconcilePartnerRankedMatch(matchId)).toBe(true);
    expect(await events(ea.playId)).toEqual([{ score: 50 }]);
    expect(await events(eb.playId)).toEqual([{ score: 100 }]);

    const [c, d] = [await launch(), await launch()];
    const ec = (await entries.reservePartnerRankedPlay(c)).entry;
    const ed = (await entries.reservePartnerRankedPlay(d)).entry;
    const forfeited = await match([{ userId: c.userId, goals: 4 }, { userId: d.userId }], [c.userId, d.userId]);
    await db.sql`UPDATE matches SET status = 'completed', ended_at = now(), winner_user_id = ${d.userId},
      state_payload = '{"winnerDecisionMethod":"forfeit"}' WHERE id = ${forfeited}`;
    await entries.reconcilePartnerRankedMatch(forfeited);
    expect(await events(ec.playId)).toEqual([{ score: 0 }]);
    expect(await events(ed.playId)).toEqual([{ score: 100 }]);
  });

  it('a failing settlement keeps the match ending and stages the cause for the reconciler', async () => {
    const p = await launch();
    const e = (await entries.reservePartnerRankedPlay(p)).entry;
    const matchId = await match([{ userId: p.userId }], [p.userId]);
    await db.sql.begin(async (tx) => {
      await tx`UPDATE matches SET status = 'abandoned', ended_at = now() WHERE id = ${matchId}`;
      await tx`ALTER TABLE partner_plays ADD CONSTRAINT chk_test_block CHECK (state <> 'cancelled') NOT VALID`;
      await entries.settlePartnerRankedMatchSafely(tx, matchId, { kind: 'early_leave', leaverUserId: p.userId });
      await tx`ALTER TABLE partner_plays DROP CONSTRAINT chk_test_block`;
    });
    const [staged] = await db.sql`SELECT state, terminal_cause, leaver_user_id FROM partner_ranked_entries WHERE id = ${e.id}`;
    expect(staged).toMatchObject({ state: 'playing', terminal_cause: 'early_leave', leaver_user_id: p.userId });
    await entries.reconcilePartnerRankedMatch(matchId);
    expect(await play(e.playId)).toMatchObject({ state: 'cancelled' });
  });

  it('points table: an edit scores matches started after it, a running match keeps the table it started on', async () => {
    const config = partnerConfig.getFreecrocoConfig()!;
    const [staffer] = await db.sql<{ id: string }[]>`INSERT INTO users (nickname, role) VALUES (${id('qa')}, 'admin') RETURNING id`;
    const loaded = await partnerAdmin.getRankedPoints(config);
    expect(loaded).toEqual({ version: 1, points: DEFAULT_RANKED_POINTS, maxScore: 500 });

    const [a, b] = [await launch(), await launch()];
    const ea = (await entries.reservePartnerRankedPlay(a)).entry;
    const eb = (await entries.reservePartnerRankedPlay(b)).entry;
    const running = await match([{ userId: a.userId, goals: 3 }, { userId: b.userId, goals: 1 }], [a.userId, b.userId]);

    const edited = {
      ...DEFAULT_RANKED_POINTS,
      margins: DEFAULT_RANKED_POINTS.margins.map((m, i) => (i === 1 ? { winner: 180, loser: 45 } : i === 5 ? { winner: 900, loser: 0 } : m)),
    };
    const saved = await partnerAdmin.putRankedPoints(config, staffer.id, { version: loaded.version, points: edited });
    expect(saved).toEqual({ version: 2, points: edited, maxScore: 900 });
    await expect(partnerAdmin.putRankedPoints(config, staffer.id, { version: loaded.version, points: DEFAULT_RANKED_POINTS }))
      .rejects.toMatchObject({ code: 'stale_version', status: 409 });
    const swapped = { ...edited, penaltyWin: { winner: 10, loser: 50 } };
    await expect(partnerAdmin.putRankedPoints(config, staffer.id, { version: saved.version, points: swapped }))
      .rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await partnerAdmin.getRankedPoints(config)).toEqual(saved);

    const audits = await db.sql<{ actor: string; before: { version: number; points: unknown }; after: { version: number; points: unknown } }[]>`
      SELECT actor, before, after FROM partner_audit WHERE action = 'ranked_points.update' ORDER BY id`;
    expect(audits).toEqual([{
      actor: `user:${staffer.id}`,
      before: { version: 1, points: DEFAULT_RANKED_POINTS, maxScore: 500 },
      after: { version: 2, points: edited, maxScore: 900 },
    }]);

    const [c, d] = [await launch(), await launch()];
    const ec = (await entries.reservePartnerRankedPlay(c)).entry;
    const ed = (await entries.reservePartnerRankedPlay(d)).entry;
    const later = await match([{ userId: c.userId, goals: 3 }, { userId: d.userId, goals: 1 }], [c.userId, d.userId]);
    const e = await launch();
    const ee = (await entries.reservePartnerRankedPlay(e)).entry;
    const routed = await match([{ userId: e.userId, goals: 8 }, { userId: await bot() }], [e.userId]);

    const versions = await db.sql<{ match_id: string; points_version: number }[]>`
      SELECT match_id, points_version FROM partner_ranked_entries WHERE match_id IN (${running}, ${later}, ${routed}) ORDER BY points_version, user_id`;
    expect(versions.filter((v) => v.match_id === running).map((v) => v.points_version)).toEqual([1, 1]);
    expect(versions.filter((v) => v.match_id === later).map((v) => v.points_version)).toEqual([2, 2]);

    await end(running, { kind: 'natural' });
    await end(later, { kind: 'natural' });
    await end(routed, { kind: 'natural' });
    expect(await events(ea.playId)).toEqual([{ score: 150 }]);
    expect(await events(eb.playId)).toEqual([{ score: 40 }]);
    expect(await events(ec.playId)).toEqual([{ score: 180 }]);
    expect(await events(ed.playId)).toEqual([{ score: 45 }]);
    // Above the contract's 500: the per-play cap follows the table the match started on.
    expect(await events(ee.playId)).toEqual([{ score: 900 }]);
    expect(await entries.getPartnerRankedResult(e.userId, routed)).toMatchObject({ state: 'settled', score: 900 });

    // Settled once: a repeat after another edit changes nothing.
    const third = await partnerAdmin.putRankedPoints(config, staffer.id, { version: saved.version, points: DEFAULT_RANKED_POINTS });
    expect(third.version).toBe(3);
    expect(await end(later, { kind: 'natural' })).toBe(false);
    expect(await events(ec.playId)).toEqual([{ score: 180 }]);
  });
  describe('socket races', () => {
    const fakeSocket = (partner: unknown) => ({ id: randomUUID(), data: { partner }, emit: vi.fn(), disconnect: vi.fn() });
    const fakeIo = (sockets: unknown[]) => ({
      in: () => ({ fetchSockets: async () => sockets }),
      to: () => ({ emit: vi.fn() }),
    }) as never;
    let clock = Date.now();
    const setStatus = async (externalPlayerId: string, status: 'blocked' | 'active') => {
      clock += 1_000;
      await sessions.setPlayerStatus(partnerConfig.getFreecrocoConfig()!, externalPlayerId, status, { at: new Date(clock), reason: null });
    };
    /** Blocks the player but holds the block's callback, as if the realtime layer received it late. */
    const blockLate = async (externalPlayerId: string) => {
      let held: Parameters<typeof partnerEvents.emitPartnerPlayerBlocked>[0] | undefined;
      const off = partnerEvents.onPartnerPlayerBlocked((event) => { held = event; });
      try {
        await setStatus(externalPlayerId, 'blocked');
      } finally {
        off();
      }
      return held!;
    };
    const deliver = async (io: never, event: Parameters<typeof partnerEvents.emitPartnerPlayerBlocked>[0]) => {
      const off = realtime.registerPartnerRankedBlockHandler(io);
      try {
        await partnerEvents.emitPartnerPlayerBlocked(event);
      } finally {
        off();
      }
    };
    const entryOf = async (playId: string) => (await db.sql<{ state: string; match_id: string | null }[]>`
      SELECT state, match_id FROM partner_ranked_entries WHERE play_id = ${playId}`)[0];

    beforeEach(() => {
      rt.forfeit.mockReset().mockResolvedValue({ completed: true, resultVersion: 1 });
      rt.queueCleanup.mockReset().mockResolvedValue({});
    });

    it('a handshake delayed past a newer launch is refused and never closes the newer session', async () => {
      const external = id('p');
      const old = await launch(external);
      const fresh = await launch(external);
      const current = fakeSocket(fresh);
      const stale = fakeSocket(old);
      await realtime.admitPartnerSocket(fakeIo([current, stale]), stale as never);
      expect(current.disconnect).not.toHaveBeenCalled();
      expect(current.emit).not.toHaveBeenCalled();
      expect(stale.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'replaced' });
      expect(stale.disconnect).toHaveBeenCalledWith(true);

      // The old socket connected first: the newer session's connection closes it.
      const before = fakeSocket(old);
      const after = fakeSocket(fresh);
      await realtime.admitPartnerSocket(fakeIo([before, after]), after as never);
      expect(before.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'replaced' });
      expect(after.disconnect).not.toHaveBeenCalled();
    });

    it('a block delivered after an unblock, a fresh launch and a new match ends only what it revoked', async () => {
      const external = id('p');
      const old = await launch(external);
      const blockedPlay = (await entries.reservePartnerRankedPlay(old)).entry.playId;
      const event = await blockLate(external);
      expect(event.cancelledPlayIds).toContain(blockedPlay);

      await setStatus(external, 'active');
      const fresh = await launch(external);
      const opponent = await launch();
      const freshPlay = (await entries.reservePartnerRankedPlay(fresh)).entry.playId;
      await entries.reservePartnerRankedPlay(opponent);
      const freshMatch = await match([{ userId: fresh.userId }, { userId: opponent.userId }], [fresh.userId, opponent.userId]);

      const staleSocket = fakeSocket(old);
      const freshSocket = fakeSocket(fresh);
      await deliver(fakeIo([staleSocket, freshSocket]), event);
      expect(staleSocket.emit).toHaveBeenCalledWith('partner:session_ended', { reason: 'blocked' });
      expect(freshSocket.disconnect).not.toHaveBeenCalled();
      expect(rt.forfeit).not.toHaveBeenCalled();
      expect(await entryOf(freshPlay)).toEqual({ state: 'playing', match_id: freshMatch });
    });

    it('a block delivered after an unblock and a new search leaves the new search alone', async () => {
      const external = id('p');
      const old = await launch(external);
      await entries.reservePartnerRankedPlay(old);
      const event = await blockLate(external);

      await setStatus(external, 'active');
      const fresh = await launch(external);
      const freshPlay = (await entries.reservePartnerRankedPlay(fresh)).entry.playId;

      await deliver(fakeIo([fakeSocket(fresh)]), event);
      expect(rt.queueCleanup).not.toHaveBeenCalled();
      expect(await entryOf(freshPlay)).toEqual({ state: 'searching', match_id: null });
      expect(await play(freshPlay)).toMatchObject({ state: 'started' });
    });

    it('a block delivered on time still ends its own search and match', async () => {
      const searcher = id('p');
      const s = await launch(searcher);
      const searchPlay = (await entries.reservePartnerRankedPlay(s)).entry.playId;
      await deliver(fakeIo([]), await blockLate(searcher));
      expect(rt.queueCleanup).toHaveBeenCalledOnce();
      expect(await entryOf(searchPlay)).toMatchObject({ state: 'cancelled' });

      const player = id('p');
      const [a, b] = [await launch(player), await launch()];
      await entries.reservePartnerRankedPlay(a);
      await entries.reservePartnerRankedPlay(b);
      const matchId = await match([{ userId: a.userId }, { userId: b.userId }], [a.userId, b.userId]);
      await deliver(fakeIo([]), await blockLate(player));
      expect(rt.forfeit).toHaveBeenCalledWith(expect.objectContaining({ matchId, forfeitingUserId: a.userId }));
    });

    it('a retry that re-enqueues an old play counts as a fresh search: the reconciler leaves it alone', async () => {
      const p = await launch();
      const { playId } = (await entries.reservePartnerRankedPlay(p)).entry;
      await db.sql`UPDATE partner_ranked_entries SET updated_at = now() - interval '700 seconds' WHERE play_id = ${playId}`;
      rt.batchedState = 'IN_QUEUE';
      rt.afterScan = async () => {
        expect((await entries.reservePartnerRankedPlay(p)).reused).toBe(true);
      };
      try {
        await realtime.reconcilePartnerRanked(fakeIo([]));
      } finally {
        rt.afterScan = async () => undefined;
        rt.batchedState = 'IDLE';
      }
      expect(rt.queueCleanup).not.toHaveBeenCalled();
      expect(await entryOf(playId)).toEqual({ state: 'searching', match_id: null });
      expect(await play(playId)).toMatchObject({ state: 'started', refunded: false });
    });

    it('a stuck search the reconciler scanned, replaced by a fresh search before it acts, is left alone', async () => {
      const p = await launch();
      const stale = (await entries.reservePartnerRankedPlay(p)).entry.playId;
      await db.sql`UPDATE partner_ranked_entries SET updated_at = now() - interval '700 seconds' WHERE play_id = ${stale}`;
      let freshPlay = '';
      rt.batchedState = 'IN_QUEUE';
      rt.afterScan = async () => {
        await entries.releasePartnerRankedSearch(p.userId, 'test');
        freshPlay = (await entries.reservePartnerRankedPlay(p)).entry.playId;
      };
      try {
        await realtime.reconcilePartnerRanked(fakeIo([]));
      } finally {
        rt.afterScan = async () => undefined;
        rt.batchedState = 'IDLE';
      }
      expect(freshPlay).not.toBe('');
      expect(rt.queueCleanup).not.toHaveBeenCalled();
      expect(await entryOf(freshPlay)).toEqual({ state: 'searching', match_id: null });
      expect(await play(freshPlay)).toMatchObject({ state: 'started', refunded: false });
    });
  });
});
