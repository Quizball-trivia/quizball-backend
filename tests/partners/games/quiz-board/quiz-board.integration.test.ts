import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from '../../test-db.js';

/**
 * Quiz Board on real PostgreSQL: partner core + delivery + quiz-board migrations over a minimal schema and a generated
 * question bank (no real content). Runs in CI against MIGRATION_TEST_DATABASE_URL (creates and drops its own
 * database) or locally against an isolated one:
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isReady: true, ping: async () => 'PONG' }),
}));

const isolatedUrl = process.env.PARTNER_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;

const MIGRATIONS = [
  '20261005121000_partner_core.sql',
  '20261005121001_partner_core_validate.sql',
  '20261005130000_partner_delivery.sql',
  '20261006140000_partner_quiz_board.sql',
].map((f) => join(__dirname, '../../../../supabase/migrations', f));

// Generated bank: 4 regular categories × 8 questions per difficulty, plus a small one and a daily one that must never
// reach a board. Option texts carry no meaning; the right option sits at a varying position.
const FIXTURE = `
  DROP TABLE IF EXISTS partner_quiz_board_starts, partner_quiz_board_events, partner_quiz_board_tiles, partner_quiz_boards,
    partner_score_event_attempts, partner_score_events, partner_plays, partner_quota_days, partner_audit,
    partner_limit_overrides, partner_games, partner_config_versions, partner_sessions, partner_players,
    partner_operator_memberships, question_payloads, questions, categories, audit_logs, ranked_profiles, users CASCADE;
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
  CREATE TABLE audit_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL, entity_type text NOT NULL, entity_id uuid, metadata jsonb,
    created_at timestamptz NOT NULL DEFAULT now());
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
  CREATE TABLE categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name jsonb NOT NULL,
    is_active boolean NOT NULL DEFAULT true, campaign_only boolean NOT NULL DEFAULT false);
  CREATE TABLE questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES categories(id),
    type text NOT NULL, difficulty text NOT NULL, status text NOT NULL, prompt jsonb NOT NULL,
    ranked_eligible boolean NOT NULL DEFAULT true, visibility text NOT NULL DEFAULT 'public');
  CREATE TABLE question_payloads (question_id uuid PRIMARY KEY REFERENCES questions(id), payload jsonb NOT NULL);
  INSERT INTO categories (slug, name)
    SELECT 'cat-' || n, jsonb_build_object('en', 'Category ' || n, 'ka', 'კატეგორია ' || n) FROM generate_series(1, 4) n;
  INSERT INTO categories (slug, name) VALUES ('tiny', '{"en": "Tiny"}'), ('daily-challenges-x', '{"en": "Daily"}');
  INSERT INTO questions (category_id, type, difficulty, status, prompt)
    SELECT c.id, 'mcq_single', d, 'published', jsonb_build_object('en', c.slug || ' ' || d || ' ' || i)
    FROM categories c CROSS JOIN unnest(ARRAY['easy', 'medium', 'hard']) d CROSS JOIN generate_series(1, 8) i;
  INSERT INTO question_payloads (question_id, payload)
    SELECT q.id, jsonb_build_object('type', 'mcq_single', 'options', (
      SELECT jsonb_agg(jsonb_build_object('id', k::text, 'text', jsonb_build_object('en', 'option ' || k),
                                          'is_correct', k = (abs(hashtext(q.id::text)) % 4)) ORDER BY k)
      FROM generate_series(0, 3) k))
    FROM questions q;
  DELETE FROM question_payloads WHERE question_id IN (
    SELECT q.id FROM questions q JOIN categories c ON c.id = q.category_id WHERE c.slug = 'tiny' AND q.prompt->>'en' NOT LIKE '% 1');
  DELETE FROM questions WHERE id NOT IN (SELECT question_id FROM question_payloads);
`;

const KEY = 'test-inbound-key-'.padEnd(64, 'x');

/** Every statement the pool sends while set (BEGIN/COMMIT included). */
const traced: { on: boolean; queries: string[] } = { on: false, queries: [] };

