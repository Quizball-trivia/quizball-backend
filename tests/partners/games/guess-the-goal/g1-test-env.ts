import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import postgres from 'postgres';
import { expect } from 'vitest';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from '../../test-db.js';

/**
 * Real-PostgreSQL environment for the G1 partner games (Guess the Goal, Card Detective): the partner core, delivery
 * and G1 migrations over minimal stand-ins of the tables they touch. Every goal and card is generated here: no real
 * content (and no answers) in the repo. Tables a reward would write (store_transaction_logs, user_xp_events,
 * guess_the_goal_solves) deliberately do not exist, so any reward path fails the test.
 *   PARTNER_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_partner_test_g1 (its _ggt / _cd siblings are created and dropped)
 */
const isolatedUrl = process.env.PARTNER_TEST_DATABASE_URL;
const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
const adminTarget = !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null;
export const hasTestDb = Boolean(isolated || adminTarget);

const MIGRATIONS = [
  '20261005121000_partner_core.sql',
  '20261005121001_partner_core_validate.sql',
  '20261005130000_partner_delivery.sql',
  '20261006100000_partner_g1_guess_the_goal_card_detective.sql',
].map((f) => join(__dirname, '../../../../supabase/migrations', f));

const FIXTURE = `
  DROP TABLE IF EXISTS partner_card_detective_plays, partner_ggt_plays, partner_score_event_attempts, partner_score_events,
    partner_plays, partner_quota_days, partner_audit, partner_limit_overrides, partner_games, partner_config_versions,
    partner_sessions, partner_players, partner_operator_memberships, guess_the_goal_sessions, goal_choreographies,
    daily_card_detective_sets, daily_fifa_card_sets, daily_challenge_configs, fifa_cards, audit_logs, ranked_profiles,
    users CASCADE;
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
  CREATE TABLE goal_choreographies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, status text NOT NULL, difficulty text NOT NULL,
    title jsonb NOT NULL, options jsonb NOT NULL, fun_fact jsonb, bonus jsonb, players jsonb NOT NULL, steps jsonb NOT NULL,
    video_url text, mirrored_url text, clip_start_s integer, clip_end_s integer, featured_rank integer,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE guess_the_goal_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id), goal_id uuid NOT NULL REFERENCES goal_choreographies(id),
    goal_snapshot jsonb NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'guessed', 'complete', 'abandoned')),
    max_points integer NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), guessed_at timestamptz,
    guess_option_id text, guess_correct boolean, revealed_moves integer, points integer NOT NULL DEFAULT 0,
    bonus_option_id text, bonus_correct boolean, bonus_points integer NOT NULL DEFAULT 0,
    first_solve boolean NOT NULL DEFAULT false, coins_awarded integer NOT NULL DEFAULT 0, xp_awarded integer NOT NULL DEFAULT 0,
    bonus_coins_awarded integer NOT NULL DEFAULT 0, bonus_xp_awarded integer NOT NULL DEFAULT 0, client_nonce text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_ggt_guess_recorded CHECK (
      (state = 'active' AND guessed_at IS NULL AND guess_option_id IS NULL) OR (state = 'abandoned')
      OR (state IN ('guessed', 'complete') AND guessed_at IS NOT NULL AND guess_option_id IS NOT NULL)),
    CONSTRAINT chk_ggt_guessed_is_correct CHECK (state <> 'guessed' OR guess_correct = true));
  CREATE UNIQUE INDEX uq_ggt_sessions_active ON guess_the_goal_sessions (user_id) WHERE state IN ('active', 'guessed');
  CREATE TABLE fifa_cards (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_key text NOT NULL, edition text NOT NULL, edition_label text NOT NULL,
    name text NOT NULL, name_ka text, accepted text[] NOT NULL DEFAULT '{}', overall integer NOT NULL, position text NOT NULL,
    nation text NOT NULL, nation_code text NOT NULL, league text NOT NULL, club text NOT NULL,
    pac integer NOT NULL, sho integer NOT NULL, pas integer NOT NULL, dri integer NOT NULL, def integer NOT NULL, phy integer NOT NULL,
    photo_id integer, photo_ver text, face_source text NOT NULL DEFAULT 'none', difficulty text NOT NULL,
    is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE daily_card_detective_sets (challenge_day date PRIMARY KEY, card_ids uuid[] NOT NULL);
  CREATE TABLE daily_fifa_card_sets (challenge_day date PRIMARY KEY, card_ids uuid[] NOT NULL);
  CREATE TABLE daily_challenge_configs (challenge_type text PRIMARY KEY, is_active boolean NOT NULL, settings jsonb NOT NULL);
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const KEY = 'test-inbound-key-'.padEnd(64, 'x');
const DIFFICULTIES = ['easy', 'medium', 'hard', 'veryHard'] as const;

export interface G1Env {
  sql: ReturnType<typeof postgres>;
  app: express.Express;
  close(): Promise<void>;
  /** A launched, redeemed player: its bearer and ids. */
  launch(): Promise<{ access: string; externalId: string; userId: string; playerId: string }>;
  setLimit(gameId: string, limit: number): Promise<void>;
  /** Generated goals: option `ok` is right, bonus option `bok` is right. */
  seedGoal(opts?: { bonus?: boolean }): Promise<string>;
  /** Generated cards, distinct names; returns their ids. */
  seedCards(count: number, prefix?: string): Promise<string[]>;
  events(externalId: string): Promise<Array<{ game_id: string; score: number; occurred_at: Date; play_id: string }>>;
  /**
   * A block landing while `request` is in flight: the block's transaction (player row, then its started plays, as
   * the partner core does it) is open before the request starts and commits while the request waits on it.
   */
  blockDuring<T>(playerId: string, request: () => Promise<T>): Promise<T>;
  /** A committed block followed by an unblock. */
  blockAndUnblock(playerId: string): Promise<void>;
}

/** Each test file gets a database of its own (`suffix`), created next to the isolated one or from CI's admin one. */
export async function setupG1Env(db: { sql: ReturnType<typeof postgres> }, suffix: 'ggt' | 'cd'): Promise<G1Env> {
  process.env.PARTNER_JWT_SECRET = 'integration-partner-jwt-secret-32-bytes';
  process.env.PARTNER_RESPONSE_SEAL_KEY = 'integration-partner-seal-key-32-bytes!!';
  const base = (isolated ?? adminTarget)!;
  const admin = postgres({ ...base, max: 1, onnotice: () => undefined });
  const createdDatabase = isolated
    ? `${isolated.database}_${suffix}`
    : `partner_g1_${suffix}_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${createdDatabase}" WITH (FORCE)`);
  // CREATE DATABASE copies template1 and fails while another session is connected to it (parallel suites): retry.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin`CREATE DATABASE ${admin(createdDatabase)}`;
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    }
  }
  const target = { ...base, database: createdDatabase };
  db.sql = postgres({ ...target, max: 10, onnotice: () => undefined });
  // Nothing destructive runs until the pool is proven to be on the expected database.
  const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
  expect(current).toBe(target.database);
  await db.sql.unsafe(FIXTURE);
  for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
  await db.sql`UPDATE partner_games SET ready = true WHERE game_id IN ('guess-the-goal', 'card-detective')`;

  const partner = await import('../../../../src/modules/partners/partner-config.js');
  process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
    slug: 'freecroco',
    environment: 'test',
    inboundKeySha256: [partner.sha256Hex(KEY)],
    allowedCidrs: ['127.0.0.1/32', '::1/128', '::ffff:127.0.0.1/128'],
    launchBaseUrl: 'https://staging-freecroco.quizball.io',
  });
  partner.resetPartnerConfigCache();
  const { partnerRoutes } = await import('../../../../src/http/routes/partner.routes.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(partnerRoutes);

  let seq = 0;
  const sql = db.sql;
  return {
    sql,
    app,
    async close() {
      try {
        await sql.end({ timeout: 2 });
      } finally {
        try {
          await admin.unsafe(`DROP DATABASE IF EXISTS "${createdDatabase}" WITH (FORCE)`);
        } finally {
          await admin.end({ timeout: 2 });
        }
      }
    },
    async launch() {
      seq += 1;
      const externalId = `g1-${Date.now().toString(36)}-${seq}`;
      const init = await request(app).post('/partner/v1/sessions/init').set('x-api-key', KEY)
        .send({ playerId: externalId, language: 'en', channel: 'WEB', requestId: `req-${externalId}`, username: 'tes****er' });
      expect(init.status).toBe(200);
      const redeemed = await request(app).post('/partner/v1/sessions/redeem').send({ token: init.body.oneTimeToken });
      expect(redeemed.status).toBe(200);
      const [row] = await sql<{ id: string; user_id: string }[]>`
        SELECT id, user_id FROM partner_players WHERE external_player_id = ${externalId}`;
      return { access: redeemed.body.accessToken, externalId, userId: row.user_id, playerId: row.id };
    },
    async setLimit(gameId, limit) {
      await sql`UPDATE partner_games SET default_limit = ${limit} WHERE environment = 'test' AND game_id = ${gameId}`;
    },
    async seedGoal(opts = {}) {
      seq += 1;
      const text = (en: string) => ({ en });
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO goal_choreographies (slug, status, difficulty, title, options, fun_fact, bonus, players, steps, mirrored_url)
        VALUES (${`test-goal-${seq}`}, 'published', 'easy', ${sql.json(text(`Test goal ${seq}`))},
          ${sql.json([
            { id: 'ok', text: text('Right goal'), is_correct: true },
            { id: 'x1', text: text('Other goal 1'), is_correct: false },
            { id: 'x2', text: text('Other goal 2'), is_correct: false },
            { id: 'x3', text: text('Other goal 3'), is_correct: false },
          ])},
          ${sql.json(text(`Fun fact ${seq}`))},
          ${opts.bonus === false ? null : sql.json({
            question: text('Which foot?'),
            options: [
              { id: 'bok', text: text('Left'), is_correct: true },
              { id: 'bx', text: text('Right'), is_correct: false },
            ],
          })},
          ${sql.json([{ id: 'striker', team: 'attack', at: [50, 50] }, { id: 'keeper', team: 'keeper', at: [95, 50] }])},
          ${sql.json([{ kind: 'shot', player: 'striker', to: [100, 50], duration: 1 }])},
          ${`https://cdn.example.test/goal-${seq}.mp4`})
        RETURNING id`;
      return row.id;
    },
    async seedCards(count, prefix = 'Card') {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        const name = `${prefix} Testplayer${String.fromCharCode(65 + (seq % 26))}${seq}`;
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO fifa_cards (source_key, edition, edition_label, name, accepted, overall, position, nation, nation_code,
            league, club, pac, sho, pas, dri, def, phy, difficulty)
          VALUES (${`test:${seq}`}, 'fc24', 'FC 24', ${name}, ${sql.array([name])}, 80, 'ST', 'Testland', 'tl',
            'Test League', 'Test FC', 81, 82, 83, 84, 45, 76, ${DIFFICULTIES[i % DIFFICULTIES.length]})
          RETURNING id`;
        ids.push(row.id);
      }
      return ids;
    },
    async blockDuring(playerId, run) {
      const blocker = await sql.reserve();
      try {
        await blocker`BEGIN`;
        await blocker`UPDATE partner_players SET status = 'blocked', status_version = status_version + 1 WHERE id = ${playerId}`;
        await blocker`UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp()
          WHERE player_id = ${playerId} AND state = 'started'`;
        // Promise.resolve adopts the thenable now: a supertest request only starts once something awaits it.
        const pending = Promise.resolve(run());
        // Long enough for the request to pass authentication and queue on the player lock.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await blocker`COMMIT`;
        return await pending;
      } finally {
        blocker.release();
      }
    },
    async blockAndUnblock(playerId) {
      await sql.begin(async (tx) => {
        await tx`UPDATE partner_players SET status = 'blocked' WHERE id = ${playerId}`;
        await tx`UPDATE partner_plays SET state = 'cancelled', cancelled_at = clock_timestamp() WHERE player_id = ${playerId} AND state = 'started'`;
      });
      await sql`UPDATE partner_players SET status = 'active' WHERE id = ${playerId}`;
    },
    async events(externalId) {
      return sql`
        SELECT game_id, score, occurred_at, play_id FROM partner_score_events WHERE player_id = ${externalId}
        ORDER BY id` as never;
    },
  };
}
