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
const NEWER = 'it-seed-release-2';
const label = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const pair = (id: string, a: string, b: string, release = RELEASE, accepted = ['s-1', 's-2']) => ({
  id, release, a: { key: a, label: label(a), crest: '/clubs/a.webp' }, b: { key: b, label: label(b), crest: '/clubs/b.webp' }, accepted, examples: accepted.length,
});
const day = (date: string, number: number, tag: string, first = pair(`${tag}-0`, `${tag}-north-0`, `${tag}-south-0`)) => {
  const content = { release: first.release, pairs: [first, ...Array.from({ length: 9 }, (_, n) => pair(`${tag}-${n + 1}`, `${tag}-north-${n + 1}`, `${tag}-south-${n + 1}`, first.release))] };
  return { day: date, number, contentVersion: contentHash(content), content: content as Record<string, unknown> };
};

describe.skipIf(!url)('word game days seed on real Postgres', () => {
  const clean = async () => {
    await db.sql`DELETE FROM shared_player_runs`;
    await db.sql`DELETE FROM shared_player_days`;
    await db.sql`DELETE FROM room_pool WHERE game = 'shared_player' AND payload->>'release' = ${RELEASE}`;
    await db.sql`DELETE FROM wordgame_releases WHERE id IN (${RELEASE}, ${NEWER})`;
  };
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await clean();
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${RELEASE}, 'fingerprint-0001', 1, 3)`;
    await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame) VALUES (${RELEASE}, 's-0', 'Oren Vasco', 'Vasco', 30), (${RELEASE}, 's-1', 'Tarin Orlen', 'Orlen', 80), (${RELEASE}, 's-2', 'Emir Kosel', 'Kosel', 60)`;
  });
  afterAll(async () => { await clean(); await db.sql.end({ timeout: 5 }); });
  const seed = (days: ReturnType<typeof day>[]) => seedDays(db.sql as never, { game: 'shared_player', days }, { dryRun: false, allowCorrection: true });

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

  it('the runs table takes the largest tie-break a twenty-second day can produce, and nothing above it', async () => {
    await seedDays(db.sql, { game: 'shared_player', days: [day('2026-10-06', 1, 'cap')] }, { dryRun: false, allowCorrection: false });
    const player = async () => (await db.sql<Array<{ id: string }>>`
      INSERT INTO users (id, nickname) VALUES (gen_random_uuid(), ${`cap-${Math.random().toString(36).slice(2, 10)}`}) RETURNING id`)[0].id;
    const finished = async (speed: number) => db.sql`
      INSERT INTO shared_player_runs (id, user_id, day, ranked, content_version, state, state_version, done, score, speed, completed_at, closes_at)
      VALUES (gen_random_uuid(), ${await player()}, '2026-10-06', false, 1, '{}'::jsonb, 0, true, 10, ${speed}, now(), now())`;
    await expect(finished(2000)).resolves.toBeDefined();
    await expect(finished(2001)).rejects.toThrow(/chk_shared_player_runs_speed/);
  });

  it('moves later days to a newer release without touching the played ones, each day checked against its own release', async () => {
    await db.sql`DELETE FROM shared_player_runs`;
    await db.sql`DELETE FROM shared_player_days`;
    const older = [day('2026-04-01', 1, 'r1'), day('2026-04-02', 2, 'r2')];
    expect(await seed(older)).toMatchObject({ fresh: 2 });
    const [{ id: user }] = await db.sql<Array<{ id: string }>>`INSERT INTO users (id, nickname) VALUES (gen_random_uuid(), ${`rel-${Math.random().toString(36).slice(2, 10)}`}) RETURNING id`;
    await db.sql`
      INSERT INTO shared_player_runs (id, user_id, day, ranked, content_version, state, state_version, done, score, speed, completed_at, closes_at)
      VALUES (gen_random_uuid(), ${user}, '2026-04-01', true, ${older[0].contentVersion}, '{}'::jsonb, 0, true, 7, 100, now(), now())`;
    // 's-0' is only in the older release, 's-3' only in the newer one.
    const moved = (accepted: string[]) => [older[0], day('2026-04-02', 2, 'r2', pair('r2-0', 'r2-north-0', 'r2-south-0', NEWER, accepted))];
    const strict = (days: ReturnType<typeof day>[]) => seedDays(db.sql as never, { game: 'shared_player', days }, { dryRun: false, allowCorrection: false });
    await expect(strict(moved(['s-1', 's-3']))).rejects.toThrow(/release it-seed-release-2 is not seeded here/);
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${NEWER}, 'fingerprint-0002', 1, 3)`;
    await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame) VALUES (${NEWER}, 's-1', 'Tarin Orlen', 'Orlen', 80), (${NEWER}, 's-2', 'Emir Kosel', 'Kosel', 60), (${NEWER}, 's-3', 'Davin Marek', 'Marek', 40)`;
    await expect(strict(moved(['s-1', 's-0']))).rejects.toThrow(/1 accepted footballers are not in release it-seed-release-2/);
    // The played day keeps its release, its version and its ranked run; no correction was needed.
    expect(await strict(moved(['s-1', 's-3']))).toEqual({ fresh: 0, unchanged: 1, corrected: 1, unranked: 0 });
    const rows = await db.sql<Array<{ day: string; release: string; version: string }>>`SELECT day::text AS day, pairs->>'release' AS release, content_version AS version FROM shared_player_days ORDER BY day`;
    expect(rows.map((r) => [r.day, r.release])).toEqual([['2026-04-01', RELEASE], ['2026-04-02', NEWER]]);
    expect(Number(rows[0].version)).toBe(older[0].contentVersion);
    expect((await db.sql<Array<{ ranked: boolean }>>`SELECT ranked FROM shared_player_runs WHERE day = '2026-04-01'`)[0].ranked).toBe(true);
    // Moving the played day itself is a correction like any other: refused whole, then done with its run unranked.
    const both = [day('2026-04-01', 1, 'r1', pair('r1-0', 'r1-north-0', 'r1-south-0', NEWER)), moved(['s-1', 's-3'])[1]];
    await expect(strict(both)).rejects.toThrow(/already have runs \(2026-04-01\)/);
    expect((await db.sql<Array<{ release: string }>>`SELECT pairs->>'release' AS release FROM shared_player_days WHERE day = '2026-04-01'`)[0].release).toBe(RELEASE);
    expect(await seed(both)).toEqual({ fresh: 0, unchanged: 1, corrected: 1, unranked: 1 });
    await db.sql`DELETE FROM shared_player_runs`;
    await db.sql`DELETE FROM shared_player_days`;
  });

  it('checks every release of a name chain file too', async () => {
    const chain = (date: string, number: number, release: string) => {
      const content = { release, seed: number };
      return { day: date, number, contentVersion: contentHash(content), content: content as Record<string, unknown> };
    };
    const days = [chain('2026-04-01', 1, RELEASE), chain('2026-04-02', 2, 'it-seed-release-none')];
    await expect(seedDays(db.sql as never, { game: 'name_chain', days }, { dryRun: true, allowCorrection: false })).rejects.toThrow(/release it-seed-release-none is not seeded here/);
    expect(await seedDays(db.sql as never, { game: 'name_chain', days: [days[0], chain('2026-04-02', 2, NEWER)] }, { dryRun: true, allowCorrection: false })).toMatchObject({ fresh: 2 });
  });

  it('refuses a daily pair that is also a room pair, whatever its id', async () => {
    const room = pair('room-item', 'd9-south-0', 'd9-north-0');
    await db.sql`INSERT INTO room_pool (game, item_id, difficulty, fingerprint, payload, tags) VALUES ('shared_player', 'room-item', 'easy', 'fp-seed-room-item', ${db.sql.json(room as never)}, ${['mixed']})`;
    await expect(seed([day('2026-03-13', 4, 'd9')])).rejects.toThrow(/also room pairs/);
  });
});
