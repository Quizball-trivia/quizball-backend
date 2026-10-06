import 'express-async-errors';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import postgres from 'postgres';
import { expect } from 'vitest';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions, type TestDbOptions } from '../../test-db.js';

/**
 * Real PostgreSQL for the Freecroco Road to Goal / Trivia Mines tests: a minimal schema (users, the question bank
 * tables the site's selection queries read), the partner core + delivery migrations and this stream's migration, and
 * the real /partner/v1 routes (init → redeem → bearer). Each test file names its own isolated-database variable so
 * parallel files never share a database; CI's MIGRATION_TEST_DATABASE_URL creates and drops one per file.
 */
export type DbHolder = { sql: ReturnType<typeof postgres> };

const MIGRATIONS = [
  '20261005121000_partner_core.sql',
  '20261005121001_partner_core_validate.sql',
  '20261005130000_partner_delivery.sql',
  '20261006130000_partner_rtg_mines.sql',
].map((f) => join(__dirname, '../../../../supabase/migrations', f));

const FIXTURE = `
  DROP TABLE IF EXISTS partner_game_starts, partner_mines_runs, partner_rtg_runs, partner_score_event_attempts, partner_score_events,
    partner_plays, partner_quota_days, partner_audit, partner_limit_overrides, partner_games, partner_config_versions,
    partner_sessions, partner_players, partner_operator_memberships, road_to_goal_question_exposures,
    question_payloads, questions, categories, audit_logs, ranked_profiles, users CASCADE;
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
  CREATE TABLE categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_active boolean NOT NULL DEFAULT true);
  CREATE TABLE questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), category_id uuid NOT NULL REFERENCES categories(id),
    type text NOT NULL, difficulty text NOT NULL, status text NOT NULL, visibility text NOT NULL DEFAULT 'public',
    ranked_eligible boolean NOT NULL DEFAULT true, prompt jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE question_payloads (
    question_id uuid PRIMARY KEY REFERENCES questions(id), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE road_to_goal_question_exposures (
    user_id uuid NOT NULL, question_id uuid NOT NULL, exposure_count integer NOT NULL DEFAULT 1,
    last_exposed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (user_id, question_id));
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

/** Generated multiple-choice questions (option "a" is right); nothing from the real bank. */
const SEED_QUESTIONS = `
  WITH c AS (INSERT INTO categories DEFAULT VALUES RETURNING id),
  q AS (
    INSERT INTO questions (category_id, type, difficulty, status, prompt)
    SELECT c.id, 'mcq_single', d.difficulty, 'published', jsonb_build_object('en', 'Generated ' || d.difficulty || ' ' || n)
    FROM c, (VALUES ('easy', 30), ('medium', 30), ('hard', 30)) d(difficulty, total), generate_series(1, d.total) n
    RETURNING id)
  INSERT INTO question_payloads (question_id, payload)
  SELECT q.id, jsonb_build_object('options', jsonb_build_array(
    jsonb_build_object('id', 'a', 'text', jsonb_build_object('en', 'A'), 'is_correct', true),
    jsonb_build_object('id', 'b', 'text', jsonb_build_object('en', 'B'), 'is_correct', false),
    jsonb_build_object('id', 'c', 'text', jsonb_build_object('en', 'C'), 'is_correct', false),
    jsonb_build_object('id', 'd', 'text', jsonb_build_object('en', 'D'), 'is_correct', false)))
  FROM q;
