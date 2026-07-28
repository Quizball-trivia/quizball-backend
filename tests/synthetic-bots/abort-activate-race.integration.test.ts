/**
 * P1-2: the abort-vs-activate TOCTOU is closed by a SHARED per-lobby advisory
 * xact lock that both the draft activation (activateLobbyForDraftLocked) and
 * every reservation abort (abortRankedAiLobbyLocked) take. This test proves the
 * serialization with TWO real DB connections:
 *
 *   (A) activation-first: hold the lock as "activation", flip status→active,
 *       commit; a concurrent abort BLOCKS on the lock, then on acquiring it
 *       re-reads 'active' → no-ops (reservation kept).
 *   (B) abort-first: the abort takes the lock first (lobby waiting), frees the
 *       reservation, commits; activation then proceeds — but the reservation is
 *       already gone (a real match-creation transfer would find nothing and roll
 *       back). Abort correctly freed the bot; no double-book.
 *   (C) already-transferred: abort no-ops on a reservation that carries match_id.
 *
 * Own dedicated postgres client; self-skips when DB unavailable. Local DB only.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';
import '../setup.js';

// MUST match the DB the app repo singleton uses (DATABASE_URL from tests/setup.ts
// → test:test@localhost:5432/test), because this test seeds rows with its own
// client but calls the app repo (a separate pool) — both must hit the SAME DB.
const DB_URL = process.env.PERSISTENT_BOT_TEST_DB_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://test:test@localhost:5432/test';

let sql: postgres.Sql;
let repo: typeof import('../../src/modules/synthetic-bots/synthetic-bots.repo.js').syntheticBotsRepo;
let dbAvailable = false;
const userIds: string[] = [];
const lobbyIds: string[] = [];
const matchIds: string[] = [];
let categoryId: string;

async function newBot(nick: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${nick}, true, 'persistent', true) RETURNING id
  `;
  userIds.push(u.id);
  return u.id;
}
async function newWaitingLobby(host: string): Promise<string> {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${host}, 'waiting') RETURNING id
  `;
  lobbyIds.push(l.id);
  return l.id;
}
async function acquire(bot: string, lobby: string): Promise<void> {
  await sql`INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
            VALUES (${bot}, ${lobby}, 'holderA', now() + interval '180 seconds')`;
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(async () => {
  try {
    sql = postgres(DB_URL, { max: 6, idle_timeout: 5, connect_timeout: 5 });
    await sql`SELECT 1`;
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    categoryId = cat!.id;
    // Point the app repo (which uses its own singleton) at the same DB so the SQL
    // is identical. The repo's sql singleton reads DATABASE_URL (localhost in
    // tests/setup.ts) — here we just call the repo methods; they operate on the
    // rows we seed via our own client against the SAME database.
    repo = (await import('../../src/modules/synthetic-bots/synthetic-bots.repo.js')).syntheticBotsRepo;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping abort/activate race test: DB unavailable.\n');
  }
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (matchIds.length) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE match_id = ANY(${matchIds}::uuid[])`;
    await sql`DELETE FROM matches WHERE id = ANY(${matchIds}::uuid[])`;
    matchIds.length = 0;
  }
  if (lobbyIds.length) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
    await sql`DELETE FROM lobby_members WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
    await sql`DELETE FROM lobbies WHERE id = ANY(${lobbyIds}::uuid[])`;
    lobbyIds.length = 0;
  }
  if (userIds.length) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE bot_user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM lobby_members WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
    userIds.length = 0;
  }
});

afterAll(async () => {
  if (dbAvailable) await sql.end();
});

describe('abort vs activate advisory-lock serialization (P1-2)', () => {
  it('(A) activation-first: a concurrent abort BLOCKS then no-ops (sees active, reservation kept)', async () => {
    if (!dbAvailable) return;
    const bot = await newBot(`race-a-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);

    // Reserve a dedicated connection to HOLD the advisory lock as "activation".
    // Production activation flips status='active' then creates the match +
    // transfers the reservation; we do the equivalent inside the held tx so that,
    // on commit, the lobby is active WITH a live match (the protected state).
    const holder = await sql.reserve();
    let abortResult: { aborted: boolean; botReleased: string | null } | null = null;
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobby]);
      await holder.unsafe(`UPDATE lobbies SET status = 'active' WHERE id = $1`, [lobby]);
      const [m] = await holder.unsafe<{ id: string }[]>(
        `INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
         VALUES (gen_random_uuid(), $1, 'ranked', 'active', $2, 10, 0, NOW()) RETURNING id`,
        [lobby, categoryId],
      );
      matchIds.push(m.id);
      await holder.unsafe(`UPDATE synthetic_bot_reservations SET match_id = $1 WHERE lobby_id = $2 AND match_id IS NULL`, [m.id, lobby]);

      // Start the abort on the app repo (separate pool) — it must BLOCK on the lock.
      const abortP = repo.abortRankedAiLobbyLocked(lobby).then((r) => { abortResult = r; });
      await delay(200);
      expect(abortResult).toBeNull(); // still blocked behind the held lock

      // Commit activation → releases the lock; the abort now proceeds.
      await holder.unsafe('COMMIT');
      await abortP;
    } finally {
      await holder.release();
    }

    // The abort acquired the lock AFTER activation committed → saw active + live
    // match (and the reservation carries match_id) → no-op.
    expect(abortResult).not.toBeNull();
    expect(abortResult!.aborted).toBe(false);
    expect(abortResult!.botReleased).toBeNull();
    const still = await sql`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1); // reservation KEPT + transferred (live match owns it)
  });

  it('(B) abort-first: the abort frees the bot; a subsequent activation finds no reservation', async () => {
    if (!dbAvailable) return;
    const bot = await newBot(`race-b-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);

    // Abort runs while the lobby is 'waiting' → frees the reservation.
    const abortResult = await repo.abortRankedAiLobbyLocked(lobby);
    expect(abortResult.aborted).toBe(true);
    expect(abortResult.botReleased).toBe(bot);

    // Activation now proceeds (lobby was deleted when it emptied) — the reservation
    // is already gone, so a real transfer would find nothing (match creation would
    // roll back). Here we just assert the reservation is not present.
    const gone = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(gone).toHaveLength(0);
  });

  it('(C) abort no-ops on an already-transferred reservation (match_id set)', async () => {
    if (!dbAvailable) return;
    const bot = await newBot(`race-c-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW()) RETURNING id
    `;
    matchIds.push(match.id);
    await sql`UPDATE synthetic_bot_reservations SET match_id = ${match.id} WHERE bot_user_id = ${bot}`;
    // Lobby is still 'waiting' in this contrived setup, but the reservation is
    // transferred (match_id set) → the abort must NOT free it.
    const abortResult = await repo.abortRankedAiLobbyLocked(lobby);
    expect(abortResult.botReleased).toBeNull();
    const still = await sql`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });
});
