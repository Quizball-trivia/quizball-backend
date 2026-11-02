import { afterEach, describe, expect, it, vi } from 'vitest';

// The first read never answers (a connection that stopped responding); later reads work.
const db = vi.hoisted(() => ({ calls: 0, hang: true, settle: null as null | ((rows: unknown[]) => void) }));
vi.mock('../../src/db/index.js', () => ({
  sql: () => {
    db.calls += 1;
    if (db.hang) return new Promise((resolve) => { db.settle = resolve; });
    return Promise.resolve([{ eid: 'n1', name: 'Northgate', known: 'Northgate', fame: 50, aliases: [], qualifier: null }]);
  },
}));
vi.mock('../../src/modules/tenable/tenable.russian.js', () => ({ russianPinOf: async () => null, russianRows: async () => null }));
vi.mock('../../src/modules/tenable/tenable.aliases.js', () => ({ ALIAS_KINDS: new Set(), aliasPinsOf: async () => [], withAliases: async (_db: unknown, _kind: unknown, entities: unknown[]) => [...entities] }));

const { tenableDirectories, FAILED_RETRY_MS, LOAD_DEADLINE_MS } = await import('../../src/modules/tenable/tenable.directories.js');

afterEach(() => { vi.useRealTimers(); });

describe('a directory load that never settles', () => {
  it('fails at the deadline, starts no second load while it still runs, and loads again once it has settled', async () => {
    vi.useFakeTimers();
    tenableDirectories.clear();
    const first = tenableDirectories.get('club', 'pinned');
    const failed = expect(first).rejects.toThrow('tenable_directory_load_timeout:club:pinned');
    await vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS);
    await failed;
    // The cached promise is gone (a later call is not stuck behind it) ...
    expect(tenableDirectories.loaded('club', 'pinned')).toBe(false);
    // ... but while the abandoned read still holds its connection, no second read is started.
    db.hang = false;
    await vi.advanceTimersByTimeAsync(FAILED_RETRY_MS + 1);
    await expect(tenableDirectories.get('club', 'pinned')).rejects.toThrow('tenable_directory_load_timeout');
    expect(db.calls).toBe(1);
    // The abandoned read finally answers: the release loads on the next try.
    db.settle?.([]);
    await vi.advanceTimersByTimeAsync(FAILED_RETRY_MS + 1);
    expect((await tenableDirectories.get('club', 'pinned')).size).toBe(1);
    expect(db.calls).toBe(2);
  });
});
