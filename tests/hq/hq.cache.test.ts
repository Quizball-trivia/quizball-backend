import { describe, expect, it, vi } from 'vitest';
import { ttlCache } from '../../src/modules/hq/hq.cache.js';

describe('ttlCache', () => {
  it('shares one computation between concurrent callers and reuses it until the TTL', async () => {
    let t = 0;
    const cache = ttlCache<string, number>(1000, () => t);
    const compute = vi.fn(async () => 42);
    const [a, b] = await Promise.all([cache.get('k', compute), cache.get('k', compute)]);
    expect([a, b]).toEqual([42, 42]);
    expect(compute).toHaveBeenCalledTimes(1);
    t = 999;
    await cache.get('k', compute);
    expect(compute).toHaveBeenCalledTimes(1);
    t = 1000;
    await cache.get('k', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const cache = ttlCache<string, number>(1000);
    await expect(cache.get('k', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await cache.get('k', async () => 7)).toBe(7);
  });

  it('a computation started before clear() never repopulates the cache or drops a newer one', async () => {
    const c = ttlCache<string, number>(60_000);
    let release!: (v: number) => void;
    const slow = c.get('k', () => new Promise<number>((r) => { release = r; }));
    c.clear();
    let calls = 0;
    const fresh = c.get('k', async () => { calls++; return 2; });
    release(1);
    expect(await slow).toBe(1);
    expect(await fresh).toBe(2);
    expect(await c.get('k', async () => { calls++; return 3; })).toBe(2);
    expect(calls).toBe(1);
  });
});

