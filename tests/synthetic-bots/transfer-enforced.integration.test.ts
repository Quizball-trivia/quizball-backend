/**
 * P1-D: createMatchFromLobby must ENFORCE the reservation transfer for a
 * persistent-bot ranked match. If no reservation can be transferred onto the new
 * match, the whole creation transaction must ROLL BACK — no match / match_players
 * rows may be committed, and the lobby retains the bot for a retry.
 *
 * Drives the REAL matchesService.createMatchFromLobby against the test DB (app
 * `sql` singleton → localhost per tests/setup.ts). Skips when DB unavailable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let matchesService: typeof import('../../src/modules/matches/matches.service.js').matchesService;
let dbAvailable = false;
let categoryId: string;
const userIds: string[] = [];
const lobbyIds: string[] = [];

async function user(nickname: string, persistent = false): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, onboarding_complete)
    VALUES (${nickname}, ${persistent}, ${persistent ? 'persistent' : null}, true)
    RETURNING id
  `;
  userIds.push(u.id);
  return u.id;
}

beforeAll(async () => {
  try {
    sql = (await import('../../src/db/index.js')).sql;
    await sql`SELECT 1`;
    const [cat] = await sql<{ id: string }[]>`SELECT id FROM categories LIMIT 1`;
    if (!cat) throw new Error('no category');
    categoryId = cat.id;
    matchesService = (await import('../../src/modules/matches/matches.service.js')).matchesService;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping transfer-enforced integration test: DB unavailable.\n');
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (lobbyIds.length > 0) {
    await sql`DELETE FROM synthetic_bot_reservations WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
    await sql`DELETE FROM lobby_members WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
  }
  if (userIds.length > 0) {
    await sql`DELETE FROM matches WHERE lobby_id = ANY(${lobbyIds}::uuid[])`;
    await sql`DELETE FROM lobbies WHERE id = ANY(${lobbyIds}::uuid[])`;
    await sql`DELETE FROM synthetic_player_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${userIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${userIds}::uuid[])`;
  }
  await sql.end();
});

describe('createMatchFromLobby enforces the persistent-bot transfer', () => {
  it('rolls back (throws) and commits NO match when there is no reservation to transfer', async () => {
    if (!dbAvailable) return;
    const human = await user(`xfer-human-${Date.now()}`);
    const bot = await user(`xfer-bot-${Date.now()}`, true);
    // ranked profile for the bot (createMatchFromLobby ensures it, but seed to be safe)
    await sql`INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played) VALUES (${bot}, 1200, 'Bench', 'placed', 3, 3) ON CONFLICT (user_id) DO NOTHING`;
    const [lobby] = await sql<{ id: string }[]>`
      INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${human}, 'waiting') RETURNING id
    `;
    lobbyIds.push(lobby.id);
    await sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${human}, true), (${lobby.id}, ${bot}, true)`;

    // NO reservation row exists for this lobby → transferInTx returns false →
    // creation must throw and roll back.
    await expect(
      matchesService.createMatchFromLobby({
        lobbyId: lobby.id,
        mode: 'ranked',
        variant: 'ranked_sim',
        hostUserId: human,
        categoryAId: categoryId,
        categoryBId: null,
      }),
    ).rejects.toThrow();

    // No match row committed for this lobby.
    const matches = await sql`SELECT id FROM matches WHERE lobby_id = ${lobby.id}`;
    expect(matches).toHaveLength(0);
  });

  it('commits the match AND transfers when a reservation is present', async () => {
    if (!dbAvailable) return;
    const human = await user(`xfer2-human-${Date.now()}`);
    const bot = await user(`xfer2-bot-${Date.now()}`, true);
    await sql`INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played) VALUES (${bot}, 1200, 'Bench', 'placed', 3, 3) ON CONFLICT (user_id) DO NOTHING`;
    await sql`INSERT INTO synthetic_player_profiles (user_id, base_skill, personality_seed, status) VALUES (${bot}, 0.5, 999, 'active') ON CONFLICT (user_id) DO NOTHING`;
    const [lobby] = await sql<{ id: string }[]>`
      INSERT INTO lobbies (mode, host_user_id, status) VALUES ('ranked', ${human}, 'waiting') RETURNING id
    `;
    lobbyIds.push(lobby.id);
    await sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${human}, true), (${lobby.id}, ${bot}, true)`;
    await sql`INSERT INTO synthetic_bot_reservations (bot_user_id, lobby_id, holder, expires_at) VALUES (${bot}, ${lobby.id}, 'holderA', now() + interval '180 seconds')`;

    const result = await matchesService.createMatchFromLobby({
      lobbyId: lobby.id,
      mode: 'ranked',
      variant: 'ranked_sim',
      hostUserId: human,
      categoryAId: categoryId,
      categoryBId: null,
    });
    expect(result.match.id).toBeTruthy();
    // Reservation now carries the match id (transferred).
    const [res] = await sql<{ match_id: string | null }[]>`SELECT match_id FROM synthetic_bot_reservations WHERE bot_user_id = ${bot}`;
    expect(res.match_id).toBe(result.match.id);
    // matches_today bumped exactly once in the same tx.
    const [prof] = await sql<{ matches_today: number }[]>`SELECT matches_today FROM synthetic_player_profiles WHERE user_id = ${bot}`;
    expect(prof.matches_today).toBe(1);
  });
});
