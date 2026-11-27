import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const h = vi.hoisted(() => ({ read: vi.fn(), limits: [] as number[] }));
vi.mock('../../src/db/index.js', () => ({
  // The reader's only statement: LIMIT is its last parameter.
  sql: (_parts: TemplateStringsArray, ...params: unknown[]) => {
    h.limits.push(params.at(-1) as number);
    return h.read();
  },
}));
const { readPartnerSnapshot, forgetPartnerSnapshotsForTests } = await import('../../src/modules/partner-stats/partner-totals.js');

const NOW = new Date('2026-11-27T08:00:00Z'); // 12:00 in Tbilisi
const day = (n: number) => {
  const d = new Date('2026-11-27T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const rows = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    day: day(i), total_users: 500 - i, new_users: 1, active_users: 10, active_7d: 20, active_30d: 30, matches: 2,
    updated_at: '2026-11-27T07:30:00.000Z',
  }));

describe('partner reader reuse after a failed read', () => {
  beforeEach(() => {
    forgetPartnerSnapshotsForTests();
    h.read.mockReset();
    h.limits.length = 0;
  });

  it('serves a shorter window from a longer read (a 94-row read answers a 40-row request)', async () => {
    h.read.mockResolvedValueOnce(rows(94));
    await readPartnerSnapshot(day(89), 'table-derby', NOW);
    h.read.mockRejectedValueOnce(new Error('connection reset'));
    const snapshot = await readPartnerSnapshot(day(29), 'table-derby', NOW);
    expect(h.limits).toEqual([94, 40]);
    expect(snapshot?.totalUsers).toBe(500);
    expect(snapshot?.days).toHaveLength(30);
  });

  it('serves a longer window from a shorter read that already held every synced day', async () => {
    h.read.mockResolvedValueOnce(rows(12));
    await readPartnerSnapshot(day(29), 'table-derby', NOW);
    h.read.mockRejectedValueOnce(new Error('connection reset'));
    expect((await readPartnerSnapshot(day(89), 'table-derby', NOW))?.days).toHaveLength(12);
  });

  it('fails when no kept read covers the window', async () => {
    h.read.mockResolvedValueOnce(rows(40));
    await readPartnerSnapshot(day(29), 'table-derby', NOW);
    h.read.mockRejectedValueOnce(new Error('connection reset'));
    await expect(readPartnerSnapshot(day(89), 'table-derby', NOW)).rejects.toThrow('connection reset');
  });
});
