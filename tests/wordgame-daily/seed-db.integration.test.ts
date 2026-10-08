import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the word game tables (see footballers-db.integration.test.ts):
 *   WORDGAMES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_wordgames
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.WORDGAMES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { contentHash, seedDays } = await import('../../src/modules/wordgame-daily/wordgame-daily.seed.js');

// Invented footballers and clubs only: the repository is public.
const RELEASE = 'it-seed-release';
const label = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const pair = (id: string, a: string, b: string) => ({
  id, release: RELEASE, a: { key: a, label: label(a), crest: '/clubs/a.webp' }, b: { key: b, label: label(b), crest: '/clubs/b.webp' }, accepted: ['s-1', 's-2'], examples: 2,
});
const day = (date: string, number: number, tag: string, first = pair(`${tag}-0`, `${tag}-north-0`, `${tag}-south-0`)) => {
  const content = { release: RELEASE, pairs: [first, ...Array.from({ length: 9 }, (_, n) => pair(`${tag}-${n + 1}`, `${tag}-north-${n + 1}`, `${tag}-south-${n + 1}`))] };
  return { day: date, number, contentVersion: contentHash(content), content: content as Record<string, unknown> };
};

describe.skipIf(!url)('word game days seed on real Postgres', () => {
  const clean = async () => {
    await db.sql`DELETE FROM shared_player_runs`;
    await db.sql`DELETE FROM shared_player_days`;
    await db.sql`DELETE FROM room_pool WHERE game = 'shared_player' AND payload->>'release' = ${RELEASE}`;
    await db.sql`DELETE FROM wordgame_releases WHERE id = ${RELEASE}`;
  };
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await clean();
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${RELEASE}, 'fingerprint-0001', 1, 2)`;
    await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame) VALUES (${RELEASE}, 's-1', 'Tarin Orlen', 'Orlen', 80), (${RELEASE}, 's-2', 'Emir Kosel', 'Kosel', 60)`;
  });
  afterAll(async () => { await clean(); await db.sql.end({ timeout: 5 }); });
  const seed = (days: ReturnType<typeof day>[]) => seedDays(db.sql as never, { game: 'shared_player', release: RELEASE, days }, { dryRun: false, allowCorrection: true });

  it('writes days, and refuses a pair that a stored day outside the file already has (by id or by its two clubs)', async () => {
    const stored = [day('2026-03-10', 1, 'd1'), day('2026-03-11', 2, 'd2'), day('2026-03-12', 3, 'd3')];
    expect(await seed(stored)).toMatchObject({ fresh: 3 });
    // Day 1 again, now carrying day 3's first pair under another id and with the clubs swapped; day 3 stays stored.
    const leaking = day('2026-03-10', 1, 'd1', pair('renamed', 'd3-south-0', 'd3-north-0'));
    await expect(seed([leaking, stored[1]])).rejects.toThrow(/already on a stored day/);
    await expect(seed([day('2026-03-10', 1, 'd1', pair('d3-0', 'x-north', 'x-south')), stored[1]])).rejects.toThrow(/already on a stored day/);
    // The same pair moving inside the file is the file's own business (its duplicate check), not this one.
    expect(await seed(stored)).toMatchObject({ unchanged: 3 });
  });

  it('refuses a daily pair that is also a room pair, whatever its id', async () => {
    const room = pair('room-item', 'd9-south-0', 'd9-north-0');
    await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags) VALUES ('shared_player', 'room-item', 'easy', 'fp-seed-room-item', ${db.sql.json(room as never)}, ${['mixed']})`;
    await expect(seed([day('2026-03-13', 4, 'd9')])).rejects.toThrow(/also room pairs/);
  });
});