`;

const KEY = 'test-inbound-key-'.padEnd(64, 'x');

export function g4DatabaseTarget(isolatedVariable: string): { isolated: TestDbOptions | null; admin: TestDbOptions | null } {
  const isolatedUrl = process.env[isolatedVariable];
  const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
  const isolated = isolatedUrl ? testDbOptions(isolatedUrl, ISOLATED_DATABASE) : null;
  return { isolated, admin: !isolated && adminUrl ? testDbOptions(adminUrl, ADMIN_DATABASE) : null };
}

export interface G4Harness {
  app: express.Express;
  teardown(): Promise<void>;
  launch(playerId?: string): Promise<{ access: string; playerId: string }>;
  setLimit(gameId: string, limit: number): Promise<void>;
  setStatus(playerId: string, action: 'block' | 'unblock'): Promise<void>;
}

export async function startG4Harness(db: DbHolder, target: ReturnType<typeof g4DatabaseTarget>): Promise<G4Harness> {
  process.env.PARTNER_JWT_SECRET = 'integration-partner-jwt-secret-32-bytes';
  process.env.PARTNER_RESPONSE_SEAL_KEY = 'integration-partner-seal-key-32-bytes!!';
  let admin: ReturnType<typeof postgres> | undefined;
  let createdDatabase: string | undefined;
  let options = target.isolated;
  if (!options) {
    admin = postgres({ ...target.admin!, max: 1, onnotice: () => undefined });
    const name = `partner_g4_${randomUUID().replaceAll('-', '')}`;
    await admin`CREATE DATABASE ${admin(name)}`;
    createdDatabase = name;
    options = { ...target.admin!, database: name };
  }
  db.sql = postgres({ ...options, max: 10, onnotice: () => undefined });
  // Nothing destructive runs until the pool is proven to be on the expected database.
  const [{ name: current }] = await db.sql<{ name: string }[]>`SELECT current_database() AS name`;
  expect(current).toBe(options.database);
  await db.sql.unsafe(FIXTURE);
  for (const file of MIGRATIONS) await db.sql.begin((tx) => tx.unsafe(readFileSync(file, 'utf8')));
  // This stream's migration is safe to re-run.
  await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATIONS[3], 'utf8')));
  await db.sql.unsafe(SEED_QUESTIONS);
  await db.sql`UPDATE partner_games SET ready = true WHERE game_id IN ('road-to-goal', 'trivia-mines')`;

  const partner = await import('../../../../src/modules/partners/partner-config.js');
  process.env.PARTNER_FREECROCO_CONFIG = JSON.stringify({
    slug: 'freecroco',
    environment: 'test',
    inboundKeySha256: [partner.sha256Hex(KEY)],
    allowedCidrs: ['127.0.0.1/32', '::1/128'],
    launchBaseUrl: 'https://staging-freecroco.quizball.io',
  });
  partner.resetPartnerConfigCache();
  const { partnerRoutes } = await import('../../../../src/http/routes/partner.routes.js');
  const app = express();
  app.use(express.json());
  app.use(partnerRoutes);

  let seq = 0;
  return {
    app,
    async teardown() {
      try {
        await db.sql?.end({ timeout: 2 });
      } finally {
        try {
          if (admin && createdDatabase) await admin.unsafe(`DROP DATABASE "${createdDatabase}" WITH (FORCE)`);
        } finally {
          await admin?.end({ timeout: 2 });
        }
      }
    },
    async launch(playerId = `g4-${Date.now().toString(36)}-${(seq += 1)}`) {
      const started = await request(app).post('/partner/v1/sessions/init').set('x-api-key', KEY)
        .send({ playerId, language: 'en', channel: 'WEB', requestId: `req-${randomUUID()}`, username: 'g4****' });
      expect(started.status).toBe(200);
      const redeemed = await request(app).post('/partner/v1/sessions/redeem').send({ token: started.body.oneTimeToken });
      expect(redeemed.status).toBe(200);
      return { access: redeemed.body.accessToken as string, playerId };
    },
    async setStatus(playerId, action) {
      const res = await request(app).post(`/partner/v1/players/${playerId}/${action}`).set('x-api-key', KEY)
        .send({ at: new Date().toISOString() });
      expect(res.status).toBe(200);
    },
    async setLimit(gameId, limit) {
      await db.sql`UPDATE partner_games SET default_limit = ${limit} WHERE environment = 'test' AND game_id = ${gameId}`;
    },
  };
}

/** The partner's score events for one external player, oldest first. */
export async function scoreEvents(db: DbHolder, playerId: string) {
  return db.sql<{ game_id: string; score: number; occurred_at: Date; play_id: string }[]>`
    SELECT game_id, score, occurred_at, play_id FROM partner_score_events WHERE player_id = ${playerId} ORDER BY id`;
}

/** Plays a player has started (any state) for one game. */
export async function playsOf(db: DbHolder, playerId: string, gameId: string) {
  const [row] = await db.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM partner_plays pl JOIN partner_players p ON p.id = pl.player_id
    WHERE p.external_player_id = ${playerId} AND pl.game_id = ${gameId}`;
  return row.n;
}

/** Quizball rewards a partner player must never get. */
export async function quizballRewards(db: DbHolder, playerId: string) {
  const [row] = await db.sql<{ coins: number; total_xp: number; tickets: number }[]>`
    SELECT u.coins, u.total_xp, u.tickets FROM partner_players p JOIN users u ON u.id = p.user_id
    WHERE p.external_player_id = ${playerId}`;
  return row;
}
