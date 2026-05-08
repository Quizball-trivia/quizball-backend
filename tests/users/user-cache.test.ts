import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const publishMock = vi.fn();
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

beforeEach(() => {
  publishMock.mockReset();
  getRedisClientMock.mockReset();
});

afterEach(async () => {
  // Reset module so the in-memory cache is fresh for each test.
  vi.resetModules();
});

async function loadCache() {
  const mod = await import('../../src/modules/users/user-cache.js');
  mod.clearCache();
  return mod;
}

describe('user-cache invalidateByUserIdLocal', () => {
  it('clears matching entries and only those entries', async () => {
    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);
    cache.setCachedUser('supabase', 'sub-b', MOCK_USER_B);

    cache.invalidateByUserIdLocal('user-a');

    expect(cache.getCachedUser('supabase', 'sub-a')).toBeNull();
    expect(cache.getCachedUser('supabase', 'sub-b')).toEqual(MOCK_USER_B);
  });

  it('is a no-op when no entry matches', async () => {
    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-b', MOCK_USER_B);

    cache.invalidateByUserIdLocal('user-a');

    expect(cache.getCachedUser('supabase', 'sub-b')).toEqual(MOCK_USER_B);
  });
});

describe('user-cache invalidateByUserId', () => {
  it('clears local cache and publishes to Redis', async () => {
    publishMock.mockResolvedValue(1);
    getRedisClientMock.mockReturnValue({ publish: publishMock });

    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    await cache.invalidateByUserId('user-a');

    expect(cache.getCachedUser('supabase', 'sub-a')).toBeNull();
    expect(publishMock).toHaveBeenCalledWith('user:invalidated', 'user-a');
  });

  it('still clears local cache when Redis is unavailable', async () => {
    getRedisClientMock.mockReturnValue(null);

    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    await cache.invalidateByUserId('user-a');

    expect(cache.getCachedUser('supabase', 'sub-a')).toBeNull();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('does not throw when publish fails', async () => {
    publishMock.mockRejectedValue(new Error('redis is down'));
    getRedisClientMock.mockReturnValue({ publish: publishMock });

    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    await expect(cache.invalidateByUserId('user-a')).resolves.toBeUndefined();
    expect(cache.getCachedUser('supabase', 'sub-a')).toBeNull();
  });
});

describe('user-cache subscribeToUserInvalidations', () => {
  it('clears local cache when a userId is published over the channel', async () => {
    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    let registeredHandler: ((message: string) => void) | null = null;
    const subscribeMock = vi.fn(async (channel: string, handler: (message: string) => void) => {
      expect(channel).toBe('user:invalidated');
      registeredHandler = handler;
    });

    await cache.subscribeToUserInvalidations({ subscribe: subscribeMock } as never);
    expect(subscribeMock).toHaveBeenCalledOnce();
    expect(registeredHandler).toBeTypeOf('function');

    registeredHandler!('user-a');
    expect(cache.getCachedUser('supabase', 'sub-a')).toBeNull();
  });

  it('ignores empty messages', async () => {
    const cache = await loadCache();
    cache.setCachedUser('supabase', 'sub-a', MOCK_USER_A);

    let registeredHandler: ((message: string) => void) | null = null;
    await cache.subscribeToUserInvalidations({
      subscribe: vi.fn(async (_channel: string, handler: (m: string) => void) => {
        registeredHandler = handler;
      }),
    } as never);

    registeredHandler!('');
    expect(cache.getCachedUser('supabase', 'sub-a')).toEqual(MOCK_USER_A);
  });
});
