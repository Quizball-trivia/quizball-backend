import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dbMock = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: dbMock.query }));
import { statsRepo } from '../../src/modules/stats/stats.repo.js';

// Execute the repository's actual SQL against CTE fixtures. No application
// tables, schema setup, or database writes are needed. Like the other database
// integration suites, this self-skips when the local test database is absent.
const fixtures = `
  WITH matches(id, mode, status, is_dev, winner_user_id, ended_at) AS (
    VALUES
      (0, 'ranked', 'completed', false, 'self', '2026-07-01'::timestamptz),
      (1, 'ranked', 'completed', false, 'opponent', '2026-07-03'::timestamptz),
      (2, 'ranked', 'completed', false, NULL, '2026-07-04'::timestamptz),
      (3, 'ranked', 'completed', false, NULL, '2026-07-05'::timestamptz),
      (4, 'ranked', 'completed', false, 'self', '2026-08-01'::timestamptz),
      (5, 'ranked', 'completed', false, 'opponent', '2026-08-02'::timestamptz),
      (6, 'ranked', 'completed', false, NULL, '2026-08-03'::timestamptz),
      (7, 'ranked', 'completed', false, NULL, '2026-08-04'::timestamptz),
      (8, 'ranked', 'completed', false, 'self', '2026-06-30'::timestamptz),
      (9, 'ranked', 'completed', true, 'self', '2026-08-05'::timestamptz),
      (10, 'ranked', 'active', false, 'self', '2026-08-06'::timestamptz),
      (11, 'friendly', 'completed', false, 'self', '2026-08-07'::timestamptz),
      (12, 'ranked', 'completed', false, 'self', NULL::timestamptz)
  ), match_players(match_id, user_id) AS (
    VALUES
      (0, 'self'), (0, 'opponent'), (1, 'self'), (1, 'opponent'),
      (2, 'self'), (2, 'opponent'), (3, 'self'),
      (4, 'self'), (4, 'opponent'), (5, 'self'), (5, 'opponent'),
      (6, 'self'), (6, 'opponent'), (7, 'self'),
      (8, 'self'), (8, 'opponent'), (9, 'self'), (9, 'opponent'),
      (10, 'self'), (10, 'opponent'), (11, 'self'), (11, 'opponent'),
      (12, 'self'), (12, 'opponent')
  )
`;

// Override the port to exercise the unavailable-database path without stopping
// a shared local database. Keep all fixture connections on loopback hosts.
const databaseUrl = new URL(process.env.STATS_TEST_DATABASE_URL ?? 'postgresql://test:test@127.0.0.1:5432/test');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname)) {
  throw new Error('Season-split fixtures require a local PostgreSQL database');
}
const connection = postgres(databaseUrl.toString(), {
  max: 1,
  prepare: false,
  connect_timeout: 1,
});
let available = false;

beforeAll(async () => {
  try {
    await connection`SELECT 1`;
    available = true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (!['ECONNREFUSED', 'CONNECT_TIMEOUT', '3D000', '28P01', '28000'].includes(code ?? '')) throw error;
    return;
  }
  dbMock.query.mockImplementation((strings: TemplateStringsArray, ...parameters: string[]) => {
    const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
    return connection.begin('read only', async (tx) => {
      await tx`SET LOCAL statement_timeout = '2s'`;
      return tx.unsafe(fixtures + query, parameters);
    });
  });
});

afterAll(async () => {
  await connection.end({ timeout: 1 });
});

describe('ranked season split SQL', () => {
  for (const { name, user, start, boundary, previous, current } of [
    { name: 'season boundaries, one-player losses, and excluded matches', user: 'self', start: '2026-07-01', boundary: '2026-08-01', previous: [1, 2, 1], current: [1, 2, 1] },
    { name: 'a player without matches', user: 'absent', start: '2026-07-01', boundary: '2026-08-01', previous: [0, 0, 0], current: [0, 0, 0] },
    { name: 'epoch fallback without a completed reset', user: 'self', start: '1970-01-01', boundary: '1970-01-01', previous: [0, 0, 0], current: [3, 4, 2] },
    { name: 'no matches inside either requested season', user: 'self', start: '2026-09-01', boundary: '2026-10-01', previous: [0, 0, 0], current: [0, 0, 0] },
    { name: 'equal season boundaries', user: 'self', start: '2026-08-01', boundary: '2026-08-01', previous: [0, 0, 0], current: [1, 2, 1] },
    { name: 'reversed bounds preserve the current-season predicate', user: 'self', start: '2026-08-01', boundary: '2026-07-01', previous: [0, 0, 0], current: [2, 4, 2] },
  ]) {
    it(name, async (context) => {
      if (!available) context.skip();
      const result = await statsRepo.getRankedStatsSplitAtBoundary(user, boundary, start);
      expect(result).toEqual({
        previous_wins: previous[0], previous_losses: previous[1], previous_draws: previous[2],
        current_wins: current[0], current_losses: current[1], current_draws: current[2],
      });
    });
  }
});
