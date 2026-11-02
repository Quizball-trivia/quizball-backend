import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A query that never answers (a lock wait, a lost connection): what production's Darts 501 reads did after launch.
const db = vi.hoisted(() => ({ withStatementTimeout: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => []), withStatementTimeout: db.withStatementTimeout }));

import { createDailyContentStore } from '../../src/modules/daily/daily.content.js';
import { D501_READ_DEADLINE_MS, D501_READ_STATEMENT_MS, D501ContentUnavailableError, darts501Reads, withDeadline } from '../../src/modules/darts501-daily/darts501-daily.reads.js';
import { withBoards } from '../../src/modules/darts501-daily/darts501-daily.service.js';
import { category, coverage, directory } from './fixture.js';

const never = <T>() => new Promise<T>(() => undefined);
const dayRow = (day: string) => ({ day, number: 1, contentVersion: 7, category: category(`c-${day}`) });
// The fixture's tiny invented category is below the publishing minimums, so the index is built as served, unchecked.
const indexed = (row: ReturnType<typeof dayRow>) => ({ ...row, category: row.category });
const silentLog = { warn: () => undefined, error: () => undefined };

beforeEach(() => { db.withStatementTimeout.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Darts 501 content reads never hang a request', () => {
  it('every read carries a server-side statement bound', async () => {
    db.withStatementTimeout.mockResolvedValue([{ fingerprint: '1:2:3' }]);
    await expect(darts501Reads.daysFingerprint()).resolves.toBe('1:2:3');
    expect(db.withStatementTimeout).toHaveBeenCalledWith(expect.any(Function), D501_READ_STATEMENT_MS);
  });

  it('a read that never answers becomes a 503 at the deadline', async () => {
    vi.useFakeTimers();
    db.withStatementTimeout.mockReturnValue(never());
    const read = darts501Reads.loadDays();
    const outcome = expect(read).rejects.toBeInstanceOf(D501ContentUnavailableError);
    await vi.advanceTimersByTimeAsync(D501_READ_DEADLINE_MS);
    await outcome;
    await expect(read).rejects.toMatchObject({ statusCode: 503, details: { reason: 'darts501_content_unavailable' } });
  });

  it('a stuck refresh is dropped: the next request reads again and loads the days', async () => {
    vi.useFakeTimers();
    const store = createDailyContentStore(
      { fingerprint: () => darts501Reads.daysFingerprint(), load: () => darts501Reads.loadDays() },
      indexed,
      { refreshMs: 30_000, now: () => Date.now(), log: silentLog, label: 'Darts 501' },
    );
    // First fingerprint hangs; after it, the database answers.
    db.withStatementTimeout
      .mockReturnValueOnce(never())
      .mockResolvedValueOnce([{ fingerprint: 'f1' }])
      .mockResolvedValueOnce([dayRow('2026-10-30')]);
    const first = store.get();
    const failed = expect(first).rejects.toBeInstanceOf(D501ContentUnavailableError);
    await vi.advanceTimersByTimeAsync(D501_READ_DEADLINE_MS);
    await failed;
    const days = await store.get();
    expect([...days.keys()]).toEqual(['2026-10-30']);
  });

  it('withDeadline passes a result through and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(5), 1_000, 'x')).resolves.toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withBoards', () => {
  const index = new Map(['2026-10-30', '2026-10-31'].map((d) => [d, indexed(dayRow(d))]));

  it('a footballer load that never settles leaves its days out instead of hanging, and is asked again next time', async () => {
    let healthy = false;
    const loadDirectory = vi.fn(() => (healthy ? Promise.resolve(directory) : never<typeof directory>()));
    const served = withBoards(async () => index, loadDirectory, async () => coverage, 20);
    const started = Date.now();
    expect((await served()).size).toBe(0);
    // Both days are hydrated together: one deadline, not one per day.
    expect(Date.now() - started).toBeLessThan(500);
    healthy = true;
    expect([...(await served()).keys()]).toEqual(['2026-10-30', '2026-10-31']);
    // Fully served: kept until the index changes.
    await served();
    expect(loadDirectory).toHaveBeenCalledTimes(4);
  });
});
