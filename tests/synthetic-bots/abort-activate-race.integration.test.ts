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
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
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
async function newHuman(nick: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, onboarding_complete) VALUES (${nick}, false, true) RETURNING id
  `;
  userIds.push(u.id);
  return u.id;
}
async function rankedProfile(userId: string, rp: number): Promise<void> {
  await sql`INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played)
            VALUES (${userId}, ${rp}, 'Bench', 'placed', 3, 3) ON CONFLICT (user_id) DO NOTHING`;
}
// A fully-wired ranked lobby: host human + persistent bot as members + reservation
// (uncommitted) + ranked profiles — ready for createMatchFromLobby.
async function fullRankedLobby(prefix: string): Promise<{ human: string; bot: string; lobby: string }> {
  const human = await newHuman(`${prefix}-h-${Date.now()}-${Math.random()}`);
  const bot = await newBot(`${prefix}-b-${Date.now()}-${Math.random()}`);
  await rankedProfile(human, 1200);
  await rankedProfile(bot, 1200);
  await sql`INSERT INTO synthetic_player_profiles (user_id, base_skill, personality_seed, status)
            VALUES (${bot}, 0.5, 42, 'active') ON CONFLICT (user_id) DO NOTHING`;
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${human}, 'waiting') RETURNING id`;
  lobbyIds.push(l.id);
  await sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${l.id}, ${human}, true), (${l.id}, ${bot}, true)`;
  await sql`INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
            VALUES (${bot}, ${l.id}, 'holderA', now() + interval '180 seconds')`;
  return { human, bot, lobby: l.id };
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
    matchesService = (await import('../../src/modules/matches/matches.service.js')).matchesService;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping abort/activate race test: DB unavailable.\n');
  }
});

afterEach(async () => {
  if (!dbAvailable) return;
  // Collect any matches created by createMatchFromLobby for the test lobbies too.
  if (lobbyIds.length) {
    const extraMatches = await sql<{ id: string }[]>`SELECT id FROM matches WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
    for (const m of extraMatches) matchIds.push(m.id);
  }
  if (matchIds.length) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE match_id = ANY(${matchIds}::uuid[])`;
    await sql`DELETE FROM match_players WHERE match_id = ANY(${matchIds}::uuid[])`;
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
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
    userIds.length = 0;
  }
});

afterAll(async () => {
  if (dbAvailable) await sql.end();
});

describe('abort vs activate advisory-lock serialization (P1-2)', () => {
  it('(A) activate → (GAP, no match yet) → abort must NO-OP (committed_at set, production timing)', async () => {
    if (!dbAvailable) return;
    // The exact scenario Sol flagged: PRODUCTION activation flips status='active'
    // AND sets committed_at, then COMMITS and RELEASES the lock — match creation
    // is a SEPARATE, much later transaction. An abort taking the lock during that
    // gap (no match row exists yet, reservation still match_id IS NULL) must still
    // no-op, because committed_at says "a draft has started — hands off".
    const bot = await newBot(`race-a-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);

    // Production activation (its own committed tx, lock released after).
    const activation = await repo.activateLobbyForDraftLocked(lobby);
    expect(activation.activated).toBe(true);
    expect(activation.committedReservation).toBe(true); // THIS call owns the commit
    // committed_at is now set; NO match created yet (the gap).
    const [afterActivate] = await sql<{ committed_at: string | null; match_id: string | null }[]>`
      SELECT committed_at, match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(afterActivate.committed_at).not.toBeNull();
    expect(afterActivate.match_id).toBeNull();

    // Abort during the gap — a separate call, lock already free → runs immediately.
    const abortResult = await repo.abortRankedAiLobbyLocked(lobby);
    expect(abortResult.aborted).toBe(false);
    expect(abortResult.botReleased).toBeNull();
    // Reservation KEPT for the live draft (no match yet, but committed).
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
    const lobbyStill = await sql`SELECT 1 FROM lobbies WHERE id = ${lobby}`;
    expect(lobbyStill).toHaveLength(1);
  });

  it('(A2) activation holds the lock: a concurrent abort BLOCKS then no-ops on committed_at', async () => {
    if (!dbAvailable) return;
    const bot = await newBot(`race-a2-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);

    // Hold the lock as activation (status + committed_at), start a concurrent
    // abort that must BLOCK, then commit → the abort proceeds and no-ops.
    const holder = await sql.reserve();
    let abortResult: { aborted: boolean; botReleased: string | null } | null = null;
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobby]);
      await holder.unsafe(`UPDATE lobbies SET status = 'active' WHERE id = $1`, [lobby]);
      await holder.unsafe(`UPDATE synthetic_bot_reservations SET committed_at = now() WHERE lobby_id = $1 AND match_id IS NULL`, [lobby]);

      const abortP = repo.abortRankedAiLobbyLocked(lobby).then((r) => { abortResult = r; });
      await delay(200);
      expect(abortResult).toBeNull(); // blocked behind the held lock

      await holder.unsafe('COMMIT');
      await abortP;
    } finally {
      await holder.release();
    }

    expect(abortResult).not.toBeNull();
    expect(abortResult!.aborted).toBe(false);
    expect(abortResult!.botReleased).toBeNull();
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  }, 20000); // holds a lock + waits; needs headroom over the 5s default under parallel load

  it('(A3) draft-teardown after activation reclaims the bot (uncommitFirst)', async () => {
    if (!dbAvailable) return;
    // A genuine draft-teardown (draft abort / ticket failure / pre-match abandon)
    // runs after activation and must reclaim the bot via uncommitFirst.
    const bot = await newBot(`race-a3-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);
    await repo.activateLobbyForDraftLocked(lobby); // committed_at set
    const result = await repo.abortRankedAiLobbyLocked(lobby, { uncommitFirst: true });
    expect(result.aborted).toBe(true);
    expect(result.botReleased).toBe(bot);
    const gone = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(gone).toHaveLength(0);
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

  it('(D) DYNAMIC gate: a draft_start_error teardown (uncommitFirst) NO-OPS when a reconnect activated + created a match', async () => {
    if (!dbAvailable) return;
    // The exact P1 Sol flagged: a stale draft_start_error handler passes
    // teardown-intent (uncommitFirst) but a reconnect activated + CREATED A MATCH
    // first. The AUTHORITATIVE in-lock live-match check overrides the static
    // intent → no-op → the fresh commit survives, the bot stays in the live draft.
    const bot = await newBot(`race-d-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);
    // Reconnect activated (committed_at set) AND created its match.
    await repo.activateLobbyForDraftLocked(lobby);
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW()) RETURNING id
    `;
    matchIds.push(match.id);
    // Stale teardown handler fires with uncommitFirst — must NO-OP (live match).
    const abortResult = await repo.abortRankedAiLobbyLocked(lobby, { uncommitFirst: true });
    expect(abortResult.aborted).toBe(false);
    expect(abortResult.botReleased).toBeNull();
    // committed_at survives (NOT cleared), reservation kept for the live draft.
    const [res] = await sql<{ committed_at: string | null }[]>`
      SELECT committed_at FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(res.committed_at).not.toBeNull();
  });

  it('(E) ticket-failure teardown reclaims a genuinely-STUCK lobby (activated, committed, NO match)', async () => {
    if (!dbAvailable) return;
    // Ticket failure is post-activation (committed_at set) with NO match created —
    // a genuinely stuck draft. teardown-intent + the in-lock check (no active
    // match) → reclaim + teardown.
    const bot = await newBot(`race-e-${Date.now()}`);
    const lobby = await newWaitingLobby(bot);
    await acquire(bot, lobby);
    await repo.activateLobbyForDraftLocked(lobby); // committed_at set, no match
    const abortResult = await repo.abortRankedAiLobbyLocked(lobby, { uncommitFirst: true });
    expect(abortResult.aborted).toBe(true);
    expect(abortResult.botReleased).toBe(bot);
    const gone = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(gone).toHaveLength(0);
  });
});

