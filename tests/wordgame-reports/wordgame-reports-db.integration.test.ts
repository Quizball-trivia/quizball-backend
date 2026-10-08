import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

/**
 * Opt-in, real PostgreSQL with the word game tables (see footballers-db.integration.test.ts):
 *   WORDGAMES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_wordgames
 */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.WORDGAMES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { wordgameReportsRepo } = await import('../../src/modules/wordgame-reports/wordgame-reports.repo.js');
const { wordgameReportsService } = await import('../../src/modules/wordgame-reports/wordgame-reports.service.js');

describe.skipIf(!url)('word game reports on real Postgres', () => {
  const users: string[] = [];
  const user = async (): Promise<string> => {
    const id = randomUUID();
    await db.sql`INSERT INTO users (id, nickname) VALUES (${id}, ${`rep-${id.slice(0, 8)}`})`;
    users.push(id);
    return id;
  };
  const base = (userId: string, norm: string, contextId = randomUUID()) => ({
    game: 'shared_player' as const, source: 'daily' as const, contextId, round: 2, releaseId: 'it-release', subject: 'club-a|club-b',
    typed: norm, norm, resolvedPid: null, reporter: { userId },
  });

  beforeAll(() => { db.sql = postgres(url!, { max: 2, onnotice: () => undefined }); });
  afterAll(async () => {
    if (users.length) await db.sql`DELETE FROM users WHERE id IN ${db.sql(users)}`;
    await db.sql.end({ timeout: 5 });
  });
  beforeEach(async () => { await db.sql`DELETE FROM wordgame_reports`; });

  it('stores a report once per reporter, place and text', async () => {
    const reporter = await user();
    const context = randomUUID();
    expect(await wordgameReportsRepo.file(base(reporter, 'milo vantar', context), 20)).toBe(true);
    expect(await wordgameReportsRepo.file(base(reporter, 'milo vantar', context), 20)).toBe(false);
    expect(await wordgameReportsRepo.file({ ...base(reporter, 'milo vantar', context), round: 3 }, 20)).toBe(true);
    expect(await wordgameReportsRepo.file(base(await user(), 'milo vantar', context), 20)).toBe(true);
    const [{ count }] = await db.sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM wordgame_reports`;
    expect(count).toBe(3);
  });

  it("stops at the reporter's daily budget and leaves other reporters alone", async () => {
    const reporter = await user();
    for (let i = 0; i < 3; i += 1) expect(await wordgameReportsRepo.file(base(reporter, `name ${i}`), 3)).toBe(true);
    expect(await wordgameReportsRepo.file(base(reporter, 'one more'), 3)).toBe(false);
    expect(await wordgameReportsRepo.file(base(await user(), 'one more'), 3)).toBe(true);
    // Yesterday's reports do not count against today.
    await db.sql`UPDATE wordgame_reports SET created_at = now() - interval '25 hours' WHERE user_id = ${reporter}`;
    expect(await wordgameReportsRepo.file(base(reporter, 'one more'), 3)).toBe(true);
  });

  it('cleans the text, folds it for the one-per-text rule and never throws', async () => {
    const reporter = await user();
    const context = randomUUID();
    const report = { game: 'name_chain' as const, source: 'room' as const, contextId: context, round: 0, reporter: { userId: reporter } };
    const refusal = { release: 'it-release', subject: null, resolvedPid: null };
    await wordgameReportsService.file(report, refusal, '  Mílo   Vantar ');
    await wordgameReportsService.file(report, refusal, 'milo vantar');
    const rows = await db.sql<Array<{ typed: string; norm: string }>>`SELECT typed, norm FROM wordgame_reports`;
    expect(rows).toEqual([{ typed: 'Mílo Vantar', norm: 'milo vantar' }]);
    // A reporter that no longer exists: the write fails, the caller is not disturbed.
    await expect(wordgameReportsService.file({ ...report, reporter: { userId: randomUUID() } }, refusal, 'Milo Vantar')).resolves.toBeUndefined();
  });

  it('purges reports past their retention, a batch at a time', async () => {
    const reporter = await user();
    for (let i = 0; i < 3; i += 1) await wordgameReportsRepo.file(base(reporter, `old ${i}`), 20);
    await db.sql`UPDATE wordgame_reports SET created_at = now() - interval '91 days'`;
    await wordgameReportsRepo.file(base(reporter, 'fresh'), 20);
    expect(await wordgameReportsRepo.purge(90, 2)).toBe(2);
    expect(await wordgameReportsRepo.purge(90, 2)).toBe(1);
    expect(await wordgameReportsRepo.purge(90, 2)).toBe(0);
    const rows = await db.sql<Array<{ norm: string }>>`SELECT norm FROM wordgame_reports`;
    expect(rows).toEqual([{ norm: 'fresh' }]);
  });
});
