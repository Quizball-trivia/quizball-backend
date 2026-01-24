import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getCacheKey', () => {
    it('should generate correct cache key from provider and subject', () => {
      const key = getCacheKey('google', 'user-123');
      expect(key).toBe('google:user-123');
    });

    it('should handle special characters in subject', () => {
      const key = getCacheKey('apple', 'user@email.com');
      expect(key).toBe('apple:user@email.com');
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

  describe('Cache TTL (expiration)', () => {
    it('should return user before TTL expires', () => {
      setCachedUser('google', 'user-123', mockUser);

      // Advance time by 59 seconds (just under 60 second TTL)
      vi.advanceTimersByTime(59 * 1000);

      const cachedUser = getCachedUser('google', 'user-123');
      expect(cachedUser).toEqual(mockUser);
    });

    it('should return null after TTL expires', () => {
      setCachedUser('google', 'user-123', mockUser);

      // Advance time by 61 seconds (just over 60 second TTL)
      vi.advanceTimersByTime(61 * 1000);

      const cachedUser = getCachedUser('google', 'user-123');
      expect(cachedUser).toBeNull();
    });

    it('should delete expired entry from cache on access', () => {
      setCachedUser('google', 'user-123', mockUser);

      // Advance time past TTL
      vi.advanceTimersByTime(61 * 1000);

      // First access should return null and delete
      expect(getCachedUser('google', 'user-123')).toBeNull();

      // Set new user
      const newUser = { ...mockUser, nickname: 'new-user' };
      setCachedUser('google', 'user-123', newUser);

      // Should get new user, not old expired one
      expect(getCachedUser('google', 'user-123')?.nickname).toBe('new-user');
    });
  });

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
