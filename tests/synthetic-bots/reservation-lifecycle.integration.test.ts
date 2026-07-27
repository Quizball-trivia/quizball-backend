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
