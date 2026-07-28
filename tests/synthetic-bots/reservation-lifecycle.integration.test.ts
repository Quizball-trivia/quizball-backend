/**
 * Integration tests for the persistent-bot reservation lifecycle (PR7) against a
 * real Postgres. Uses its OWN dedicated postgres client (not the app singleton)
 * so it is fully self-contained and self-skips when no DB is reachable.
 *
 * Default target is the local Supabase DB (docker: port 54322). Override with
 * PERSISTENT_BOT_TEST_DB_URL.
 *
 * Proven end-to-end:
 *   - acquire is ON CONFLICT DO NOTHING: two concurrent acquires → exactly one winner
 *   - transfer sets match_id atomically; owner-qualified + terminal releases
 *   - Georgia-day (07:00 reset) matches_today bump + last_selected_at
 *   - listEligibleBots HARD filters (active, unreserved, persistent)
 *   - sweeper re-key (crash between creation and transfer) vs release (stranded)
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import postgres from 'postgres';

const DB_URL = process.env.PERSISTENT_BOT_TEST_DB_URL
  ?? 'postgresql://postgres:postgres@localhost:54322/postgres';

let sql: postgres.Sql;
let dbAvailable = false;
let categoryId: string;
const createdUserIds: string[] = [];
const createdLobbyIds: string[] = [];
const createdMatchIds: string[] = [];

// Minimal inline repo mirrors (the app repo drives the app `sql` singleton; here
// we exercise the exact same SQL against our own client to keep the test hermetic).
async function acquire(botUserId: string, lobbyId: string, holder: string, ttlSec: number) {
  const [row] = await sql`
    INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
    VALUES (${botUserId}, ${lobbyId}, ${holder}, ${new Date(Date.now() + ttlSec * 1000)})
    ON CONFLICT (bot_user_id) DO NOTHING
    RETURNING *
  `;
  return row ?? null;
}

async function newUser(opts: { persistent?: boolean; nickname: string }): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${opts.nickname}, ${opts.persistent ?? false}, ${opts.persistent ? 'persistent' : null}, true)
    RETURNING id
  `;
  createdUserIds.push(u.id);
  return u.id;
}

async function newLobby(hostId: string): Promise<string> {
  const [l] = await sql<{ id: string }[]>`
    INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${hostId}, 'waiting') RETURNING id
  `;
  createdLobbyIds.push(l.id);
  return l.id;
}

async function newProfile(userId: string, rp: number, opts: { dailyCap?: number; matchesToday?: number; matchesDay?: string | null; status?: string } = {}) {
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played)
    VALUES (${userId}, ${rp}, 'Bench', 'placed', 3, 3)
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp
  `;
  await sql`
    INSERT INTO synthetic_player_profiles (user_id, base_skill, personality_seed, status, daily_cap, matches_today, matches_day)
    VALUES (${userId}, 0.5, 12345, ${opts.status ?? 'active'}, ${opts.dailyCap ?? 6}, ${opts.matchesToday ?? 0}, ${opts.matchesDay ?? null})
    ON CONFLICT (user_id) DO UPDATE SET matches_today = EXCLUDED.matches_today, matches_day = EXCLUDED.matches_day, status = EXCLUDED.status
  `;
}

beforeAll(async () => {
  try {
    sql = postgres(DB_URL, { max: 4, idle_timeout: 5, connect_timeout: 5 });
    await sql`SELECT 1`;
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    if (!cat) throw new Error('no category to satisfy matches FK');
    categoryId = cat.id;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping reservation-lifecycle integration tests: DB unavailable (start docker, or set PERSISTENT_BOT_TEST_DB_URL).\n');
  }
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (createdUserIds.length > 0) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE bot_user_id = ANY(${createdUserIds}::uuid[])`;
  }
  if (createdMatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${createdMatchIds}::uuid[])`;
    await sql`DELETE FROM match_players WHERE match_id = ANY(${createdMatchIds}::uuid[])`;
    await sql`DELETE FROM matches WHERE id = ANY(${createdMatchIds}::uuid[])`;
    createdMatchIds.length = 0;
  }
  if (createdLobbyIds.length > 0) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE lobby_id = ANY(${createdLobbyIds}::uuid[])`;
    await sql`DELETE FROM lobbies WHERE id = ANY(${createdLobbyIds}::uuid[])`;
    createdLobbyIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${createdUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${createdUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${createdUserIds}::uuid[])`;
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  if (dbAvailable) await sql.end();
});

describe('reservation acquire (ON CONFLICT DO NOTHING)', () => {
  it('lets exactly one of two concurrent acquires win', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `bot-${Date.now()}` });
    const l1 = await newLobby(bot);
    const l2 = await newLobby(bot);
    const [a, b] = await Promise.all([
      acquire(bot, l1, 'holderA', 180),
      acquire(bot, l2, 'holderB', 180),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    const rows = await sql`SELECT bot_user_id, fence FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(rows).toHaveLength(1);
  });

  it('owner-qualified release: stale holder/fence cannot release a re-acquired reservation', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `bot-${Date.now()}-2` });
    const l1 = await newLobby(bot);
    const first = await acquire(bot, l1, 'holderA', 180);
    expect(first).toBeTruthy();
    const staleFence = Number(first!.fence);
    // release with the correct holder+fence works
    const delWrong = await sql`DELETE FROM synthetic_bot_reservations WHERE bot_user_id = ${bot} AND holder = 'someoneElse' AND fence = ${staleFence} RETURNING bot_user_id`;
    expect(delWrong).toHaveLength(0);
    const delRight = await sql`DELETE FROM synthetic_bot_reservations WHERE bot_user_id = ${bot} AND holder = 'holderA' AND fence = ${staleFence} RETURNING bot_user_id`;
    expect(delRight).toHaveLength(1);
    // re-acquire → new fence
    const l2 = await newLobby(bot);
    const second = await acquire(bot, l2, 'holderA', 180);
    expect(second).toBeTruthy();
    expect(Number(second!.fence)).toBeGreaterThan(staleFence);
    // stale-fence release is a no-op against the new reservation
    const delStale = await sql`DELETE FROM synthetic_bot_reservations WHERE bot_user_id = ${bot} AND holder = 'holderA' AND fence = ${staleFence} RETURNING bot_user_id`;
    expect(delStale).toHaveLength(0);
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });
});

describe('transfer + Georgia-day bump', () => {
  it('transfers lobby→match atomically and bumps matches_today with 07:00 reset', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `bot-${Date.now()}-3` });
    await newProfile(bot, 1200, { matchesDay: '2000-01-01', matchesToday: 4 });
    const lobby = await newLobby(bot);
    await acquire(bot, lobby, 'holderA', 180);

    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW())
      RETURNING id
    `;
    createdMatchIds.push(match.id);
    const transferred = await sql`
      UPDATE synthetic_bot_reservations SET match_id = ${match.id}
      WHERE bot_user_id = ${bot} AND lobby_id = ${lobby} AND match_id IS NULL
      RETURNING match_id
    `;
    expect(transferred).toHaveLength(1);

    // bump: stored matches_day is an OLD day → counter resets to 1
    const [bumped] = await sql<{ matches_today: number; matches_day: string }[]>`
      UPDATE synthetic_player_profiles
        SET matches_today = CASE
              WHEN matches_day IS DISTINCT FROM ((now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date)
              THEN 1 ELSE matches_today + 1 END,
            matches_day = (now() AT TIME ZONE 'Asia/Tbilisi' - interval '7 hours')::date,
            last_selected_at = now()
      WHERE user_id = ${bot}
      RETURNING matches_today, matches_day
    `;
    expect(bumped.matches_today).toBe(1);
  });
});

describe('match_id-qualified releases (P1-B): a transferred reservation survives a lobby-phase release', () => {
  it('owner release and by-lobby release both no-op once match_id is set', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `xfer-${Date.now()}` });
    const lobby = await newLobby(bot);
    const res = await acquire(bot, lobby, 'holderA', 180);
    const fence = Number(res!.fence);
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW())
      RETURNING id
    `;
    createdMatchIds.push(match.id);
    // Transfer onto the match.
    await sql`UPDATE synthetic_bot_reservations SET match_id = ${match.id} WHERE bot_user_id = ${bot} AND lobby_id = ${lobby} AND match_id IS NULL`;

    // A concurrent lobby-phase OWNER release (holder+fence) must NOT delete it.
    const ownerDel = await sql`
      DELETE FROM synthetic_bot_reservations
      WHERE bot_user_id = ${bot} AND holder = 'holderA' AND fence = ${fence} AND match_id IS NULL
      RETURNING bot_user_id
    `;
    expect(ownerDel).toHaveLength(0);
    // A lobby-keyed release must NOT delete it either.
    const lobbyDel = await sql`
      DELETE FROM synthetic_bot_reservations WHERE lobby_id = ${lobby} AND match_id IS NULL RETURNING bot_user_id
    `;
    expect(lobbyDel).toHaveLength(0);
    // Still present, now match-keyed — only a by-match terminal release frees it.
    const still = await sql`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
    const byMatch = await sql`DELETE FROM synthetic_bot_reservations WHERE match_id = ${match.id} RETURNING bot_user_id`;
    expect(byMatch).toHaveLength(1);
  });
});

describe('settlement-gated release (P1-1/P1-3): releaseReservationByMatchIfSettled', () => {
  // Drives the REAL repo method: an atomic DELETE that frees the reservation only
  // when THIS BOT's settlement is provably done. Uses the app repo's own SQL.
  let repo: typeof import('../../src/modules/synthetic-bots/synthetic-bots.repo.js').syntheticBotsRepo;

  beforeAll(async () => {
    if (!dbAvailable) return;
    repo = (await import('../../src/modules/synthetic-bots/synthetic-bots.repo.js')).syntheticBotsRepo;
  });

  async function seedTransferredReservation(nick: string, matchStatus: 'completed' | 'abandoned', noContest = false) {
    const bot = await newUser({ persistent: true, nickname: `${nick}-bot-${Date.now()}` });
    await newProfile(bot, 1200);
    const lobby = await newLobby(bot);
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at, state_payload)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', ${matchStatus}, ${categoryId}, 10, 0, NOW(), ${sql.json(noContest ? { cancelledNoContest: true } : {})})
      RETURNING id
    `;
    createdMatchIds.push(match.id);
    await sql`INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, match_id, holder, expires_at) VALUES (${bot}, ${lobby}, ${match.id}, 'holderA', now() + interval '180 seconds')`;
    return { bot, lobby, matchId: match.id };
  }

  it('does NOT release a completed match with NO ranked ledger row (settlement in flight)', async () => {
    if (!dbAvailable) return;
    const { bot, matchId } = await seedTransferredReservation('inflight', 'completed');
    const released = await repo.releaseReservationByMatchIfSettled(matchId);
    expect(released).toBeNull();
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });

  it('PARTIAL LEDGER: a human row exists but the BOT row does NOT → still NOT safe to release', async () => {
    if (!dbAvailable) return;
    const { bot, matchId } = await seedTransferredReservation('partial', 'completed');
    const human = await newUser({ nickname: `partial-h-${Date.now()}` });
    // Only the HUMAN's ledger row lands first (PR2 partial-ledger recovery).
    await sql`
      INSERT INTO ranked_rp_changes (match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp, new_rp, result, is_placement, calculation_method, coins_awarded)
      VALUES (${matchId}, ${human}, ${bot}, true, 1500, -25, 1475, 'loss', false, 'ranked_formula', 100)
    `;
    // A match-wide EXISTS would false-positive here; the bot-specific check must not.
    const released = await repo.releaseReservationByMatchIfSettled(matchId);
    expect(released).toBeNull();
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });

  it('releases once the BOT’s own ledger row lands', async () => {
    if (!dbAvailable) return;
    const { bot, matchId } = await seedTransferredReservation('committed', 'completed');
    const human = await newUser({ nickname: `committed-h-${Date.now()}` });
    await sql`
      INSERT INTO ranked_rp_changes (match_id, user_id, opponent_user_id, opponent_is_ai, old_rp, delta_rp, new_rp, result, is_placement, calculation_method, coins_awarded)
      VALUES (${matchId}, ${human}, ${bot}, true, 1500, -25, 1475, 'loss', false, 'ranked_formula', 100),
             (${matchId}, ${bot}, ${human}, false, 1200, 50, 1250, 'win', false, 'ranked_formula', 0)
    `;
    const released = await repo.releaseReservationByMatchIfSettled(matchId);
    expect(released).toBe(bot);
    const gone = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(gone).toHaveLength(0);
  });

  it('releases a no-contest abandon (no RP settles)', async () => {
    if (!dbAvailable) return;
    const { bot, matchId } = await seedTransferredReservation('nc', 'abandoned', true);
    const released = await repo.releaseReservationByMatchIfSettled(matchId);
    expect(released).toBe(bot);
  });
});

describe('listEligibleBots HARD filters', () => {
  it('excludes retired, reserved, and non-persistent users', async () => {
    if (!dbAvailable) return;
    const active = await newUser({ persistent: true, nickname: `elig-active-${Date.now()}` });
    const retired = await newUser({ persistent: true, nickname: `elig-retired-${Date.now()}` });
    const reserved = await newUser({ persistent: true, nickname: `elig-reserved-${Date.now()}` });
    await newProfile(active, 1000);
    await newProfile(retired, 1000, { status: 'retired' });
    await newProfile(reserved, 1000);
    const rl = await newLobby(reserved);
    await acquire(reserved, rl, 'holderX', 180);

    const eligible = await sql<{ user_id: string }[]>`
      SELECT p.user_id FROM synthetic_player_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'active' AND u.ai_kind = 'persistent'
        AND NOT EXISTS (SELECT 1 FROM synthetic_bot_reservations r WHERE r.bot_user_id = p.user_id)
    `;
    const ids = eligible.map((r) => r.user_id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(retired);
    expect(ids).not.toContain(reserved);
  });
});

describe('abort-path release (P1-2 TOCTOU): releaseReservationByLobbyIfAbortable', () => {
  let repo: typeof import('../../src/modules/synthetic-bots/synthetic-bots.repo.js').syntheticBotsRepo;
  beforeAll(async () => {
    if (!dbAvailable) return;
    repo = (await import('../../src/modules/synthetic-bots/synthetic-bots.repo.js')).syntheticBotsRepo;
  });

  it('frees the bot while the lobby is still waiting', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `abort-wait-${Date.now()}` });
    const lobby = await newLobby(bot); // status defaults to 'waiting'
    await acquire(bot, lobby, 'holderA', 180);
    const freed = await repo.releaseReservationByLobbyIfAbortable(lobby);
    expect(freed).toBe(bot);
  });

  it('NO-OPS when a concurrent reconnect advanced the lobby waiting→active (bot kept for the live draft)', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `abort-active-${Date.now()}` });
    const [lobby] = await sql<{ id: string }[]>`
      INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${bot}, 'active') RETURNING id
    `;
    createdLobbyIds.push(lobby.id);
    await acquire(bot, lobby.id, 'holderA', 180);
    // Lobby is 'active' (draft advanced) → abort release must no-op.
    const freed = await repo.releaseReservationByLobbyIfAbortable(lobby.id);
    expect(freed).toBeNull();
    const still = await sql`SELECT 1 FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });

  it('NO-OPS once the reservation has been transferred onto a match (match_id set)', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `abort-xfer-${Date.now()}` });
    const lobby = await newLobby(bot);
    await acquire(bot, lobby, 'holderA', 180);
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW()) RETURNING id
    `;
    createdMatchIds.push(match.id);
    await sql`UPDATE synthetic_bot_reservations SET match_id = ${match.id} WHERE bot_user_id = ${bot}`;
    const freed = await repo.releaseReservationByLobbyIfAbortable(lobby);
    expect(freed).toBeNull();
    const still = await sql`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(still).toHaveLength(1);
  });
});

describe('sweeper reconciliation (lineage)', () => {
  it('re-keys a stranded lobby-keyed reservation onto its live match (crash between creation and transfer)', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `sweep-${Date.now()}` });
    const lobby = await newLobby(bot);
    // Crash-between-creation-and-transfer: the match row exists (still carrying
    // its lobby_id lineage) but the reservation is still lobby-keyed + expired.
    await sql`
      INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
      VALUES (${bot}, ${lobby}, 'holderA', ${new Date(Date.now() - 1000)})
    `;
    const [match] = await sql<{ id: string }[]>`
      INSERT INTO matches (id, lobby_id, mode, status, category_a_id, total_questions, current_q_index, started_at)
      VALUES (gen_random_uuid(), ${lobby}, 'ranked', 'active', ${categoryId}, 10, 0, NOW())
      RETURNING id
    `;
    createdMatchIds.push(match.id);

    // Lineage lookup: getActiveMatchForLobby finds the match; re-key (not release).
    const activeForLobby = await sql<{ id: string }[]>`SELECT id FROM matches WHERE lobby_id = ${lobby} AND status = 'active' LIMIT 1`;
    expect(activeForLobby).toHaveLength(1);
    const rekeyed = await sql`
      UPDATE synthetic_bot_reservations SET match_id = ${activeForLobby[0].id}
      WHERE bot_user_id = ${bot} AND lobby_id = ${lobby} AND match_id IS NULL RETURNING bot_user_id
    `;
    expect(rekeyed).toHaveLength(1);

    // Terminal release once the match completes.
    await sql`UPDATE matches SET status = 'completed' WHERE id = ${match.id}`;
    const released = await sql`DELETE FROM synthetic_bot_reservations WHERE match_id = ${match.id} RETURNING bot_user_id`;
    expect(released).toHaveLength(1);
  });

  it('releases a genuinely stranded reservation (lobby gone, no active match)', async () => {
    if (!dbAvailable) return;
    const bot = await newUser({ persistent: true, nickname: `strand-${Date.now()}` });
    const lobby = await newLobby(bot);
    await sql`
      INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at)
      VALUES (${bot}, ${lobby}, 'holderA', ${new Date(Date.now() - 1000)})
    `;
    // No match for this lobby; delete the lobby → stranded.
    await sql`DELETE FROM lobbies WHERE id = ${lobby}`;
    createdLobbyIds.length = 0;
    const activeForLobby = await sql<{ id: string }[]>`SELECT id FROM matches WHERE lobby_id = ${lobby} AND status = 'active' LIMIT 1`;
    expect(activeForLobby).toHaveLength(0);
    const released = await sql`DELETE FROM synthetic_bot_reservations WHERE lobby_id = ${lobby} RETURNING bot_user_id`;
    expect(released).toHaveLength(1);
  });
});
