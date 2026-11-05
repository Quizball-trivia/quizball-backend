import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A query that never answers (a lock wait, a lost connection): what production's Darts 501 reads did after launch.
const db = vi.hoisted(() => ({ withStatementTimeout: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn(async () => []), withStatementTimeout: db.withStatementTimeout }));

import { createDailyContentStore } from '../../src/modules/daily/daily.content.js';
import { D501_READ_DEADLINE_MS, D501_READ_STATEMENT_MS, D501ContentUnavailableError, d501ReadStuck, darts501Reads, withDeadline } from '../../src/modules/darts501-daily/darts501-daily.reads.js';
import { withBoards } from '../../src/modules/darts501-daily/darts501-daily.service.js';
import { category, coverage, directory } from './fixture.js';

const never = <T>() => new Promise<T>(() => undefined);
/** A read that hangs until the test lets it answer (abandoned reads are tracked per name, so each test settles its own). */
function hanging() {
  let settle: (rows: unknown[]) => void = () => undefined;
  const promise = new Promise<unknown[]>((resolve) => { settle = resolve; });
  return { promise, settle: (rows: unknown[] = []) => settle(rows) };
}
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
    const stuck = hanging();
    db.withStatementTimeout.mockReturnValueOnce(stuck.promise);
    const read = darts501Reads.loadDays();
    const outcome = expect(read).rejects.toBeInstanceOf(D501ContentUnavailableError);
    await vi.advanceTimersByTimeAsync(D501_READ_DEADLINE_MS);
    await outcome;
    await expect(read).rejects.toMatchObject({ statusCode: 503, details: { reason: 'darts501_content_unavailable' } });
    stuck.settle();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a stuck refresh is dropped: requests fail fast while it still runs, then read again and load the days', async () => {
    vi.useFakeTimers();
    const store = createDailyContentStore(
      { fingerprint: () => darts501Reads.daysFingerprint(), load: () => darts501Reads.loadDays() },
      indexed,
      { refreshMs: 30_000, now: () => Date.now(), log: silentLog, label: 'Darts 501' },
    );
    // First fingerprint hangs; after it, the database answers.
    const stuck = hanging();
    db.withStatementTimeout
      .mockReturnValueOnce(stuck.promise)
      .mockResolvedValueOnce([{ fingerprint: 'f1' }])
      .mockResolvedValueOnce([dayRow('2026-10-30')]);
    const first = store.get();
    const failed = expect(first).rejects.toBeInstanceOf(D501ContentUnavailableError);
    await vi.advanceTimersByTimeAsync(D501_READ_DEADLINE_MS);
    await failed;
    // Not a hang: an immediate 503 while the abandoned read still holds its connection.
    await expect(store.get()).rejects.toBeInstanceOf(D501ContentUnavailableError);
    expect(db.withStatementTimeout).toHaveBeenCalledTimes(1);
    stuck.settle();
    await vi.advanceTimersByTimeAsync(0);
    const days = await store.get();
    expect([...days.keys()]).toEqual(['2026-10-30']);
  });

  it('an abandoned read keeps the same read from starting again until it settles (no pile-up on the admission budget)', async () => {
    vi.useFakeTimers();
    let settle: (rows: unknown[]) => void = () => undefined;
    db.withStatementTimeout.mockReturnValueOnce(new Promise((resolve) => { settle = resolve; }));
    const first = darts501Reads.roomPairs();
    const failed = expect(first).rejects.toBeInstanceOf(D501ContentUnavailableError);
    await vi.advanceTimersByTimeAsync(D501_READ_DEADLINE_MS);
    await failed;
    expect(d501ReadStuck('room pairs')).toBe(true);
    // Refused at once with the same 503, without a second database call.
    await expect(darts501Reads.roomPairs()).rejects.toBeInstanceOf(D501ContentUnavailableError);
    expect(db.withStatementTimeout).toHaveBeenCalledTimes(1);
    // Other reads are not held up by it.
    db.withStatementTimeout.mockResolvedValueOnce([{ fingerprint: 'f' }]);
    await expect(darts501Reads.daysFingerprint()).resolves.toBe('f');
    // Once the abandoned read settles, the read runs again.
    settle([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(d501ReadStuck('room pairs')).toBe(false);
    db.withStatementTimeout.mockResolvedValueOnce([{ release: 'r', coverage: 'c' }]);
    await expect(darts501Reads.roomPairs()).resolves.toEqual([{ release: 'r', coverage: 'c' }]);
  });

  it('withDeadline passes a result through and clears its timer', async () => {
    vi.useFakeTimers();
    await expect(withDeadline(Promise.resolve(5), 1_000, 'x')).resolves.toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withBoards', () => {
  const index = new Map(['2026-10-30', '2026-10-31'].map((d) => [d, indexed(dayRow(d))]));

  const today = () => '2026-10-31';

  it("a footballer load that never settles is a retryable 503 for today instead of a hang, and is asked again next time", async () => {
    let healthy = false;
    const loadDirectory = vi.fn(() => (healthy ? Promise.resolve(directory) : never<typeof directory>()));
    const served = withBoards(async () => index, loadDirectory, async () => coverage, 20, today);
    const started = Date.now();
    await expect(served()).rejects.toMatchObject({ statusCode: 503, details: { reason: 'darts501_content_unavailable' } });
    // Both days are hydrated together: one deadline, not one per day.
    expect(Date.now() - started).toBeLessThan(500);
    healthy = true;
    expect([...(await served()).keys()]).toEqual(['2026-10-30', '2026-10-31']);
    // Fully served: kept until the index changes.
    await served();
    expect(loadDirectory).toHaveBeenCalledTimes(4);
  });

  const perDay = new Map([...index].map(([d, day]) => [d, { ...day, category: { ...day.category, coverage: `c-${d}` } }]));

  it("never serves an index without today: today's coverage failing is a 503 (retried), then recovers", async () => {
    let broken = true;
    const loadCoverage = vi.fn((id: string) => (broken && id === 'c-2026-10-31' ? Promise.reject(new Error('down')) : Promise.resolve(coverage)));
    const served = withBoards(async () => perDay, async () => directory, loadCoverage, 20, today);
    await expect(served()).rejects.toMatchObject({ statusCode: 503, details: { reason: 'darts501_content_unavailable' } });
    broken = false;
    expect([...(await served()).keys()]).toEqual(['2026-10-30', '2026-10-31']);
  });

  it('another bad day is left out and never takes the healthy days down', async () => {
    const loadCoverage = vi.fn((id: string) => (id === 'c-2026-10-30' ? Promise.reject(new Error('gone')) : Promise.resolve(coverage)));
    const served = withBoards(async () => perDay, async () => directory, loadCoverage, 20, today);
    expect([...(await served()).keys()]).toEqual(['2026-10-31']);
    // Not kept as complete: the bad day is asked again next time.
    await served();
    expect(loadCoverage.mock.calls.filter(([id]) => id === 'c-2026-10-30')).toHaveLength(2);
  });
});