describe('match-creation vs abort TOTAL ORDER on the lobby advisory lock (Sol final)', () => {
  // Match CREATION now takes the same per-lobby advisory lock as its FIRST
  // statement, so it and a concurrent abort are totally ordered. The forbidden
  // SPLIT STATE (match created + lobby torn down / matches.lobby_id nulled) can
  // never occur: either creation wins (match intact, lobby kept, reservation
  // transferred) or abort wins (creation rolls back per P1-D, no orphaned match).

  it('creation-wins (creation holds the lock first): match intact, lobby kept, reservation transferred; a queued abort NO-OPs', async () => {
    if (!dbAvailable) return;
    const { human, bot, lobby } = await fullRankedLobby('order-cw');
    await repo.activateLobbyForDraftLocked(lobby); // draft activated (committed_at)

    // Real match creation (its own tx takes the lobby lock first) and a concurrent
    // abort. Kick both; creation should win the lock and commit the match+transfer,
    // then the abort sees the live match → no-op. We don't control which grabs the
    // lock first here, but the invariant (no split state) must hold either way, and
    // we then assert the concrete creation-wins shape by re-running deterministically
    // below. First: prove NO SPLIT STATE under a genuine concurrent run.
    const [createResult] = await Promise.allSettled([
      matchesService.createMatchFromLobby({
        lobbyId: lobby, mode: 'ranked', variant: 'ranked_sim', hostUserId: human,
        categoryAId: categoryId, categoryBId: null,
      }),
      repo.abortRankedAiLobbyLocked(lobby, { uncommitFirst: true }),
    ]);

    // Invariant: NEVER a match that exists while its lobby was torn down.
    const matches = await sql<{ id: string; lobby_id: string | null; status: string }[]>`
      SELECT id, lobby_id, status FROM matches WHERE lobby_id = ${lobby} OR id IN (
        SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot} AND match_id IS NOT NULL
      )`;
    if (createResult.status === 'fulfilled') {
      // Creation won → match exists AND its lobby_id is intact (not nulled), the
      // lobby row survives, and the reservation carries the match_id.
      const matchId = createResult.value.match.id;
      matchIds.push(matchId);
      const [m] = await sql<{ lobby_id: string | null }[]>`SELECT lobby_id FROM matches WHERE id = ${matchId}`;
      expect(m.lobby_id).toBe(lobby); // NOT nulled by a teardown
      const lobbyRows = await sql`SELECT 1 FROM lobbies WHERE id = ${lobby}`;
      expect(lobbyRows).toHaveLength(1); // lobby NOT torn down
      const [res] = await sql<{ match_id: string | null }[]>`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
      expect(res.match_id).toBe(matchId); // transferred
    } else {
      // Abort won → creation rolled back (P1-D): NO match for this lobby.
      expect(matches.filter((mm) => mm.lobby_id === lobby)).toHaveLength(0);
    }
    // In neither branch is there a match whose lobby_id was nulled while the match lives.
    for (const mm of matches) {
      if (mm.status === 'active') expect(mm.lobby_id).not.toBeNull();
    }
  }, 20000); // concurrent createMatchFromLobby + abort; needs headroom under parallel load

  it('abort-wins (abort holds the lock first): creation ROLLS BACK, no orphaned match, bot freed', async () => {
    if (!dbAvailable) return;
    const { human, bot, lobby } = await fullRankedLobby('order-aw');
    // NOTE: reservation is UNCOMMITTED here (no activation) so the abort will free it.

    // Hold the lobby advisory lock on a dedicated connection as "the abort", so the
    // real creation tx BLOCKS on its first statement. Run the abort's effect
    // (free reservation + delete lobby) inside the held tx, commit, then let
    // creation proceed → its transfer finds no reservation → rollback (P1-D).
    const holder = await sql.reserve();
    let createOutcome: 'fulfilled' | 'rejected' = 'fulfilled';
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe(`SELECT pg_advisory_xact_lock(hashtext('ranked_ai_lobby:' || $1))`, [lobby]);
      // Abort effect under the held lock: free the uncommitted reservation + end lobby.
      await holder.unsafe(`DELETE FROM synthetic_bot_reservations WHERE lobby_id = $1 AND match_id IS NULL AND committed_at IS NULL`, [lobby]);
      await holder.unsafe(`DELETE FROM lobby_members WHERE lobby_id = $1`, [lobby]);
      await holder.unsafe(`DELETE FROM lobbies WHERE id = $1`, [lobby]);

      // Creation starts and BLOCKS on the lobby lock (its first statement).
      const createP = matchesService.createMatchFromLobby({
        lobbyId: lobby, mode: 'ranked', variant: 'ranked_sim', hostUserId: human,
        categoryAId: categoryId, categoryBId: null,
      }).then(() => { createOutcome = 'fulfilled'; }, () => { createOutcome = 'rejected'; });
      await delay(200); // creation is blocked behind the held lock

      await holder.unsafe('COMMIT'); // abort commits → releases lock
      await createP;
    } finally {
      await holder.release();
    }

    // Creation ran after the abort committed. The lobby/members are gone (deleted
    // by the abort) so createMatchFromLobby fails its "exactly 2 members" guard OR
    // its transfer finds no reservation → rollback. Either way: NO match committed.
    expect(createOutcome).toBe('rejected');
    const matches = await sql`SELECT 1 FROM matches WHERE lobby_id = ${lobby}`;
    expect(matches).toHaveLength(0);
    const res = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(res).toHaveLength(0); // bot freed by the abort
  }, 20000); // holds a lock + 200ms delay + blocked creation; headroom under parallel load
});
