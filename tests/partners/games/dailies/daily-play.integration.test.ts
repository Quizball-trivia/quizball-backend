import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from '../../test-db.js';

/**
 * The Freecroco dailies on real PostgreSQL: partner core + delivery + dailies migrations over a minimal users and
 * question bank, driven through the partner routes. Runs in CI against its PostgreSQL service
 * (MIGRATION_TEST_DATABASE_URL: creates and drops a database of its own), or locally against an isolated database:
 *   PARTNER_DAILIES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_g2
 * All content below is generated: the repository is public.
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
vi.mock('../../../../src/realtime/redis.js', () => ({
  getRedisClient: () => ({ isReady: true, isOpen: false, ping: async () => 'PONG' }),
}));
const publicIds = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../../../src/modules/daily-challenges/daily-challenges.service.js', () => ({
  dailyChallengesService: { listPublicGuestSetQuestionIds: async () => publicIds.ids },
}));

const isolatedUrl = process.env.PARTNER_DAILIES_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;

const MIGRATIONS = [
  '20261005121000_partner_core.sql',
  '20261005121001_partner_core_validate.sql',
  '20261005130000_partner_delivery.sql',
  '20261006110000_partner_dailies.sql',
].map((f) => join(__dirname, '../../../../supabase/migrations', f));

const FIXTURE = `
  DROP TABLE IF EXISTS partner_daily_plays, partner_content_pool, partner_score_event_attempts, partner_score_events,
    partner_plays, partner_quota_days, partner_audit, partner_limit_overrides, partner_games, partner_config_versions,
    partner_sessions, partner_players, partner_operator_memberships, question_payloads, questions, featured_categories,
    categories, audit_logs, ranked_profiles, users CASCADE;
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
    action text NOT NULL, entity_type text NOT NULL, entity_id uuid, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name jsonb NOT NULL, is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE featured_categories (category_id uuid NOT NULL REFERENCES categories(id));
  CREATE TABLE questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES categories(id), type text NOT NULL,
    difficulty text NOT NULL DEFAULT 'easy', status text NOT NULL DEFAULT 'published', visibility text NOT NULL DEFAULT 'public',
    ranked_eligible boolean NOT NULL DEFAULT true, prompt jsonb, explanation jsonb);
  CREATE TABLE question_payloads (question_id uuid PRIMARY KEY REFERENCES questions(id), payload jsonb NOT NULL);
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const KEY = 'test-inbound-key-'.padEnd(64, 'x');
const GAMES = ['countdown', 'true-false', 'pick-em', 'career-path', 'higher-lower'] as const;

/** Generated bank content: statement N is "true" when N is even; every career player is "Fixture Player N". */
function payloadFor(type: string, n: number): { prompt: unknown; payload: unknown } {
  switch (type) {
    case 'true_false':
      return {
        prompt: { en: `Fixture statement ${n}` },
        payload: { type, options: [{ id: 'true', text: { en: 'True' }, is_correct: n % 2 === 0 }, { id: 'false', text: { en: 'False' }, is_correct: n % 2 !== 0 }] },
      };
    case 'imposter_multi_select':
      return {
        prompt: { en: `Fixture pick ${n}` },
        payload: { type, options: ['a', 'b', 'c', 'd'].map((id, i) => ({ id: `${id}${n}`, text: { en: `Choice ${id}${n}` }, is_correct: i < 2 })) },
      };
    case 'career_path':
      return {
        prompt: null,
        payload: { type, clubs: [{ en: `Club ${n}A` }, { en: `Club ${n}B` }], display_answer: { en: `Fixture Player ${n}` }, accepted_answers: [`Fixture Player ${n}`] },
      };
    case 'high_low':
      return {
        prompt: { en: `Fixture stat ${n}` },
        payload: {
          type, stat_label: { en: 'Fixture points' },
          matchups: [0, 1].map((m) => ({ id: `m${m}`, left_name: { en: `Left ${n}${m}` }, left_value: 10 + m, right_name: { en: `Right ${n}${m}` }, right_value: 1 + m })),
        },
      };
    case 'countdown_list':
      return {
        prompt: null,
        payload: { type, prompt: { en: `Fixture list ${n}` }, answer_groups: ['Kilo', 'Lima', 'Mike'].map((w, i) => ({ id: `g${i}`, display: { en: `${w} ${n}` }, accepted_answers: [`${w} ${n}`] })) },
      };
    default:
      throw new Error(type);
  }
}

