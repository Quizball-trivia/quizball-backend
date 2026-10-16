import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL: a Tenable room on a replica whose caches are cold. The name directories are loaded before
 * the match lock is taken, so even a one-connection pool never waits on itself (a load under the lock would need a
 * second connection while the transaction holds the only one). Its own database: the Aproximado suite truncates the
 * room tables between its tests.
 *   TENABLE_ROOM_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_tenable
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.TENABLE_ROOM_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

// Invented clubs only: the repository is public.
const RELEASE = 'it-tenable-release';
const CLUBS = Array.from({ length: 14 }, (_, i) => ({ eid: `c-${i}`, name: `Northgate Rovers ${String.fromCharCode(65 + i)}` }));
const GAMES = ['aproximado', 'tenable'];
const list = (tier: string) => ({
  id: `it-tenable-${tier}`, kind: 'club', release: RELEASE, matcher: 1, tier, topicKey: `it-topic-${tier}`,
  title: { en: tier, es: tier, ka: tier, tr: tier }, note: null, asOf: null,
  slots: CLUBS.slice(0, 10).map((c, i) => ({ eid: c.eid, figure: { value: 100 - i, unit: 'titles' } })),
});

describe.skipIf(!url)('Tenable room on a cold replica (real Postgres)', () => {
  beforeAll(async () => {
    process.env.ROOM_GAMES_ENABLED = 'aproximado,tenable';
    db.sql = postgres(url!, { max: 1, onnotice: () => undefined });
    await db.sql`DELETE FROM room_pool WHERE game = 'tenable'`;
    await db.sql`DELETE FROM tenable_entity_releases WHERE id IN (${RELEASE}, 'it-tenable-away')`;
    await db.sql`INSERT INTO tenable_entity_releases (id, fingerprint, matcher_version, counts) VALUES (${RELEASE}, 'fp-it', 1, ${db.sql.json({ club: CLUBS.length })})`;
    for (const c of CLUBS) {
      await db.sql`INSERT INTO tenable_entities (release_id, kind, eid, name, known, fame, aliases, qualifier) VALUES (${RELEASE}, 'club', ${c.eid}, ${c.name}, ${c.name}, 50, '{}', null)`;
    }
    for (const tier of ['easy', 'medium', 'hard']) {
      await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags) VALUES ('tenable', ${`it-tenable-${tier}`}, ${tier}, ${`fp-${tier}`}, ${db.sql.json(list(tier))}, ${['club']})`;
    }
  });
  afterAll(async () => {
    await db.sql`DELETE FROM room_pool WHERE game = 'tenable'`;
    await db.sql`DELETE FROM tenable_entity_releases WHERE id = ${RELEASE}`;
    await db.sql.end({ timeout: 5 });
  });

  it('a replica that never loaded the match plays it without waiting on its own pool', { timeout: 20_000 }, async () => {
    const { roomService } = await import('../../src/modules/room/room.service.js');
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      ids.push((await db.sql<Array<{ id: string }>>`
        INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`t-${randomUUID().slice(0, 8)}`}, false) RETURNING id`)[0].id);
    }
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'tenable') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'tenable', players: ids.map((userId) => ({ userId, isGuest: false })) });

    // Another replica: fresh modules, so no content and no directory is loaded yet.
    vi.resetModules();
    const cold = (await import('../../src/modules/room/room.service.js')).roomService;
    for (const id of ids) await cold.ready(created.matchId, id, 'en', GAMES);
    const [row] = await db.sql<Array<{ status: string }>>`SELECT status FROM room_matches WHERE id = ${created.matchId}`;
    expect(row.status).toBe('active');
  });

  it('a cold replica that cannot load the names refuses quickly (retryable) instead of waiting under the lock', { timeout: 20_000 }, async () => {
    const { roomService } = await import('../../src/modules/room/room.service.js');
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      ids.push((await db.sql<Array<{ id: string }>>`
        INSERT INTO users (id, nickname, is_guest) VALUES (${randomUUID()}, ${`t-${randomUUID().slice(0, 8)}`}, false) RETURNING id`)[0].id);
    }
    const [lobby] = await db.sql<Array<{ id: string }>>`
      INSERT INTO lobbies (mode, host_user_id, status, invite_code, game_mode, room_game)
      VALUES ('friendly', ${ids[0]}, 'waiting', ${randomUUID().slice(0, 6).toUpperCase()}, 'room_game', 'tenable') RETURNING id`;
    for (const id of ids) await db.sql`INSERT INTO lobby_members (lobby_id, user_id, is_ready) VALUES (${lobby.id}, ${id}, true)`;
    const created = await roomService.createFromLobby({ lobbyId: lobby.id, game: 'tenable', players: ids.map((userId) => ({ userId, isGuest: false })) });

    vi.resetModules();
    const cold = (await import('../../src/modules/room/room.service.js')).roomService;
    // The names are gone for a moment (a failed read looks the same to the loader).
    await db.sql`INSERT INTO tenable_entity_releases (id, fingerprint, matcher_version, counts) VALUES ('it-tenable-away', 'fp-away', 1, '{}') ON CONFLICT DO NOTHING`;
    await db.sql`UPDATE tenable_entities SET release_id = 'it-tenable-away' WHERE release_id = ${RELEASE}`;
    const started = Date.now();
    await expect(cold.ready(created.matchId, ids[0], 'en', GAMES)).rejects.toMatchObject({ code: 'room_content_unavailable', status: 503 });
    expect(Date.now() - started).toBeLessThan(5_000);
    await db.sql`UPDATE tenable_entities SET release_id = ${RELEASE} WHERE release_id = 'it-tenable-away'`;
    await db.sql`DELETE FROM tenable_entity_releases WHERE id = 'it-tenable-away'`;
    // The failure is remembered briefly (an incident is not multiplied by traffic); after that the names load again.
    const { FAILED_RETRY_MS } = await import('../../src/modules/tenable/tenable.directories.js');
    await new Promise((resolve) => setTimeout(resolve, FAILED_RETRY_MS + 100));
    for (const id of ids) await cold.ready(created.matchId, id, 'en', GAMES);
    const [row] = await db.sql<Array<{ status: string }>>`SELECT status FROM room_matches WHERE id = ${created.matchId}`;
    expect(row.status).toBe('active');
  });

  it('a supersede chain seeded in any order leaves only its newest list in the pool', async () => {
    const { seedPool } = await import('../../src/modules/tenable/tenable.seed.js');
    const chain = ['a', 'b', 'c'].map((v, i) => ({ ...list('easy'), id: `it-chain-${v}`, topicKey: 'it-chain', ...(i > 0 ? { supersedes: `it-chain-${'ab'[i - 1]}` } : {}) }));
    await db.sql`DELETE FROM tenable_content_ledger WHERE topic_key = 'it-chain'`;
    await seedPool(db.sql, [...chain].reverse() as never, { dryRun: false });
    const rows = await db.sql<Array<{ item_id: string; enabled: boolean }>>`SELECT item_id, enabled FROM room_pool WHERE item_id LIKE 'it-chain-%' ORDER BY item_id`;
    expect(rows).toEqual([{ item_id: 'it-chain-a', enabled: false }, { item_id: 'it-chain-b', enabled: false }, { item_id: 'it-chain-c', enabled: true }]);
    await db.sql`DELETE FROM tenable_content_ledger WHERE topic_key = 'it-chain'`;
  });
});
