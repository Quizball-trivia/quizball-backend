import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';

/** Opt-in, a local database: WORDGAMES_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/quizball_room_test_<name> */
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));

const url = process.env.WORDGAMES_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:(5432|5436)\/quizball_room_test_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local room test database required');

const { createDailyRunsRepo } = await import('../../src/modules/daily/daily.repo.js');
const TABLE = 'daily_common_state_value_test';

describe.skipIf(!url)('daily runs repo: the value most runs of a day froze (real Postgres)', () => {
  const repo = createDailyRunsRepo({ runs: TABLE, days: 'unused_days', payload: 'unused', stat: 'unused' });
  beforeAll(async () => {
    db.sql = postgres(url!, { max: 2, onnotice: () => undefined });
    await db.sql.unsafe(`DROP TABLE IF EXISTS ${TABLE}; CREATE TABLE ${TABLE} (day date NOT NULL, state jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT '2026-10-01 12:00Z', closes_at timestamptz NOT NULL DEFAULT '2026-10-02 03:00Z')`);
    const states = [{ ov: 'v1', al: 'cy' }, { ov: 'v1', al: 'cy' }, { ov: 'v2', al: 'cy' }, { ov: 'v3' }, { ov: 'v3' }, { ov: 'v3' }, {}];
    for (const state of states) await db.sql`INSERT INTO ${db.sql(TABLE)} (day, state) VALUES ('2026-10-01', ${db.sql.json(state)})`;
    // Archive plays after the day closed, on a newer version: more of them than of the day's own runs.
    for (let i = 0; i < 4; i += 1) {
      await db.sql`INSERT INTO ${db.sql(TABLE)} (day, state, created_at) VALUES ('2026-10-01', ${db.sql.json({ ov: 'v9', al: 'cy' })}, '2026-10-05 10:00Z')`;
    }
  });
  afterAll(async () => {
    await db.sql.unsafe(`DROP TABLE IF EXISTS ${TABLE}`);
    await db.sql.end({ timeout: 5 });
  });

  it('counts only the runs that match, and only that day', async () => {
    expect(await repo.commonStateValue('2026-10-01', 'ov', { key: 'al', value: 'cy' })).toBe('v1');
    expect(await repo.commonStateValue('2026-10-01', 'ov')).toBe('v3');
    expect(await repo.commonStateValue('2026-10-02', 'ov')).toBeNull();
  });

  it('runs started after the day closed never change the answer', async () => {
    expect(await repo.commonStateValue('2026-10-01', 'ov', { key: 'al', value: 'cy' })).toBe('v1');
  });

  it('refuses a key that is not a plain state key', async () => {
    await expect(repo.commonStateValue('2026-10-01', "ov'--")).rejects.toThrow('Bad state key');
  });
});