describe.skipIf(!isolated && !adminTarget)('partner dailies on real Postgres', { timeout: 30_000 }, () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let app: express.Express;
  let dailies: typeof import('../../../../src/modules/partners/games/dailies/index.js');
  const questionIds: Record<string, string[]> = {};

  beforeAll(async () => {
    process.env.PARTNER_JWT_SECRET = 'integration-partner-jwt-secret-32-bytes';
    process.env.PARTNER_RESPONSE_SEAL_KEY = 'integration-partner-seal-key-32-bytes!!';
    let target = isolated;
    if (!target) {
      admin = postgres({ ...adminTarget!, max: 1, onnotice: () => undefined });
      const name = `partner_dailies_${randomUUID().replaceAll('-', '')}`;
      await admin`CREATE DATABASE ${admin(name)}`;
      createdDatabase = name;
      target = { ...adminTarget!, database: name };
    }
    db.sql = postgres({ ...target, max: 10, onnotice: () => undefined });
    const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
    expect(current).toBe(target.database);
    await db.sql.unsafe(FIXTURE);
    for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
    // Re-runnable.
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATIONS[3], 'utf8')));

    const [cat] = await db.sql<{ id: string }[]>`INSERT INTO categories (name) VALUES (${db.sql.json({ en: 'Fixtures' })}) RETURNING id`;
    for (const type of ['true_false', 'imposter_multi_select', 'career_path', 'high_low', 'countdown_list']) {
      questionIds[type] = [];
      for (let n = 0; n < 12; n += 1) {
        const { prompt, payload } = payloadFor(type, n);
        const [q] = await db.sql<{ id: string }[]>`
          INSERT INTO questions (category_id, type, prompt) VALUES (${cat.id}, ${type}, ${prompt === null ? null : db.sql.json(prompt as never)}) RETURNING id`;
        await db.sql`INSERT INTO question_payloads (question_id, payload) VALUES (${q.id}, ${db.sql.json(payload as never)})`;
        questionIds[type].push(q.id);
      }
    }
    // A draft question never enters the pool.
    await db.sql`UPDATE questions SET status = 'draft' WHERE id = ${questionIds.true_false[11]}`;

    const partner = await import('../../../../src/modules/partners/partner-config.js');
    process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
      slug: 'freecroco', environment: 'test', inboundKeySha256: [partner.sha256Hex(KEY)],
      allowedCidrs: ['127.0.0.1/32', '::1/128'], launchBaseUrl: 'https://staging-freecroco.quizball.io',
    });
    partner.resetPartnerConfigCache();
    dailies = await import('../../../../src/modules/partners/games/dailies/index.js');
    const { partnerRoutes } = await import('../../../../src/http/routes/partner.routes.js');
    app = express();
    app.use(express.json());
    app.use(partnerRoutes);
    await db.sql`UPDATE partner_games SET ready = true WHERE environment = 'test' AND game_id IN ${db.sql(GAMES as unknown as string[])}`;
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
  const id = (p: string) => `${p}-${Date.now().toString(36)}-${(seq += 1)}`;
  async function launch(playerId = id('p')) {
    const init = await request(app).post('/partner/v1/sessions/init').set('x-api-key', KEY)
      .send({ playerId, language: 'en', channel: 'WEB', requestId: id('req'), username: 'dev****1' });
    expect(init.status).toBe(200);
    const redeemed = await request(app).post('/partner/v1/sessions/redeem').send({ token: init.body.oneTimeToken });
    expect(redeemed.status).toBe(200);
    const token = redeemed.body.accessToken as string;
    const call = (game: string, path: string, body?: unknown) =>
      (body === undefined ? request(app).get(`/partner/v1/games/${game}/${path}`) : request(app).post(`/partner/v1/games/${game}/${path}`).send(body as object))
        .set('authorization', `Bearer ${token}`);
    return { playerId, call };
  }
  const events = (playId: string) => db.sql<{ score: number; occurred_at: Date; game_id: string }[]>`
    SELECT score, occurred_at, game_id FROM partner_score_events WHERE play_id = ${playId}`;
  const content = (playId: string) => db.sql<{ items: Array<Record<string, unknown>> }[]>`
    SELECT items FROM partner_daily_plays WHERE play_id = ${playId}`.then((r) => r[0].items);

  it('seeds the pool idempotently from published bank questions only', async () => {
    const first = await dailies.seedPartnerContentPool(db.sql as never, { partnerSlug: 'freecroco' });
    expect(first.find((r) => r.gameId === 'true-false')).toMatchObject({ eligible: 11, added: 11, poolActive: 11 });
    const again = await dailies.seedPartnerContentPool(db.sql as never, { partnerSlug: 'freecroco' });
    expect(again.every((r) => r.added === 0)).toBe(true);
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM partner_content_pool WHERE question_id = ${questionIds.true_false[11]}`;
    expect(n).toBe(0);
  });

  it('true/false: current question only, server scoring, one event, quota', async () => {
    const { call } = await launch();
    const started = await call('true-false', 'start', { startId: randomUUID() });
    expect(started.status).toBe(200);
    const play = started.body.play;
    expect(play).toMatchObject({ state: 'playing', itemCount: 4, secondsPerItem: 15, index: 0, score: 0, resolved: false, reveal: null });
    expect(play.remainingMs).toBeGreaterThan(13_000);
    expect(JSON.stringify(play)).not.toMatch(/correct|is_correct|answer/i);

    const items = await content(play.playId);
    let expected = 0;
    let view = play;
    for (let i = 0; i < 4; i += 1) {
      const truth = items[i].answer as boolean;
      const pick = i < 3 ? truth : !truth;
      if (i < 3) expected += 50;
      const answered = await call('true-false', 'answer', { playId: view.playId, index: i, answer: { answer: pick } });
      expect(answered.body).toMatchObject({ feedback: { correct: i < 3 }, play: { resolved: true, reveal: { correctAnswer: truth } } });
      // A repeated answer is stale: nothing changes.
      const repeat = await call('true-false', 'answer', { playId: view.playId, index: i, answer: { answer: !pick } });
      expect(repeat.body.feedback).toBeNull();
      expect(repeat.body.play.score).toBe(expected);
      view = (await call('true-false', 'next', { playId: view.playId, index: i })).body.play;
    }
    expect(view).toMatchObject({ state: 'finished', score: 150 });
    const [row] = await db.sql`SELECT state, score FROM partner_plays WHERE id = ${play.playId}`;
    expect(row).toMatchObject({ state: 'finished', score: 150 });
    expect(await events(play.playId)).toHaveLength(1);
    expect((await events(play.playId))[0].score).toBe(150);

    // A retried next after the end changes nothing; a new start is refused for the day.
    expect((await call('true-false', 'next', { playId: play.playId, index: 3 })).body.play.state).toBe('finished');
    expect(await events(play.playId)).toHaveLength(1);
    const again = await call('true-false', 'start', { startId: randomUUID() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('quota_exhausted');
  });

  it('a second start while a play is open resumes it; a retried start id returns the same play', async () => {
    const { call } = await launch();
    const startId = randomUUID();
    const a = await call('pick-em', 'start', { startId });
    const b = await call('pick-em', 'start', { startId });
    const c = await call('pick-em', 'start', { startId: randomUUID() });
    expect(new Set([a.body.play.playId, b.body.play.playId, c.body.play.playId]).size).toBe(1);
    expect((await call('pick-em', 'play')).body.play.playId).toBe(a.body.play.playId);
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM partner_plays WHERE id = ${a.body.play.playId}`;
    expect(n).toBe(1);
  });

  it('pick em and career path judge on the server', async () => {
    const { call } = await launch();
    const pick = (await call('pick-em', 'start', { startId: randomUUID() })).body.play;
    const pickItems = await content(pick.playId);
    const right = (pickItems[0].options as Array<{ id: string; correct: boolean }>).filter((o) => o.correct).map((o) => o.id);
    const r1 = await call('pick-em', 'answer', { playId: pick.playId, index: 0, answer: { optionIds: right } });
    expect(r1.body).toMatchObject({ feedback: { correct: true }, play: { score: 250, reveal: { correctOptionIds: right } } });
    await call('pick-em', 'next', { playId: pick.playId, index: 0 });
    await call('pick-em', 'answer', { playId: pick.playId, index: 1, answer: { optionIds: [right[0]] } });
    expect((await call('pick-em', 'next', { playId: pick.playId, index: 1 })).body.play).toMatchObject({ state: 'finished', score: 250 });

    const career = (await call('career-path', 'start', { startId: randomUUID() })).body.play;
    expect(JSON.stringify(career.item)).not.toContain('Fixture Player');
    const careerItems = await content(career.playId);
    const name = (careerItems[0].displayAnswer as { en: string }).en;
    const typo = name.replace('Player', 'Playr');
    const r2 = await call('career-path', 'answer', { playId: career.playId, index: 0, answer: { guess: typo } });
    expect(r2.body).toMatchObject({ feedback: { correct: true }, play: { score: 100, reveal: { displayAnswer: name } } });
  });

  it('higher/lower and countdown score by the contract', async () => {
    const { call } = await launch();
    let hl = (await call('higher-lower', 'start', { startId: randomUUID() })).body.play;
    expect(JSON.stringify(hl.item)).not.toMatch(/Value"|"value/);
    const hlItems = await content(hl.playId);
    const matchups = hlItems[0].matchups as Array<{ left: { value: number }; right: { value: number } }>;
    for (let m = 0; m < matchups.length; m += 1) {
      const pick = matchups[m].left.value >= matchups[m].right.value ? 'left' : 'right';
      hl = (await call('higher-lower', 'answer', { playId: hl.playId, index: 0, answer: { matchupIndex: m, pick } })).body.play;
    }
    expect(hl).toMatchObject({ resolved: true, score: 200, reveal: { cleared: true } });

    const cd = (await call('countdown', 'start', { startId: randomUUID() })).body.play;
    const cdItems = await content(cd.playId);
    const groups = cdItems[0].groups as Array<{ display: { en: string } }>;
    for (const guess of [groups[0].display.en, groups[0].display.en.toLowerCase(), groups[1].display.en, 'nothing at all']) {
      await call('countdown', 'answer', { playId: cd.playId, index: 0, answer: { guess } });
    }
    const after = (await call('countdown', 'play')).body.play;
    expect(after).toMatchObject({ score: 100, resolved: false });
    expect(after.item.found).toEqual([groups[0].display.en, groups[1].display.en]);
  });

  it('time out: a late answer does not count, the play moves on, occurredAt is the deadline', async () => {
    const { call } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    const items = await content(play.playId);
    await db.sql`UPDATE partner_daily_plays SET item_deadline = clock_timestamp() - interval '5 seconds' WHERE play_id = ${play.playId}`;
    const late = await call('true-false', 'answer', { playId: play.playId, index: 0, answer: { answer: items[0].answer } });
    expect(late.body).toMatchObject({ late: true, feedback: null, play: { resolved: true, score: 0, itemPoints: 0 } });
    const next = await call('true-false', 'next', { playId: play.playId, index: 0 });
    expect(next.body.play).toMatchObject({ index: 1, resolved: false });

    // The last item times out and nobody comes back: the sweeper settles at the deadline.
    await db.sql`UPDATE partner_daily_plays SET current_index = 3, item_deadline = clock_timestamp() - interval '3 minutes' WHERE play_id = ${play.playId}`;
    const [{ deadline }] = await db.sql<{ deadline: Date }[]>`SELECT item_deadline AS deadline FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(await dailies.sweepAbandonedDailyPlays()).toBeGreaterThanOrEqual(1);
    const [event] = await events(play.playId);
    expect(event.score).toBe(0);
    expect(event.occurred_at.getTime()).toBe(deadline.getTime());
    expect(await dailies.sweepAbandonedDailyPlays()).toBe(0);
    expect(await events(play.playId)).toHaveLength(1);
    const [row] = await db.sql`SELECT state, end_cause FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(row).toEqual({ state: 'finished', end_cause: 'abandoned' });
  });

  it('abandoned after scoring keeps the points; quitting ends now with the points so far', async () => {
    const { call } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    const items = await content(play.playId);
    await call('true-false', 'answer', { playId: play.playId, index: 0, answer: { answer: items[0].answer } });
    await db.sql`UPDATE partner_daily_plays SET item_done_at = clock_timestamp() - interval '2 minutes' WHERE play_id = ${play.playId}`;
    await dailies.sweepAbandonedDailyPlays();
    expect((await events(play.playId))[0].score).toBe(50);

    const other = await launch();
    const p2 = (await other.call('career-path', 'start', { startId: randomUUID() })).body.play;
    const quit = await other.call('career-path', 'quit', { playId: p2.playId });
    expect(quit.body.play).toMatchObject({ state: 'finished', score: 0 });
    expect(await events(p2.playId)).toHaveLength(1);
  });

  it('a block ends the daily play at once: no event, and it never resumes after an unblock', async () => {
    const { call, playerId } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    const blocked = await request(app).post(`/partner/v1/players/${playerId}/block`).set('x-api-key', KEY).send({ at: new Date().toISOString() });
    expect(blocked.status).toBe(200);
    expect((await call('true-false', 'play')).status).toBe(401);
    const [row] = await db.sql`SELECT state, end_cause FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(row).toEqual({ state: 'cancelled', end_cause: 'blocked' });

    await request(app).post(`/partner/v1/players/${playerId}/unblock`).set('x-api-key', KEY).send({ at: new Date(Date.now() + 1000).toISOString() });
    const again = await launch(playerId);
    expect((await again.call('true-false', 'play')).body.play).toBeNull();
    const items = await content(play.playId);
    const answered = await again.call('true-false', 'answer', { playId: play.playId, index: 0, answer: { answer: items[0].answer } });
    expect(answered.body).toMatchObject({ feedback: null, play: { state: 'cancelled', score: 0 } });
    expect((await again.call('true-false', 'next', { playId: play.playId, index: 0 })).body.play.state).toBe('cancelled');
    expect((await again.call('true-false', 'start', { startId: randomUUID() })).body.error.code).toBe('quota_exhausted');
    await dailies.sweepAbandonedDailyPlays();
    expect(await events(play.playId)).toHaveLength(0);
  });

  it('the last answer settles the play at once: a block before the browser moves on keeps the points', async () => {
    const { call, playerId } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    const items = await content(play.playId);
    for (let i = 0; i < 3; i += 1) {
      await call('true-false', 'answer', { playId: play.playId, index: i, answer: { answer: items[i].answer } });
      await call('true-false', 'next', { playId: play.playId, index: i });
    }
    const last = await call('true-false', 'answer', { playId: play.playId, index: 3, answer: { answer: items[3].answer } });
    // Still carries the last item so the browser can show its reveal.
    expect(last.body.play).toMatchObject({ state: 'finished', score: 200, resolved: true, reveal: { correctAnswer: items[3].answer } });
    expect(last.body.play.item).not.toBeNull();
    await request(app).post(`/partner/v1/players/${playerId}/block`).set('x-api-key', KEY).send({ at: new Date().toISOString() });
    const [row] = await db.sql`SELECT state, score FROM partner_plays WHERE id = ${play.playId}`;
    expect(row).toMatchObject({ state: 'finished', score: 200 });
    expect((await events(play.playId)).map((e) => e.score)).toEqual([200]);
  });

  it('reopening the game after the last item ran out hands over the finished play once', async () => {
    const { call } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    await db.sql`UPDATE partner_daily_plays SET current_index = 3, item_deadline = clock_timestamp() - interval '5 seconds' WHERE play_id = ${play.playId}`;
    const reopened = (await call('true-false', 'play')).body.play;
    expect(reopened).toMatchObject({ playId: play.playId, state: 'finished', resolved: true });
    expect(reopened.item).not.toBeNull();
    expect(await events(play.playId)).toHaveLength(1);
    expect((await call('true-false', 'play')).body.play).toBeNull();
  });

  it('a daily row left playing under a cancelled parent is reconciled on the next read', async () => {
    const { call } = await launch();
    const play = (await call('pick-em', 'start', { startId: randomUUID() })).body.play;
    // As if the cancel predated the trigger: parent cancelled, daily row still playing.
    await db.sql`ALTER TABLE partner_plays DISABLE TRIGGER trg_partner_plays_cancel_daily`;
    await db.sql`UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp() WHERE id = ${play.playId}`;
    await db.sql`ALTER TABLE partner_plays ENABLE TRIGGER trg_partner_plays_cancel_daily`;
    expect((await call('pick-em', 'play', undefined)).body.play).toBeNull();
    const [row] = await db.sql`SELECT state, end_cause FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(row).toEqual({ state: 'cancelled', end_cause: 'blocked' });
  });

  it('an answer inside the grace still counts; reading the play only closes the item after the grace', async () => {
    const { call } = await launch();
    const play = (await call('true-false', 'start', { startId: randomUUID() })).body.play;
    const items = await content(play.playId);
    await db.sql`UPDATE partner_daily_plays SET item_deadline = clock_timestamp() - interval '300 milliseconds' WHERE play_id = ${play.playId}`;
    // The browser's timeout read lands first, inside the grace: the item stays open.
    expect((await call('true-false', `play?playId=${play.playId}`)).body.play).toMatchObject({ resolved: false, remainingMs: 0 });
    const answered = await call('true-false', 'answer', { playId: play.playId, index: 0, answer: { answer: items[0].answer } });
    expect(answered.body).toMatchObject({ late: false, feedback: { correct: true }, play: { score: 50 } });
    // It is dated when it was accepted, not backdated to the deadline.
    const [row] = await db.sql<{ done: Date; deadline: Date }[]>`
      SELECT item_done_at AS done, item_deadline AS deadline FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(row.done.getTime()).toBeGreaterThan(row.deadline.getTime());

    await call('true-false', 'next', { playId: play.playId, index: 0 });
    await db.sql`UPDATE partner_daily_plays SET item_deadline = clock_timestamp() - interval '2 seconds' WHERE play_id = ${play.playId}`;
    expect((await call('true-false', `play?playId=${play.playId}`)).body.play).toMatchObject({ index: 1, resolved: true, itemPoints: 0 });
  });

  it('quitting after the last item ran out settles at its deadline', async () => {
    const { call } = await launch();
    const play = (await call('career-path', 'start', { startId: randomUUID() })).body.play;
    await db.sql`UPDATE partner_daily_plays SET current_index = 2, item_deadline = clock_timestamp() - interval '5 seconds' WHERE play_id = ${play.playId}`;
    const [{ deadline }] = await db.sql<{ deadline: Date }[]>`SELECT item_deadline AS deadline FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect((await call('career-path', 'quit', { playId: play.playId })).body.play.state).toBe('finished');
    const [event] = await events(play.playId);
    expect(event.occurred_at.getTime()).toBe(deadline.getTime());
  });

  it('concurrent starts with different ids all get the one play (no false "no plays left")', async () => {
    const { call } = await launch();
    for (const game of GAMES) {
      const results = await Promise.all(Array.from({ length: 4 }, () => call(game, 'start', { startId: randomUUID() })));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(new Set(results.map((r) => r.body.play.playId)).size).toBe(1);
    }
  });

  it('partner token only; other players cannot touch a play', async () => {
    expect((await request(app).post('/partner/v1/games/true-false/start').send({ startId: randomUUID() })).status).toBe(401);
    expect((await request(app).get('/partner/v1/games/countdown/play').set('authorization', 'Bearer not-a-token')).status).toBe(401);
    const a = await launch();
    const b = await launch();
    const play = (await a.call('countdown', 'start', { startId: randomUUID() })).body.play;
    const stolen = await b.call('countdown', 'answer', { playId: play.playId, index: 0, answer: { guess: 'x' } });
    expect(stolen.status).toBe(404);
  });

  it('never draws today\'s public daily questions; no pool content → 409 and the play is not used', async () => {
    publicIds.ids = questionIds.high_low.slice(0, 10);
    const { call, playerId } = await launch();
    const play = (await call('higher-lower', 'start', { startId: randomUUID() })).body.play;
    const [row] = await db.sql<{ question_ids: string[] }[]>`SELECT question_ids FROM partner_daily_plays WHERE play_id = ${play.playId}`;
    expect(row.question_ids.every((q) => !publicIds.ids.includes(q))).toBe(true);

    publicIds.ids = [];
    await db.sql`UPDATE partner_content_pool SET active = false WHERE game_id = 'career-path'`;
    const refused = await call('career-path', 'start', { startId: randomUUID() });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('game_not_available');
    const [quota] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM partner_plays pp JOIN partner_players p ON p.id = pp.player_id
      WHERE p.external_player_id = ${playerId} AND pp.game_id = 'career-path'`;
    expect(quota.n).toBe(0);
    await db.sql`UPDATE partner_content_pool SET active = true WHERE game_id = 'career-path'`;
  });

  it('grants no Quizball rewards: wallet and XP of partner players stay untouched', async () => {
    const [row] = await db.sql<{ coins: number; xp: number; tickets: number }[]>`
      SELECT max(u.coins)::int AS coins, max(u.total_xp)::int AS xp, max(u.tickets)::int AS tickets
      FROM users u JOIN partner_players p ON p.user_id = u.id`;
    expect(row).toEqual({ coins: 0, xp: 0, tickets: 0 });
  });
});
