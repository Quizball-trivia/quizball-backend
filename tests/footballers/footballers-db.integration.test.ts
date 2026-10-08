import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the word game release tables: a clone of the local room test DB with the word game
 * migrations applied (its own database: the room suite truncates the room tables between tests).
 *   WORDGAMES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_wordgames
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.WORDGAMES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { footballersService } = await import('../../src/modules/footballers/footballers.service.js');
const { MATCHER_VERSION } = await import('../../src/modules/footballers/footballers.universe.js');

// Invented footballers only: the repository is public.
const RELEASE = 'it-release-a';
const OTHER = 'it-release-b';

describe.skipIf(!url)('word game releases on real Postgres', () => {
  const seed = async (id: string, matcher: number, declared: number, names: string[]) => {
    await db.sql`INSERT INTO wordgame_releases (id, fingerprint, matcher_version, players) VALUES (${id}, 'fingerprint-0001', ${matcher}, ${declared})`;
    for (const [i, name] of names.entries()) {
      await db.sql`INSERT INTO wordgame_players (release_id, pid, name, game_name, fame, aliases) VALUES (${id}, ${`p${i}`}, ${name}, ${name.split(' ').pop()!}, ${90 - i}, ${[`Alias ${i}`]})`;
    }
  };

  beforeAll(() => { db.sql = postgres(url!, { max: 2, onnotice: () => undefined }); });
  afterAll(async () => {
    await db.sql`DELETE FROM wordgame_releases WHERE id LIKE 'it-release-%'`;
    await db.sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    footballersService.forget();
    await db.sql`DELETE FROM wordgame_releases WHERE id LIKE 'it-release-%'`;
  });

  it('loads exactly the release asked for, once per process', async () => {
    await seed(RELEASE, MATCHER_VERSION, 2, ['Tarin Orlen', 'Emir Kosel']);
    await seed(OTHER, MATCHER_VERSION, 1, ['Dago Ravin']);
    const universe = await footballersService.universe(RELEASE);
    expect(universe.size).toBe(2);
    expect(universe.resolve('orlen')).toEqual(['p0']);
    expect(universe.resolve('alias 1')).toEqual(['p1']);
    expect(universe.resolve('ravin')).toEqual([]);
    expect(await footballersService.universe(RELEASE)).toBe(universe);
    expect((await footballersService.universe(OTHER)).resolve('ravin')).toEqual(['p0']);
  });

  it('refuses a release that is missing, half written or built for another matcher, and does not remember the failure', async () => {
    await expect(footballersService.universe(RELEASE)).rejects.toMatchObject({ code: 'wordgame_release_missing' });
    await seed(RELEASE, MATCHER_VERSION, 3, ['Tarin Orlen', 'Emir Kosel']);
    await expect(footballersService.universe(RELEASE)).rejects.toMatchObject({ code: 'wordgame_release_incomplete' });
    await db.sql`UPDATE wordgame_releases SET players = 2 WHERE id = ${RELEASE}`;
    expect((await footballersService.universe(RELEASE)).size).toBe(2);
    await seed(OTHER, MATCHER_VERSION + 1, 1, ['Dago Ravin']);
    await expect(footballersService.universe(OTHER)).rejects.toMatchObject({ code: 'wordgame_release_matcher' });
  });

  it('no client role can read the tables', async () => {
    const grants = await db.sql<Array<{ grantee: string }>>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name IN ('wordgame_releases', 'wordgame_players') AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    `;
    expect(grants).toEqual([]);
    const rls = await db.sql<Array<{ relrowsecurity: boolean }>>`SELECT relrowsecurity FROM pg_class WHERE relname IN ('wordgame_releases', 'wordgame_players')`;
    expect(rls.every((r) => r.relrowsecurity)).toBe(true);
  });
});