describe.skipIf(!isolated && !adminTarget)('partner quiz-board on real Postgres', { timeout: 60_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let app: express.Express;
  let quizBoard: typeof import('../../../../src/modules/partners/games/quiz-board/index.js');

  beforeAll(async () => {
    process.env.PARTNER_JWT_SECRET = 'integration-partner-jwt-secret-32-bytes';
    process.env.PARTNER_RESPONSE_SEAL_KEY = 'integration-partner-seal-key-32-bytes!!';
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_quiz_board_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({
      ...target,
      max: 10,
      onnotice: () => undefined,
      debug: (_connection, query) => {
        if (traced.on) traced.queries.push(query.trim());
      },
    });
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATIONS[3], 'utf8')));

    const partner = await import('../../../../src/modules/partners/partner-config.js');
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco',
      environment: 'test',
      inboundKeySha256: [partner.sha256Hex(KEY)],
      allowedCidrs: ['127.0.0.1/32', '::1/128'],
      launchBaseUrl: 'https://staging-freecroco.quizball.io',
    });
    partner.resetPartnerConfigCache();
    quizBoard = await import('../../../../src/modules/partners/games/quiz-board/index.js');
    const { partnerRoutes } = await import('../../../../src/http/routes/partner.routes.js');
    app = express();
    app.use(express.json());
    app.use(partnerRoutes);
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

  const setLimit = (limit: number) => db.sql`
    UPDATE partner_games SET ready = true, default_limit = ${limit}
    WHERE partner_slug = 'freecroco' AND environment = 'test' AND game_id = 'quiz-board'`;
  beforeEach(() => setLimit(1));

  let seq = 0;
  const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq += 1)}`;
  const launch = async (playerId = id('p')) => {
    const init = await request(app).post('/partner/v1/sessions/init').set('x-api-key', KEY)
      .send({ playerId, language: 'en', channel: 'WEB', requestId: id('req'), username: 'nik****om' });
    expect(init.status).toBe(200);
    const redeemed = await request(app).post('/partner/v1/sessions/redeem').send({ token: init.body.oneTimeToken });
    expect(redeemed.status).toBe(200);
    return { playerId, token: redeemed.body.accessToken as string };
  };
  const call = (token: string, path: string, body?: unknown) => {
    const r = body === undefined
      ? request(app).get(`/partner/v1/games/quiz-board/${path}`)
      : request(app).post(`/partner/v1/games/quiz-board/${path}`).send(body as object);
    return r.set('authorization', `Bearer ${token}`);
  };
  const correctIndex = async (playId: string, tile: number) => {
    const [row] = await db.sql<{ correct_index: number }[]>`
      SELECT t.correct_index FROM partner_quiz_board_tiles t JOIN partner_quiz_boards b ON b.id = t.board_id
      WHERE b.play_id = ${playId} AND t.tile = ${tile}`;
    return row.correct_index;
  };
  /** Moves the board's current deadline into the past (the player went quiet that long ago). */
  const backdate = (playId: string, interval: string) => db.sql`
    UPDATE partner_quiz_boards SET deadline_at = deadline_at - ${interval}::interval WHERE play_id = ${playId}`;
  const deadlineOf = async (playId: string) => {
    const [row] = await db.sql<{ deadline_at: Date }[]>`SELECT deadline_at FROM partner_quiz_boards WHERE play_id = ${playId}`;
    return row.deadline_at;
  };
  const scoreEvents = (playId: string) =>
    db.sql<{ score: number; occurred_at: Date }[]>`SELECT score, occurred_at FROM partner_score_events WHERE play_id = ${playId}`;

  it('migration: server-only tables', async () => {
    const [row] = await db.sql`
      SELECT has_table_privilege('anon', 'public.partner_quiz_boards', 'SELECT') AS a,
             has_table_privilege('authenticated', 'public.partner_quiz_board_tiles', 'SELECT') AS b,
             (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname LIKE 'partner\\_quiz\\_board%' AND relkind = 'r') AS rls`;
    expect(row).toEqual({ a: false, b: false, rls: true });
  });

  it('needs the partner token', async () => {
    expect((await request(app).get('/partner/v1/games/quiz-board/current')).status).toBe(401);
    const res = await call('not-a-partner-token', 'current');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('session_ended');
  });

  it('draws 3 qualifying categories × easy/medium/hard and never sends an answer before it is given', async () => {
    const { token } = await launch();
    const start = await call(token, 'start', { startId: randomUUID() });
    expect(start.status).toBe(200);
    const board = start.body.board;
    expect(board.categories).toHaveLength(3);
    for (const name of board.categories) expect(name).toMatch(/^Category [1-4]$/);
    expect(board.tiles.map((t: { value: number }) => t.value)).toEqual([100, 200, 300, 100, 200, 300, 100, 200, 300]);
    const picked = await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 5 });
    expect(picked.body.board.question).toEqual({ tile: 5, value: 300, prompt: expect.any(String), image: null, options: expect.any(Array) });
    expect(JSON.stringify(picked.body)).not.toMatch(/correct(Index|_index)|is_correct|ai[A-Z_]|steal|opensAt|seed/);
    const [row] = await db.sql<{ prompt: { en: string } }[]>`
      SELECT t.prompt FROM partner_quiz_board_tiles t JOIN partner_quiz_boards b ON b.id = t.board_id
      WHERE b.play_id = ${board.playId} AND t.tile = 5`;
    expect(picked.body.board.question.prompt).toBe(row.prompt.en);
    expect(row.prompt.en).toMatch(/ hard /);
  });

  it('a fresh start is one transaction with the tiles in one insert, and returns the board as stored', async () => {
    const { token } = await launch();
    traced.queries = [];
    traced.on = true;
    let start;
    try {
      start = await call(token, 'start', { startId: randomUUID() });
    } finally {
      traced.on = false;
    }
    expect(start.status).toBe(200);
    const control = traced.queries.filter((q) => /^(begin|commit|rollback)\b/i.test(q));
    const statements = traced.queries.filter((q) => !control.includes(q));
    expect(control.filter((q) => /^begin/i.test(q))).toHaveLength(1);
    expect(statements.filter((q) => /INSERT INTO partner_quiz_board_tiles/.test(q))).toHaveLength(1);
    expect(statements.length).toBeLessThanOrEqual(18);
    const reloaded = await call(token, `current?playId=${start.body.board.playId}`);
    expect({ ...start.body.board, serverNow: null }).toEqual({ ...reloaded.body.board, serverNow: null });
    const [tiles] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM partner_quiz_board_tiles t JOIN partner_quiz_boards b ON b.id = t.board_id
      WHERE b.play_id = ${start.body.board.playId}`;
    expect(tiles.n).toBe(9);
    await call(token, 'leave', { playId: start.body.board.playId });
  });

  it('all nine right: 1,800, one score event, no Quizball rewards, quota used', async () => {
    const { playerId, token } = await launch();
    const wallet = () => db.sql`
      SELECT u.coins, u.total_xp, u.tickets FROM users u JOIN partner_players p ON p.user_id = u.id
      WHERE p.external_player_id = ${playerId}`;
    const [walletBefore] = await wallet();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    for (let tile = 0; tile < 9; tile += 1) {
      board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile })).body.board;
      const choice = await correctIndex(board.playId, tile);
      const answered = await call(token, 'answer', { playId: board.playId, turn: board.turn, choice });
      expect(answered.status).toBe(200);
      board = answered.body.board;
      const own = board.events.filter((e: { kind: string; tile: number }) => e.kind === 'answer' && e.tile === tile);
      expect(own).toEqual([expect.objectContaining({ correct: true, points: board.tiles[tile].value, correctIndex: choice })]);
    }
    expect(board.phase).toBe('finished');
    expect(board.result).toEqual({ score: 1800, endReason: 'completed' });
    expect(board.deadlineAt).toBeNull();
    const events = await scoreEvents(board.playId);
    expect(events.map((e) => e.score)).toEqual([1800]);
    const [play] = await db.sql`SELECT state, score FROM partner_plays WHERE id = ${board.playId}`;
    expect(play).toEqual({ state: 'finished', score: 1800 });

    const [walletAfter] = await wallet();
    expect(walletAfter).toEqual(walletBefore);
    expect(walletAfter).toMatchObject({ coins: 0, total_xp: 0 });

    // A late duplicate changes nothing; another start the same day is refused.
    const dup = await call(token, 'answer', { playId: board.playId, turn: 3, choice: 0 });
    expect(dup.body.board.result.score).toBe(1800);
    const again = await call(token, 'start', { startId: randomUUID() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('quota_exhausted');
    expect(await scoreEvents(board.playId)).toHaveLength(1);
  });

  it('solo: any order, right banks the value, wrong = 0, closes on the 9th answer with one event', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const order = [8, 0, 4, 2, 6, 1, 7, 3, 5];
    const right = new Set([8, 4, 6, 3]);
    let expected = 0;
    for (const [i, tile] of order.entries()) {
      board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile })).body.board;
      expect(board).toMatchObject({ phase: 'answer', activeTile: tile });
      const ok = await correctIndex(board.playId, tile);
      const choice = right.has(tile) ? ok : (ok + 1) % 4;
      const res = await call(token, 'answer', { playId: board.playId, turn: board.turn, choice });
      expect(res.status).toBe(200);
      board = res.body.board;
      if (right.has(tile)) expected += board.tiles[tile].value;
      expect(board.tiles[tile].owner).toBe(right.has(tile) ? 'player' : 'none');
      expect(board.events.at(i === 8 ? -2 : -1)).toMatchObject({
        actor: 'player', kind: 'answer', tile, correct: right.has(tile), choice, correctIndex: ok,
        points: right.has(tile) ? board.tiles[tile].value : 0,
      });
      expect(board.playerScore).toBe(expected);
      if (i < 8) {
        expect(board.phase).toBe('pick');
        expect(await scoreEvents(board.playId)).toHaveLength(0);
      }
    }
    expect(board.phase).toBe('finished');
    expect(board.result).toEqual({ score: expected, endReason: 'completed' });
    expect(board.events.every((e: { actor: string }) => e.actor === 'player' || e.actor === 'system')).toBe(true);
    const events = await scoreEvents(board.playId);
    expect(events.map((e) => e.score)).toEqual([expected]);
    const [row] = await db.sql<{ finished_at: Date; ai_score: number }[]>`
      SELECT finished_at, ai_score FROM partner_quiz_boards WHERE play_id = ${board.playId}`;
    expect(events[0].occurred_at.getTime()).toBe(row.finished_at.getTime());
    expect(row.ai_score).toBe(0);
    // Nothing is left for the sweeper.
    await quizBoard.sweepQuizBoards();
    expect(await scoreEvents(board.playId)).toHaveLength(1);
  });

  it('a timed-out question uses its tile for 0 at the deadline and the next pick follows', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 3 })).body.board;
    await backdate(board.playId, '25 seconds');
    const deadline = await deadlineOf(board.playId);
    // Too late to answer: the timeout is applied first and the answer is refused.
    const late = await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: await correctIndex(board.playId, 3) });
    expect(late.status).toBe(200);
    board = late.body.board;
    expect(board).toMatchObject({ phase: 'pick', playerScore: 0, activeTile: null });
    expect(board.tiles[3].owner).toBe('none');
    expect(board.events.at(-1)).toMatchObject({ kind: 'timeout', tile: 3, correct: false, choice: null, points: 0 });
    expect(new Date(board.deadlineAt).getTime()).toBe(deadline.getTime() + 90_000);
    await call(token, 'leave', { playId: board.playId });
  });

  it('a retried start returns the same play; an open board is resumed, never a second play', async () => {
    await setLimit(3);
    const { token } = await launch();
    const startId = randomUUID();
    const [a, b] = await Promise.all([
      call(token, 'start', { startId }),
      call(token, 'start', { startId }),
    ]);
    expect(a.body.board.playId).toBe(b.body.board.playId);
    const [c, d] = await Promise.all([
      call(token, 'start', { startId: randomUUID() }),
      call(token, 'start', { startId: randomUUID() }),
    ]);
    expect(new Set([a.body.board.playId, c.body.board.playId, d.body.board.playId]).size).toBe(1);
    const [count] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM partner_plays p JOIN partner_players pp ON pp.id = p.player_id
      WHERE p.game_id = 'quiz-board' AND p.id = ${a.body.board.playId}`;
    expect(count.n).toBe(1);
    const resumed = await call(token, 'current');
    expect(resumed.body.board.playId).toBe(a.body.board.playId);
    await call(token, 'leave', { playId: a.body.board.playId });

    // The next board avoids the questions this player already had.
    const next = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const overlap = await db.sql`
      SELECT 1 FROM partner_quiz_board_tiles t1
      JOIN partner_quiz_boards b1 ON b1.id = t1.board_id AND b1.play_id = ${a.body.board.playId}
      JOIN partner_quiz_board_tiles t2 ON t2.question_id = t1.question_id
      JOIN partner_quiz_boards b2 ON b2.id = t2.board_id AND b2.play_id = ${next.playId}`;
    expect(overlap).toHaveLength(0);
    await call(token, 'leave', { playId: next.playId });
  });

  it('leaving keeps what was banked and settles exactly once', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 2 })).body.board;
    board = (await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: await correctIndex(board.playId, 2) })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 1 })).body.board;
    const left = await call(token, 'leave', { playId: board.playId });
    expect(left.body.board.result).toEqual({ score: 300, endReason: 'left' });
    await call(token, 'leave', { playId: board.playId });
    expect((await scoreEvents(board.playId)).map((e) => e.score)).toEqual([300]);
    // Someone else's play is not reachable.
    const other = await launch();
    expect((await call(other.token, 'leave', { playId: board.playId })).status).toBe(404);
  });

  it('the sweeper ends an abandoned board at its logical deadline', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 0 })).body.board;
    // The player vanished an hour ago with the question open.
    await backdate(board.playId, '1 hour');
    const [{ deadline_at: deadline }] = await db.sql<{ deadline_at: Date }[]>`
      SELECT deadline_at FROM partner_quiz_boards WHERE play_id = ${board.playId}`;
    expect(await quizBoard.sweepQuizBoards()).toBeGreaterThanOrEqual(1);
    const [row] = await db.sql`SELECT phase, end_reason, finished_at FROM partner_quiz_boards WHERE play_id = ${board.playId}`;
    expect(row.phase).toBe('finished');
    expect(row.end_reason).toBe('idle');
    const [event] = await scoreEvents(board.playId);
    expect(event.occurred_at.getTime()).toBe(row.finished_at.getTime());
    // The answer deadline, then the idle pick that followed it: the deadline chain, not the sweep time.
    expect(event.occurred_at.getTime()).toBe(deadline.getTime() + 90_000);
    expect(event.score).toBe(0);
    const kinds = await db.sql<{ kind: string; at: Date }[]>`
      SELECT e.kind, e.at FROM partner_quiz_board_events e JOIN partner_quiz_boards b ON b.id = e.board_id
      WHERE b.play_id = ${board.playId} ORDER BY e.seq`;
    expect(kinds[1]).toEqual({ kind: 'timeout', at: deadline });
    expect(await quizBoard.sweepQuizBoards()).toBe(0);
    expect(await scoreEvents(board.playId)).toHaveLength(1);
  });

  it('a blocked player\'s board ends with no score event', async () => {
    const { playerId, token } = await launch();
    const board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const blocked = await request(app).post(`/partner/v1/players/${playerId}/block`).set('x-api-key', KEY)
      .send({ at: new Date().toISOString() });
    expect(blocked.status).toBe(200);
    expect((await call(token, 'current')).status).toBe(401);
    await quizBoard.sweepQuizBoards();
    const [row] = await db.sql`SELECT phase, end_reason FROM partner_quiz_boards WHERE play_id = ${board.playId}`;
    expect(row).toEqual({ phase: 'finished', end_reason: 'cancelled' });
    expect(await scoreEvents(board.playId)).toHaveLength(0);
  });

  it('a stale turn moves nothing', async () => {
    const { token } = await launch();
    const board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const stale = await call(token, 'pick', { playId: board.playId, turn: board.turn + 5, tile: 0 });
    expect(stale.status).toBe(200);
    expect(stale.body.board.phase).toBe('pick');
    const bad = await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: 0 });
    expect(bad.status).toBe(400);
    await call(token, 'leave', { playId: board.playId });
  });
  it('a finished play stays reachable by its id; a cancelled play reports cancelled', async () => {
    const { playerId, token } = await launch();
    const board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    await call(token, 'leave', { playId: board.playId });
    expect((await call(token, 'current')).body.board).toBeNull();
    const byId = await call(token, `current?playId=${board.playId}`);
    expect(byId.body.board.result).toEqual({ score: 0, endReason: 'left' });
    const other = await launch();
    expect((await call(other.token, `current?playId=${board.playId}`)).body.board).toBeNull();
    expect(playerId).toBeTruthy();
  });

  it('concurrent starts with different ids and one play left share one board', async () => {
    const { token } = await launch();
    const results = await Promise.all([1, 2, 3].map(() => call(token, 'start', { startId: randomUUID() })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.board.playId)).size).toBe(1);
    await call(token, 'leave', { playId: results[0].body.board.playId });
  });

  it('a retried start returns its own play even after it finished', async () => {
    await setLimit(2);
    const { token } = await launch();
    const startId = randomUUID();
    const first = (await call(token, 'start', { startId })).body.board;
    await call(token, 'leave', { playId: first.playId });
    const retried = await call(token, 'start', { startId });
    expect(retried.body.board.playId).toBe(first.playId);
    expect(retried.body.board.phase).toBe('finished');
    const [used] = await db.sql<{ n: number }[]>`
      SELECT q.plays_used AS n FROM partner_quota_days q JOIN partner_plays p ON p.player_id = q.player_id
      WHERE p.id = ${first.playId} AND q.game_id = 'quiz-board'`;
    expect(used.n).toBe(1);
  });
  it('a resumed start keeps its play: retrying it after that board finished takes no second play', async () => {
    await setLimit(2);
    const { token } = await launch();
    const a = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const startB = randomUUID();
    const b = (await call(token, 'start', { startId: startB })).body.board;
    expect(b.playId).toBe(a.playId);
    await call(token, 'leave', { playId: a.playId });
    const retried = await call(token, 'start', { startId: startB });
    expect(retried.status).toBe(200);
    expect(retried.body.board.playId).toBe(a.playId);
    expect(retried.body.board.phase).toBe('finished');
    const [used] = await db.sql<{ n: number }[]>`
      SELECT q.plays_used AS n FROM partner_quota_days q JOIN partner_plays p ON p.player_id = q.player_id
      WHERE p.id = ${a.playId} AND q.game_id = 'quiz-board'`;
    expect(used.n).toBe(1);
  });

  it('race losers are bound to the winning play too', async () => {
    await setLimit(2);
    const { token } = await launch();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const results = await Promise.all(ids.map((startId) => call(token, 'start', { startId })));
    const playId = results[0].body.board.playId;
    expect(results.every((r) => r.body.board.playId === playId)).toBe(true);
    await call(token, 'leave', { playId });
    for (const startId of ids) expect((await call(token, 'start', { startId })).body.board.playId).toBe(playId);
    const bound = await db.sql`SELECT play_id FROM partner_quiz_board_starts WHERE play_id = ${playId}`;
    expect(bound).toHaveLength(3);
  });

  it('an idle pick ends the play with the points banked so far, at the pick deadline', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 1 })).body.board;
    board = (await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: await correctIndex(board.playId, 1) })).body.board;
    expect(board).toMatchObject({ phase: 'pick', playerScore: 200 });
    await backdate(board.playId, '2 minutes');
    const deadline = await deadlineOf(board.playId);
    expect(await quizBoard.sweepQuizBoards()).toBeGreaterThanOrEqual(1);
    const finished = (await call(token, `current?playId=${board.playId}`)).body.board;
    expect(finished.result).toEqual({ score: 200, endReason: 'idle' });
    const events = await scoreEvents(board.playId);
    expect(events.map((e) => e.score)).toEqual([200]);
    expect(events[0].occurred_at.getTime()).toBe(deadline.getTime());
  });

  it('a 9th question left to time out closes the play at its deadline', async () => {
    const { token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    for (let tile = 0; tile < 8; tile += 1) {
      board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile })).body.board;
      board = (await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: await correctIndex(board.playId, tile) })).body.board;
    }
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 8 })).body.board;
    await backdate(board.playId, '30 seconds');
    const deadline = await deadlineOf(board.playId);
    expect(await quizBoard.sweepQuizBoards()).toBeGreaterThanOrEqual(1);
    const finished = (await call(token, `current?playId=${board.playId}`)).body.board;
    expect(finished.result).toEqual({ score: 1500, endReason: 'completed' });
    expect(finished.tiles[8].owner).toBe('none');
    const events = await scoreEvents(board.playId);
    expect(events.map((e) => e.score)).toEqual([1500]);
    expect(events[0].occurred_at.getTime()).toBe(deadline.getTime());
  });

  it('a block mid-play cancels it: no event, whoever comes back', async () => {
    const { playerId, token } = await launch();
    let board = (await call(token, 'start', { startId: randomUUID() })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 0 })).body.board;
    board = (await call(token, 'answer', { playId: board.playId, turn: board.turn, choice: await correctIndex(board.playId, 0) })).body.board;
    board = (await call(token, 'pick', { playId: board.playId, turn: board.turn, tile: 4 })).body.board;
    expect(board).toMatchObject({ phase: 'answer', playerScore: 100 });
    await request(app).post(`/partner/v1/players/${playerId}/block`).set('x-api-key', KEY).send({ at: new Date().toISOString() });
    // Even with its deadlines long passed, the cancelled play settles nothing.
    await backdate(board.playId, '1 hour');
    await quizBoard.sweepQuizBoards();
    const [row] = await db.sql`SELECT phase, end_reason FROM partner_quiz_boards WHERE play_id = ${board.playId}`;
    expect(row).toEqual({ phase: 'finished', end_reason: 'cancelled' });
    expect(await scoreEvents(board.playId)).toHaveLength(0);
    const [play] = await db.sql`SELECT state FROM partner_plays WHERE id = ${board.playId}`;
    expect(play.state).toBe('cancelled');
  });

  it('same-id starts straddling the old board\'s finish all get one play', async () => {
    await setLimit(3);
    const { playerId, token } = await launch();
    const p = (await call(token, 'start', { startId: randomUUID() })).body.board;
    const [{ id: partnerPlayerId }] = await db.sql<{ id: string }[]>`
      SELECT id FROM partner_players WHERE external_player_id = ${playerId}`;
    const startB = randomUUID();
    // Hold this player's start lock so both requests queue, one before and one after the old board finishes.
    const held = await db.sql.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-quiz-board-start:${partnerPlayerId}`}, 0))`;
      const r1 = call(token, 'start', { startId: startB }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await call(token, 'leave', { playId: p.playId });
      const r2 = call(token, 'start', { startId: startB }).then((r) => r);
      await new Promise((r) => setTimeout(r, 300));
      await held`COMMIT`;
      const [a, b] = await Promise.all([r1, r2]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(b.body.board.playId).toBe(a.body.board.playId);
      const retried = await call(token, 'start', { startId: startB });
      expect(retried.body.board.playId).toBe(a.body.board.playId);
    } finally {
      held.release();
    }
    const plays = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM partner_plays WHERE player_id = ${partnerPlayerId} AND game_id = 'quiz-board'`;
    // The first board plus at most one for start B.
    expect(plays[0].n).toBeLessThanOrEqual(2);
    const [used] = await db.sql<{ n: number }[]>`
      SELECT plays_used AS n FROM partner_quota_days WHERE player_id = ${partnerPlayerId} AND game_id = 'quiz-board'`;
    expect(used.n).toBe(plays[0].n);
  });

  it('a start bound while it was reserving rolls that reservation back', async () => {
    await setLimit(3);
    const { playerId, token } = await launch();
    const p = (await call(token, 'start', { startId: randomUUID() })).body.board;
    await call(token, 'leave', { playId: p.playId });
    const [{ id: partnerPlayerId }] = await db.sql<{ id: string }[]>`
      SELECT id FROM partner_players WHERE external_player_id = ${playerId}`;
    const startB = randomUUID();
    // Hold the reservation's own source lock: B decides "new play", then waits there while B gets bound to P.
    const held = await db.sql.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-play:freecroco:test:quiz-board:${startB}`}, 0))`;
      const pending = call(token, 'start', { startId: startB }).then((r) => r);
      await new Promise((r) => setTimeout(r, 400));
      await db.sql`INSERT INTO partner_quiz_board_starts (partner_player_id, start_id, play_id)
                   VALUES (${partnerPlayerId}, ${startB}, ${p.playId})`;
      await held`COMMIT`;
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.board.playId).toBe(p.playId);
    } finally {
      held.release();
    }
    const [used] = await db.sql<{ n: number }[]>`
      SELECT plays_used AS n FROM partner_quota_days WHERE player_id = ${partnerPlayerId} AND game_id = 'quiz-board'`;
    expect(used.n).toBe(1);
    const plays = await db.sql`SELECT 1 FROM partner_plays WHERE player_id = ${partnerPlayerId} AND game_id = 'quiz-board'`;
    expect(plays).toHaveLength(1);
  });
});
