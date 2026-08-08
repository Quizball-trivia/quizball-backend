import { describe, it, expect, beforeEach } from 'vitest';
import { wlAnswerHotCacheInternals } from '../../src/modules/weekend-league/wl-live-engine.js';

const { hotLoad, caches, inflight } = wlAnswerHotCacheInternals;

describe('wl answer hot-path cache', () => {
  beforeEach(() => {
    caches.runHotCache.clear();
    caches.contentHotCache.clear();
    caches.participantHotCache.clear();
    inflight.clear();
  });

  it('coalesces a concurrent stampede into one loader call per key', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Set(['u1', 'u2']);
    };
    const results = await Promise.all(
      Array.from({ length: 200 }, () =>
        hotLoad(caches.participantHotCache, 'roster', 't1:0', loader, (s) => s.size > 0))
    );
    expect(calls).toBe(1);
    for (const r of results) expect(r?.has('u1')).toBe(true);
    // Warm path: no further loader calls.
    await hotLoad(caches.participantHotCache, 'roster', 't1:0', loader, (s) => s.size > 0);
    expect(calls).toBe(1);
  });

  it('loads per key independently and one roster query per game', async () => {
    const callsPerKey = new Map<string, number>();
    const mk = (key: string) => async () => {
      callsPerKey.set(key, (callsPerKey.get(key) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 5));
      return new Set([key]);
    };
    await Promise.all(
      ['t1:0', 't1:1', 't2:0'].flatMap((key) =>
        Array.from({ length: 50 }, () =>
          hotLoad(caches.participantHotCache, 'roster', key, mk(key), (s) => s.size > 0)))
    );
    expect([...callsPerKey.values()]).toEqual([1, 1, 1]);
  });

  it('does not cache values the predicate rejects, and reloads next time', async () => {
    let calls = 0;
    const empty = async () => { calls += 1; return new Set<string>(); };
    const first = await hotLoad(caches.participantHotCache, 'roster', 't3:0', empty, (s) => s.size > 0);
    expect(first?.size).toBe(0);
    await hotLoad(caches.participantHotCache, 'roster', 't3:0', empty, (s) => s.size > 0);
    expect(calls).toBe(2);
  });

  it('propagates loader failure to all waiters and clears the in-flight slot', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('db down');
    };
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        hotLoad(caches.participantHotCache, 'roster', 't4:0', failing, () => true))
    );
    expect(calls).toBe(1);
    expect(attempts.every((a) => a.status === 'rejected')).toBe(true);
    // The failed slot must not wedge the key: a later call loads again.
    const ok = await hotLoad(
      caches.participantHotCache, 'roster', 't4:0',
      async () => new Set(['u9']), (s) => s.size > 0
    );
    expect(ok?.has('u9')).toBe(true);
    expect(inflight.size).toBe(0);
  });
});
