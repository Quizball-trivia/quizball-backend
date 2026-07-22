import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = {
  isOpen: true,
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
};

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import { deleteJsonCacheKeys, getOrLoadJson } from '../../src/core/json-cache.js';

describe('getOrLoadJson', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.isOpen = true;
  });

  it('returns a Redis hit without calling the loader', async () => {
    redis.get.mockResolvedValue(JSON.stringify([{ id: 'cached' }]));
    const loader = vi.fn();

    await expect(getOrLoadJson('key:hit', 5, loader)).resolves.toEqual([{ id: 'cached' }]);
    expect(loader).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('coalesces concurrent misses and stores one shared result', async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    let release!: (value: { id: string }) => void;
    const loader = vi.fn(() => new Promise<{ id: string }>((resolve) => { release = resolve; }));

    const first = getOrLoadJson('key:miss', 30, loader);
    const second = getOrLoadJson('key:miss', 30, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    release({ id: 'fresh' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: 'fresh' },
      { id: 'fresh' },
    ]);
    expect(redis.set).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledWith('key:miss', JSON.stringify({ id: 'fresh' }), { EX: 30 });
  });

  it('falls back to the loader when Redis is unavailable', async () => {
    redis.isOpen = false;
    const loader = vi.fn().mockResolvedValue(42);

    await expect(getOrLoadJson('key:fallback', 5, loader)).resolves.toBe(42);
    expect(loader).toHaveBeenCalledOnce();
  });

  it('deletes unique exact keys from the shared cache', async () => {
    redis.del.mockResolvedValue(2);

    await deleteJsonCacheKeys(['rank:global:u-1', 'rank:country:US:u-1', 'rank:global:u-1']);

    expect(redis.del).toHaveBeenCalledOnce();
    expect(redis.del).toHaveBeenCalledWith(['rank:global:u-1', 'rank:country:US:u-1']);
  });

  it('does not repopulate a key from a load invalidated while it was resolving', async () => {
    redis.get.mockResolvedValue(null);
    redis.del.mockResolvedValue(1);
    let release!: (value: { rank: number }) => void;
    const loader = vi.fn(() => new Promise<{ rank: number }>((resolve) => { release = resolve; }));

    const pending = getOrLoadJson('rank:global:u-racing', 300, loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    await deleteJsonCacheKeys(['rank:global:u-racing']);
    release({ rank: 4 });

    await expect(pending).resolves.toEqual({ rank: 4 });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('treats cache invalidation as a no-op when Redis is unavailable', async () => {
    redis.isOpen = false;

    await expect(deleteJsonCacheKeys(['rank:global:u-1'])).resolves.toBeUndefined();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
