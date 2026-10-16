import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ calls: 0, fail: true }));
vi.mock('../../src/db/index.js', () => ({
  sql: () => { db.calls += 1; return db.fail ? Promise.reject(new Error('db down')) : Promise.resolve([{ eid: 'n1', name: 'Northgate', known: 'Northgate', fame: 50, aliases: [], qualifier: null }]); },
}));

const { tenableDirectories, FAILED_RETRY_MS, MAX_EXTRA } = await import('../../src/modules/tenable/tenable.directories.js');
const { withDirectories, oneAtATime } = await import('../../src/modules/tenable-daily/tenable-daily.service.js');

describe('tenable directories', () => {
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

  it('what is in use is never evicted; other directories are kept up to MAX_EXTRA, least recently used out first', async () => {
    db.fail = false;
    const inUse = Array.from({ length: 6 }, (_, i) => ({ kind: 'club' as const, release: `in-use-${i}` }));
    tenableDirectories.pin(inUse);
    await tenableDirectories.warm(inUse);
    for (let i = 0; i < MAX_EXTRA + 3; i += 1) await tenableDirectories.get('manager', `extra-${i}`);
    expect(inUse.every((p) => tenableDirectories.loaded(p.kind, p.release))).toBe(true);
    const extras = Array.from({ length: MAX_EXTRA + 3 }, (_, i) => tenableDirectories.loaded('manager', `extra-${i}`));
    expect(extras).toEqual([false, false, false, ...Array(MAX_EXTRA).fill(true)]);
    // Unpinned (it left the pool), it is an ordinary extra again and goes first.
    tenableDirectories.pin(inUse.slice(1));
    expect(tenableDirectories.loaded('club', 'in-use-0')).toBe(false);
    expect(inUse.slice(1).every((p) => tenableDirectories.loaded(p.kind, p.release))).toBe(true);
  });

  it('an extra used again moves to the back of the eviction queue', async () => {
    db.fail = false;
    tenableDirectories.pin([]);
    for (let i = 0; i < MAX_EXTRA; i += 1) await tenableDirectories.get('manager', `lru-${i}`);
    await tenableDirectories.get('manager', 'lru-0');
    await tenableDirectories.get('manager', 'lru-new');
    expect(tenableDirectories.loaded('manager', 'lru-0')).toBe(true);
    expect(tenableDirectories.loaded('manager', 'lru-1')).toBe(false);
  });

  it('the keeper never runs twice at once (a slow run cannot overwrite a newer one)', async () => {
    let release: () => void = () => undefined;
    const fn = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const run = oneAtATime(fn);
    const first = run();
    expect(run()).toBeNull();
    release();
    await first;
    expect(run()).not.toBeNull();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
