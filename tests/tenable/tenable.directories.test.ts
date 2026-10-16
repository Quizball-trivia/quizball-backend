import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: 0, fail: true }));
vi.mock('../../src/db/index.js', () => ({
  sql: () => { db.calls += 1; return db.fail ? Promise.reject(new Error('db down')) : Promise.resolve([{ eid: 'n1', name: 'Northgate', known: 'Northgate', fame: 50, aliases: [], qualifier: null }]); },
}));

const { tenableDirectories, FAILED_RETRY_MS } = await import('../../src/modules/tenable/tenable.directories.js');
const { withDirectories } = await import('../../src/modules/tenable-daily/tenable-daily.service.js');

describe('tenable directories under a failing database', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); db.calls = 0; db.fail = true; tenableDirectories.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a failed load is answered with its error for a while, then the database is asked again', async () => {
    await expect(tenableDirectories.get('club', 'r1')).rejects.toThrow('db down');
    await expect(tenableDirectories.get('club', 'r1')).rejects.toThrow('db down');
    expect(db.calls).toBe(1);
    db.fail = false;
    vi.advanceTimersByTime(FAILED_RETRY_MS + 1);
    expect((await tenableDirectories.get('club', 'r1')).size).toBe(1);
    expect(db.calls).toBe(2);
  });

  it('days that share a release ask for it once per pass, even when it fails', async () => {
    const load = vi.fn(() => Promise.reject(new Error('down')));
    const days = new Map(Array.from({ length: 116 }, (_, i) => [`d${i}`, { day: `d${i}`, number: i, contentVersion: 1, list: { kind: 'club', release: 'r1' } }]));
    const served = await withDirectories(async () => days as never, load as never)();
    expect(served.size).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
