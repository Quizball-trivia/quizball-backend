import { beforeEach, describe, expect, it, vi } from 'vitest';

const redis = {
  isOpen: true,
  get: vi.fn(),
  set: vi.fn(),
};

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import { getOrLoadJson } from '../../src/core/json-cache.js';

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
});
