import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { gameFeedbackSchema } from '../../src/modules/game-feedback/game-feedback.schemas.js';

/**
 * Opt-in, real PostgreSQL: the game_feedback migration and the repo's upserts. Needs an isolated local database:
 *   GAME_FEEDBACK_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_feedback_test_1
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.GAME_FEEDBACK_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:543(?:2|6)\/quizball_feedback_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local feedback test database required');

const MIGRATION = join(__dirname, '../../supabase/migrations/20261018130000_game_feedback.sql');
const FIXTURE = `
  DROP TABLE IF EXISTS game_feedback, guest_sessions, users CASCADE;
  CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nickname text);
  CREATE TABLE guest_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE);
  DO $$ DECLARE r text; BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    END LOOP;
  END $$;
`;

const body = (o: Record<string, unknown> = {}) => gameFeedbackSchema.parse({ mode: 'solo', rating: 4, wantsOnline: true, locale: 'en', ...o });

describe('game feedback body', () => {
  it('drops an empty comment, refuses unknown fields and out-of-range ratings', () => {
    expect(body({ comment: '   ' }).comment).toBeUndefined();
    expect(body({ comment: ' more lists ' }).comment).toBe('more lists');
    expect(gameFeedbackSchema.safeParse({ mode: 'solo', rating: 6, wantsOnline: null, locale: 'en' }).success).toBe(false);
    expect(gameFeedbackSchema.safeParse({ mode: 'solo', rating: 3, wantsOnline: null, locale: 'en', userId: randomUUID() }).success).toBe(false);
    expect(gameFeedbackSchema.safeParse({ mode: 'duel', rating: 3, wantsOnline: null, locale: 'en' }).success).toBe(false);
  });
});

describe.skipIf(!url)('game feedback on real Postgres', () => {
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await db.sql.unsafe(FIXTURE);
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATION, 'utf8')));
    // Safe to re-run.
    await db.sql.begin((tx) => tx.unsafe(readFileSync(MIGRATION, 'utf8')));
  });
  afterAll(async () => { await db.sql?.end(); });

  it('keeps one answer per member and per guest session, replacing it on a second send', async () => {
    const { gameFeedbackRepo } = await import('../../src/modules/game-feedback/game-feedback.repo.js');
    const [{ id: userId }] = await db.sql`INSERT INTO users (nickname) VALUES ('a') RETURNING id`;
    const [{ id: guestId }] = await db.sql`INSERT INTO guest_sessions (token_hash) VALUES (${randomUUID()}) RETURNING id`;
    await gameFeedbackRepo.save('tenable', { kind: 'member', userId }, body({ comment: 'fun' }));
    await gameFeedbackRepo.save('tenable', { kind: 'member', userId }, body({ mode: 'room', rating: 2, wantsOnline: false }));
    await gameFeedbackRepo.save('tenable', { kind: 'guest', guestId }, body({ wantsOnline: null, locale: 'ka' }));
    const rows = await db.sql`SELECT user_id, guest_id, mode, rating, wants_online, comment, locale FROM game_feedback ORDER BY locale`;
    expect(rows).toEqual([
      { user_id: userId, guest_id: null, mode: 'room', rating: 2, wants_online: false, comment: null, locale: 'en' },
      { user_id: null, guest_id: guestId, mode: 'solo', rating: 4, wants_online: null, comment: null, locale: 'ka' },
    ]);
  });

  it('is server-only and checks its values', async () => {
    const [rls] = await db.sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'game_feedback'`;
    expect(rls.relrowsecurity).toBe(true);
    const [grants] = await db.sql`SELECT has_table_privilege('anon', 'public.game_feedback', 'SELECT') AS a, has_table_privilege('authenticated', 'public.game_feedback', 'INSERT') AS b`;
    expect(grants).toEqual({ a: false, b: false });
    const [{ id: userId }] = await db.sql`INSERT INTO users (nickname) VALUES ('b') RETURNING id`;
    await expect(db.sql`INSERT INTO game_feedback (game, mode, user_id, rating, locale) VALUES ('tenable', 'solo', ${userId}, 0, 'en')`)
      .rejects.toMatchObject({ constraint_name: 'chk_game_feedback_rating' });
    await expect(db.sql`INSERT INTO game_feedback (game, mode, rating, locale) VALUES ('tenable', 'solo', 3, 'en')`)
      .rejects.toMatchObject({ constraint_name: 'chk_game_feedback_owner' });
    await expect(db.sql`INSERT INTO game_feedback (game, mode, user_id, rating, locale, comment) VALUES ('tenable', 'solo', ${userId}, 3, 'en', ${'x'.repeat(501)})`)
      .rejects.toMatchObject({ constraint_name: 'chk_game_feedback_comment' });
  });
});
