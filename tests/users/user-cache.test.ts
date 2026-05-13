import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getRedisClientMock = vi.fn();

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: (...args: unknown[]) => getRedisClientMock(...args),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const MOCK_USER_A = {
  id: 'user-a',
  email: 'a@test.com',
  nickname: 'Alice',
  avatar_url: null,
  avatar_customization: null,
  country: null,
  favorite_club: null,
  preferred_language: 'en',
  role: 'user',
  is_ai: false,
  onboarding_complete: true,
  total_xp: 0,
  is_deleted: false,
  deleted_at: null,
  deletion_requested_at: null,
  pending_deletion_at: null,
  created_at: '2024-01-01',
  updated_at: '2024-01-01',
};

const MOCK_USER_B = { ...MOCK_USER_A, id: 'user-b', email: 'b@test.com', nickname: 'Bob' };

class FakeRedis {
  isOpen = true;
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  expirations = new Map<string, number>();
  failNextGet = false;
  failNextSet = false;

  async get(key: string): Promise<string | null> {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('redis get failed');
    }
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { EX?: number }): Promise<string> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('redis set failed');
    }
    this.strings.set(key, value);
    if (options?.EX) {
      this.expirations.set(key, options.EX);
    }
    return 'OK';
  }

  async sAdd(key: string, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const sizeBefore = set.size;
    set.add(member);
    this.sets.set(key, set);
    return set.size - sizeBefore;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    this.expirations.set(key, seconds);
    return true;
  }

  async del(keys: string | string[]): Promise<number> {
    const keyList = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of keyList) {
      const removedFromStrings = this.strings.delete(key);
      const removedFromSets = this.sets.delete(key);
      if (removedFromStrings || removedFromSets) deleted += 1;
      this.expirations.delete(key);
    }
    return deleted;
  }

  async *scanIterator(): AsyncGenerator<string> {
    for (const key of [...this.strings.keys(), ...this.sets.keys()]) {
      if (key.startsWith('user-cache:')) {
        yield key;
      }
    }
  }
}

let redis: FakeRedis;

beforeEach(() => {
  redis = new FakeRedis();
  getRedisClientMock.mockReset();
  getRedisClientMock.mockReturnValue(redis);
});

afterEach(() => {
  vi.resetModules();
});

async function loadCache() {
  return import('../../src/modules/users/user-cache.js');
}

describe('Redis-backed user-cache', () => {
  it('stores and reads cached users', async () => {
    const cache = await loadCache();

    await cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toEqual(MOCK_USER_A);
  });

  it('returns null on cache miss', async () => {
    const cache = await loadCache();

    await expect(cache.getCachedUser('supabase', 'missing')).resolves.toBeNull();
  });

  it('returns null when Redis is unavailable', async () => {
    getRedisClientMock.mockReturnValue(null);
    const cache = await loadCache();

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toBeNull();
    await expect(cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A)).resolves.toBeUndefined();
  });

  it('returns null for malformed cached JSON', async () => {
    const cache = await loadCache();
    const key = cache.getCacheKey('supabase', 'sub-a');
    redis.strings.set(key, '{not-json');

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toBeNull();
  });

  it('does not throw on Redis command failures', async () => {
    const cache = await loadCache();
    redis.failNextGet = true;
    redis.failNextSet = true;

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toBeNull();
    await expect(cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A)).resolves.toBeUndefined();
  });

  it('invalidates one identity cache key', async () => {
    const cache = await loadCache();
    await cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);
    await cache.setCachedUser('supabase', 'sub-b', MOCK_USER_B);

    await cache.invalidateUser('supabase', 'sub-a');

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toBeNull();
    await expect(cache.getCachedUser('supabase', 'sub-b')).resolves.toEqual(MOCK_USER_B);
  });

  it('invalidates every cached identity for a user id', async () => {
    const cache = await loadCache();
    await cache.setCachedUser('supabase', 'sub-a-1', MOCK_USER_A);
    await cache.setCachedUser('google', 'sub-a-2', MOCK_USER_A);
    await cache.setCachedUser('supabase', 'sub-b', MOCK_USER_B);

    await cache.invalidateByUserId('user-a');

    await expect(cache.getCachedUser('supabase', 'sub-a-1')).resolves.toBeNull();
    await expect(cache.getCachedUser('google', 'sub-a-2')).resolves.toBeNull();
    await expect(cache.getCachedUser('supabase', 'sub-b')).resolves.toEqual(MOCK_USER_B);
  });

  it('updates every cached identity for a user id', async () => {
    const cache = await loadCache();
    await cache.setCachedUser('supabase', 'sub-a-1', MOCK_USER_A);
    await cache.setCachedUser('google', 'sub-a-2', MOCK_USER_A);

    const updated = { ...MOCK_USER_A, nickname: 'Captain Alice' };
    await cache.updateCachedUser('user-a', updated);

    await expect(cache.getCachedUser('supabase', 'sub-a-1')).resolves.toMatchObject({ nickname: 'Captain Alice' });
    await expect(cache.getCachedUser('google', 'sub-a-2')).resolves.toMatchObject({ nickname: 'Captain Alice' });
  });

  it('clears only user-cache keys', async () => {
    const cache = await loadCache();
    await cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);
    redis.strings.set('unrelated:key', 'value');

    await cache.clearCache();

    await expect(cache.getCachedUser('supabase', 'sub-a')).resolves.toBeNull();
    expect(redis.strings.get('unrelated:key')).toBe('value');
  });
});
