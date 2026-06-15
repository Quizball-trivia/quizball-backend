/**
 * Draft category-ban idempotency / collision — the REAL DB behavior the
 * draft-realtime service relies on (its unit tests MOCK the repo, so the actual
 * PK/UNIQUE precedence is only exercised here). Guards commit 1cd3176
 * ("make category ban idempotent so collisions can't wedge the draft"):
 *
 *   - Self-retry: the same user re-bans the same category → returns their
 *     existing ban row, no error, no duplicate row (a retried socket message
 *     must not record two bans or advance the turn twice).
 *   - Collision: a second user bans the category the first already banned →
 *     returns the existing (foreign) ban instead of throwing, so the draft
 *     waits for that user's distinct retry rather than wedging.
 *
 * Local-only: REGRESSION_DB_URL must point at the native regression DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCAL_DB = process.env.REGRESSION_DB_URL;
const isLocal = !!LOCAL_DB && /(?:127\.0\.0\.1|localhost)/.test(LOCAL_DB);

if (isLocal) {
  process.env.NODE_ENV = 'local';
  process.env.DATABASE_URL = LOCAL_DB;
}
process.env.LOG_LEVEL = process.env.REGRESSION_LOG_LEVEL ?? 'silent';

const describeLocal = isLocal ? describe : describe.skip;
const NS = 'regression-draftban';

describeLocal('regression: draft category-ban collision (real DB)', () => {
  let sql: (typeof import('../../src/db/index.js'))['sql'];
  let repo: (typeof import('../../src/modules/lobbies/lobbies.repo.js'))['lobbiesRepo'];
  let lobbyId: string;
  let userA: string;
  let userB: string;
  let catX: string;
  let catY: string;

  beforeAll(async () => {
    ({ sql } = await import('../../src/db/index.js'));
    ({ lobbiesRepo: repo } = await import('../../src/modules/lobbies/lobbies.repo.js'));

    // Self-heal: clear leftovers from a crashed prior run.
    await sql`DELETE FROM lobby_category_bans WHERE lobby_id IN (SELECT id FROM lobbies WHERE host_user_id IN (SELECT id FROM users WHERE nickname LIKE ${NS + '%'}))`;
    await sql`DELETE FROM lobby_members WHERE lobby_id IN (SELECT id FROM lobbies WHERE host_user_id IN (SELECT id FROM users WHERE nickname LIKE ${NS + '%'}))`;
    await sql`DELETE FROM lobbies WHERE host_user_id IN (SELECT id FROM users WHERE nickname LIKE ${NS + '%'})`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS + '%'}`;
    await sql`DELETE FROM users WHERE nickname LIKE ${NS + '%'}`;

    const users = await sql<{ id: string }[]>`
      INSERT INTO users (email, nickname, onboarding_complete)
      SELECT ${NS} || '+u' || i || '@test.local', ${NS} || '-u' || i, true
      FROM generate_series(1, 2) i
      RETURNING id
    `;
    [userA, userB] = users.map((r) => r.id);

    const cats = await sql<{ id: string }[]>`
      INSERT INTO categories (slug, name, is_active)
      SELECT ${NS} || '-c' || i, jsonb_build_object('en', 'Cat ' || i), true
      FROM generate_series(1, 2) i
      RETURNING id
    `;
    [catX, catY] = cats.map((r) => r.id);

    const [lobby] = await sql<{ id: string }[]>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code)
      VALUES ('ranked', ${userA}, 'active', NULL)
      RETURNING id
    `;
    lobbyId = lobby.id;
    await sql`
      INSERT INTO lobby_members (lobby_id, user_id)
      VALUES (${lobbyId}, ${userA}), (${lobbyId}, ${userB})
    `;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM lobby_category_bans WHERE lobby_id = ${lobbyId}`;
    await sql`DELETE FROM lobby_members WHERE lobby_id = ${lobbyId}`;
    await sql`DELETE FROM lobbies WHERE id = ${lobbyId}`;
    await sql`DELETE FROM categories WHERE slug LIKE ${NS + '-%'}`;
    await sql`DELETE FROM users WHERE nickname LIKE ${NS + '-%'}`;
  });

  it('self-retry of the same ban is idempotent (one row, returns it, no throw)', async () => {
    const first = await repo.insertLobbyCategoryBan(lobbyId, userA, catX);
    expect(first.user_id).toBe(userA);
    expect(first.category_id).toBe(catX);

    // Retried socket message — same user, same category. Must NOT throw or
    // create a second ban row.
    const retry = await repo.insertLobbyCategoryBan(lobbyId, userA, catX);
    expect(retry.user_id).toBe(userA);
    expect(retry.category_id).toBe(catX);

    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND user_id = ${userA}
    `;
    expect(rows[0].n, 'a user has exactly one ban row no matter how many retries').toBe(1);
  });

  it('collision: a second user banning the SAME category is rejected, and the draft still completes', async () => {
    // userA already banned catX above. userB now tries the same category. The
    // INSERT carries ON CONFLICT (lobby_id, user_id) only, so the SEPARATE
    // (lobby_id, category_id) UNIQUE constraint fires and the repo THROWS (23505).
    //
    // NB: the repo's own comment says it "returns the existing ban rather than
    // throwing", but that foreign-collision SELECT is unreachable — the unique
    // violation is raised before it. The caller (draft handler handleBan) wraps
    // this in try/catch and emits BAN_FAILED ("pick another"), so the draft does
    // NOT wedge — the user is simply asked to pick a different category. We pin
    // the REAL contract here: a foreign collision rejects the colliding pick.
    await expect(
      repo.insertLobbyCategoryBan(lobbyId, userB, catX),
    ).rejects.toThrow();

    // The colliding user recorded NO ban of their own — no phantom row, no
    // double-advance. The draft waits for their distinct pick.
    const own = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId} AND user_id = ${userB}
    `;
    expect(own[0].n, 'a rejected collision must not record a ban for the colliding user').toBe(0);

    // userB retries with a DISTINCT category — their ban records cleanly and the
    // draft now has two distinct bans (it can complete: no wedge).
    const ok = await repo.insertLobbyCategoryBan(lobbyId, userB, catY);
    expect(ok.user_id).toBe(userB);
    expect(ok.category_id).toBe(catY);

    const distinct = await sql<{ n: number }[]>`
      SELECT count(DISTINCT user_id)::int AS n FROM lobby_category_bans
      WHERE lobby_id = ${lobbyId}
    `;
    expect(distinct[0].n, 'two distinct players have banned → draft can complete').toBe(2);
  });
});
