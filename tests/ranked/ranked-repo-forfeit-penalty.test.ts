import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const dbMocks = vi.hoisted(() => {
  const unsafeCalls: { query: string; params: unknown[] }[] = [];
  const unsafeResults: unknown[][] = [];

  const unsafe = vi.fn((query: string, params: unknown[] = []) => {
    unsafeCalls.push({ query, params });
    return Promise.resolve(unsafeResults.shift() ?? []);
  });

  const begin = vi.fn(async (fn: (tx: { unsafe: typeof unsafe }) => Promise<unknown>) =>
    fn({ unsafe })
  );

  const sql = Object.assign(vi.fn(), { begin, unsafe });

  return { unsafeCalls, unsafeResults, unsafe, begin, sql };
});

vi.mock('../../src/db/index.js', () => ({
  sql: dbMocks.sql,
}));

import { rankedRepo } from '../../src/modules/ranked/ranked.repo.js';

const USER_ID = '11111111-1111-1111-1111-111111111111';
const MATCH_ID = '22222222-2222-2222-2222-222222222222';

function findCall(predicate: (query: string) => boolean) {
  return dbMocks.unsafeCalls.find((call) => predicate(call.query));
}

beforeEach(() => {
  dbMocks.unsafeCalls.length = 0;
  dbMocks.unsafeResults.length = 0;
  dbMocks.unsafe.mockClear();
  dbMocks.begin.mockClear();
});

describe('applyEarlyForfeitRpPenalty', () => {
  it('floors rp at 0, records the actual deduction, and recomputes tier', async () => {
    dbMocks.unsafeResults.push([{ rp: 40 }], [1], []);

    const result = await rankedRepo.applyEarlyForfeitRpPenalty(USER_ID, MATCH_ID, 100);

    expect(result).toEqual({ oldRp: 40, newRp: 0 });

    const insert = findCall((q) => q.includes('INSERT INTO ranked_rp_changes'));
    expect(insert?.params).toEqual([MATCH_ID, USER_ID, 40, -40, 0]);

    const update = findCall((q) => q.includes('UPDATE ranked_profiles'));
    expect(update?.params).toEqual([0, 'Academy', USER_ID]);
  });

  it('applies the full nominal deduction and consistent tier when rp stays positive', async () => {
    dbMocks.unsafeResults.push([{ rp: 5000 }], [1], []);

    const result = await rankedRepo.applyEarlyForfeitRpPenalty(USER_ID, MATCH_ID, 100);

    expect(result).toEqual({ oldRp: 5000, newRp: 4900 });

    const insert = findCall((q) => q.includes('INSERT INTO ranked_rp_changes'));
    expect(insert?.params).toEqual([MATCH_ID, USER_ID, 5000, -100, 4900]);

    const update = findCall((q) => q.includes('UPDATE ranked_profiles'));
    expect(update?.params).toEqual([4900, 'Legend', USER_ID]);
  });

  it('returns null when the user has no ranked profile', async () => {
    dbMocks.unsafeResults.push([]);

    const result = await rankedRepo.applyEarlyForfeitRpPenalty(USER_ID, MATCH_ID, 100);

    expect(result).toBeNull();
    expect(findCall((q) => q.includes('UPDATE ranked_profiles'))).toBeUndefined();
  });

  it('does not touch rp again when the penalty ledger row already exists', async () => {
    dbMocks.unsafeResults.push([{ rp: 40 }], []);

    const result = await rankedRepo.applyEarlyForfeitRpPenalty(USER_ID, MATCH_ID, 100);

    expect(result).toEqual({ oldRp: 40, newRp: 40 });
    expect(findCall((q) => q.includes('UPDATE ranked_profiles'))).toBeUndefined();
  });
});
