import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCacheKey,
  getCachedUser,
  setCachedUser,
  invalidateUser,
  clearCache,
} from '../../src/modules/users/user-cache.js';
import type { User } from '../../src/db/types.js';
import '../setup.js';

const mockUser: User = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  email: 'test@example.com',
  nickname: 'testuser',
  country: 'US',
  avatar_url: null,
  role: 'user',
  onboarding_complete: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe('User Cache', () => {
  beforeEach(() => {
    clearCache();
  });

  describe('getCacheKey', () => {
    it('should generate correct cache key from provider and subject', () => {
      const key = getCacheKey('google', 'user-123');
      expect(key).toBe('["google","user-123"]');
    });

    it('should handle special characters in subject', () => {
      const key = getCacheKey('apple', 'user@email.com');
      expect(key).toBe('["apple","user@email.com"]');
    });
  });

  describe('setCachedUser and getCachedUser', () => {
    it('should store and retrieve user from cache', () => {
      setCachedUser('google', 'user-123', mockUser);

      const cachedUser = getCachedUser('google', 'user-123');

      expect(cachedUser).toEqual(mockUser);
    });

    it('should return null for non-existent cache entry', () => {
      const cachedUser = getCachedUser('google', 'non-existent');

      expect(cachedUser).toBeNull();
    });

    it('should store different users for different providers', () => {
      const googleUser = { ...mockUser, id: 'google-user-id' };
      const appleUser = { ...mockUser, id: 'apple-user-id' };

      setCachedUser('google', 'user-123', googleUser);
      setCachedUser('apple', 'user-123', appleUser);

      expect(getCachedUser('google', 'user-123')?.id).toBe('google-user-id');
      expect(getCachedUser('apple', 'user-123')?.id).toBe('apple-user-id');
    });

    it('should overwrite existing cache entry for same key', () => {
      const updatedUser = { ...mockUser, nickname: 'updated-nickname' };

      setCachedUser('google', 'user-123', mockUser);
      setCachedUser('google', 'user-123', updatedUser);

      const cachedUser = getCachedUser('google', 'user-123');
      expect(cachedUser?.nickname).toBe('updated-nickname');
    });
  });

  // Note: TTL behavior is handled by lru-cache internally.
  // We don't test TTL expiration directly since lru-cache is well-tested
  // and mocking its internal clock requires complex setup.

  describe('invalidateUser', () => {
    it('should remove user from cache', () => {
      setCachedUser('google', 'user-123', mockUser);

      invalidateUser('google', 'user-123');

      const cachedUser = getCachedUser('google', 'user-123');
      expect(cachedUser).toBeNull();
    });

    it('should not throw when invalidating non-existent entry', () => {
      expect(() => {
        invalidateUser('google', 'non-existent');
      }).not.toThrow();
    });

    it('should only invalidate specific user', () => {
      setCachedUser('google', 'user-1', mockUser);
      setCachedUser('google', 'user-2', { ...mockUser, id: 'user-2' });

      invalidateUser('google', 'user-1');

      expect(getCachedUser('google', 'user-1')).toBeNull();
      expect(getCachedUser('google', 'user-2')).not.toBeNull();
    });
  });

  describe('clearCache', () => {
    it('should remove all entries from cache', () => {
      setCachedUser('google', 'user-1', mockUser);
      setCachedUser('apple', 'user-2', { ...mockUser, id: 'user-2' });
      setCachedUser('github', 'user-3', { ...mockUser, id: 'user-3' });

      clearCache();

      expect(getCachedUser('google', 'user-1')).toBeNull();
      expect(getCachedUser('apple', 'user-2')).toBeNull();
      expect(getCachedUser('github', 'user-3')).toBeNull();
    });
  });
});
