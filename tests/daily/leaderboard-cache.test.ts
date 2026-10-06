import { describe, expect, it, vi } from 'vitest';
import { createLeaderboardCache } from '../../src/modules/daily/leaderboard-cache.js';

const board = (players: number) => ({ players, top: [{ score: players }] });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('public leaderboard cache', () => {
  it('shares a cold query across 200 simultaneous readers, and expires by completion time', async () => {
    let now = 0;
    const pending = deferred<ReturnType<typeof board>>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(board(2));
    const cache = createLeaderboardCache(load, 1000, () => now);
    const requests = Array.from({ length: 200 }, () => cache.get('day'));
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    now = 500;
    pending.resolve(board(1));
    expect((await Promise.all(requests)).every((value) => value.players === 1)).toBe(true);
    now = 1500;
    expect(await cache.get('day')).toEqual(board(1));
    now = 1501;
    expect(await cache.get('day')).toEqual(board(2));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a completion invalidates an in-flight board without letting its late result overwrite the new one', async () => {
    const pending = deferred<ReturnType<typeof board>>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(board(2));
    const cache = createLeaderboardCache(load, 1000, () => 0);
    const old = cache.get('day');
    await Promise.resolve();
    cache.delete('day');
    expect(await cache.get('day')).toEqual(board(2));
    pending.resolve(board(1));
    expect(await old).toEqual(board(1));
    expect(await cache.get('day')).toEqual(board(2));
  });

  it('a failed refresh rejects its callers and can be retried', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(board(1));
    const cache = createLeaderboardCache(load, 1000, () => 0);
    const requests = [cache.get('day'), cache.get('day')];
    expect((await Promise.allSettled(requests)).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await cache.get('day')).toEqual(board(1));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('different days have separate query and invalidation state', async () => {
    const load = vi.fn().mockResolvedValue(board(1));
    const cache = createLeaderboardCache(load, 1000, () => 0);
    await Promise.all([cache.get('a'), cache.get('b')]);
    cache.delete('a');
    await Promise.all([cache.get('a'), cache.get('b')]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  // Review 2026-10-06 (P2): a load that never settles used to pin every later reader of that day forever; round 2: a
  // timed-out reader must not leave the query running while later readers start more of them (each holds DB capacity).
  describe('a hung load', () => {
    const fake = async (run: () => Promise<void>) => {
      vi.useFakeTimers();
      try { await run(); } finally { vi.useRealTimers(); }
    };

    it('releases its readers after the deadline; later readers share the same running query instead of starting more', () => fake(async () => {
      let now = 0;
      const load = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(board(5));
      const cache = createLeaderboardCache(load, 1000, () => now, { loadTimeoutMs: 5_000, abandonAfterMs: 30_000 });
      for (let i = 0; i < 4; i += 1) {
        const reader = cache.get('day').then(() => 'resolved', () => 'rejected');
        await vi.advanceTimersByTimeAsync(5_001);
        now += 5_001;
        expect(await reader).toBe('rejected');
      }
      expect(load).toHaveBeenCalledTimes(1);
    }));

    it('a load still unsettled past the abandon age (dead transport) is replaced, at most once per abandon period', () => fake(async () => {
      let now = 0;
      const load = vi.fn().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(board(5));
      const cache = createLeaderboardCache(load, 1000, () => now, { loadTimeoutMs: 5_000, abandonAfterMs: 30_000 });
      void cache.get('day').catch(() => {});
      now = 30_001;
      expect(await cache.get('day')).toEqual(board(5));
      expect(load).toHaveBeenCalledTimes(2);
    }));

    it('serves the last good (stale) board instead of failing when its refresh hangs', () => fake(async () => {
      let now = 0;
      const load = vi.fn().mockResolvedValueOnce(board(1)).mockReturnValueOnce(new Promise(() => {}));
      const cache = createLeaderboardCache(load, 1000, () => now, { loadTimeoutMs: 5_000 });
      expect(await cache.get('day')).toEqual(board(1));
      now = 2_000;
      const refreshing = cache.get('day');
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await refreshing).toEqual(board(1));
    }));

    it("a replaced load's late result never overwrites the newer board", () => fake(async () => {
      let now = 0;
      const late = deferred<ReturnType<typeof board>>();
      const load = vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(board(5));
      const cache = createLeaderboardCache(load, 60_000, () => now, { loadTimeoutMs: 5_000, abandonAfterMs: 30_000 });
      void cache.get('day').catch(() => {});
      now = 30_001;
      expect(await cache.get('day')).toEqual(board(5));
      late.resolve(board(9));
      await Promise.resolve();
      expect(await cache.get('day')).toEqual(board(5));
    }));

    it('repeated completions during a stall never run more than two queries for a day at once', () => fake(async () => {
      const load = vi.fn(() => new Promise<ReturnType<typeof board>>(() => {}));
      const cache = createLeaderboardCache(load, 1000, () => 0, { loadTimeoutMs: 5_000, abandonAfterMs: 30_000 });
      for (let i = 0; i < 5; i += 1) {
        void cache.get('day').catch(() => {});
        cache.delete('day');
      }
      void cache.get('day').catch(() => {});
      await vi.advanceTimersByTimeAsync(5_001);
      expect(load).toHaveBeenCalledTimes(2);
    }));
  });
});
