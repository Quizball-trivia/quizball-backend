import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const dbMocks = vi.hoisted(() => {
  const unsafeResults: unknown[][] = [];
  const unsafe = vi.fn(() => Promise.resolve(unsafeResults.shift() ?? []));
  const begin = vi.fn(async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
    fn({ unsafe })
  );
  const sql = Object.assign(vi.fn(), { begin });
  return { unsafeResults, unsafe, begin, sql };
});

vi.mock('../../src/db/index.js', () => ({ sql: dbMocks.sql }));

import { usersRepo } from '../../src/modules/users/users.repo.js';

beforeEach(() => {
  dbMocks.unsafeResults.length = 0;
  dbMocks.unsafe.mockClear();
  dbMocks.begin.mockClear();
});

describe('bumpEarlyForfeitCount', () => {
  it('increments only when the match-scoped marker is newly inserted', async () => {
    dbMocks.unsafeResults.push([{ match_id: 'm1' }], [{ early_forfeit_count: 4 }]);
    await expect(usersRepo.bumpEarlyForfeitCount('u1', 'm1')).resolves.toBe(4);
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(2);
    expect(dbMocks.unsafe.mock.calls[1]?.[0]).toContain('UPDATE users');
  });

  it('returns the existing count without incrementing on a replay', async () => {
    dbMocks.unsafeResults.push([], [{ early_forfeit_count: 4 }]);
    await expect(usersRepo.bumpEarlyForfeitCount('u1', 'm1')).resolves.toBe(4);
    expect(dbMocks.unsafe).toHaveBeenCalledTimes(2);
    expect(dbMocks.unsafe.mock.calls[1]?.[0]).toContain('SELECT early_forfeit_count');
  });
});
