import { LRUCache } from 'lru-cache';
import type { User } from '../../db/types.js';

/**
 * LRU cache for user lookups.
 * Reduces database calls on every authenticated request.
 * 
 * Features:
 * - Bounded size (max 1000 entries) with LRU eviction
 * - TTL-based expiration (60 seconds)
 * - Automatic cleanup of expired entries
 */

const cache = new LRUCache<string, User>({
  max: 1000,          // Maximum 1000 cached users
  ttl: 60 * 1000,     // 60 second TTL
  updateAgeOnGet: true, // Reset TTL on access (keep active users cached)
});

export function getCacheKey(provider: string, subject: string): string {
  // Use JSON array to avoid key collisions if provider/subject contain delimiters
  return JSON.stringify([provider, subject]);
}

export function getCachedUser(provider: string, subject: string): User | null {
  const key = getCacheKey(provider, subject);
  return cache.get(key) ?? null;
}

export function setCachedUser(provider: string, subject: string, user: User): void {
  const key = getCacheKey(provider, subject);
  cache.set(key, user);
}

export function invalidateUser(provider: string, subject: string): void {
  cache.delete(getCacheKey(provider, subject));
}

/**
 * Invalidate all cache entries for a given user ID.
 * Used when user data is mutated (profile update, onboarding completion).
 * Iterates through cache entries - acceptable since cache is bounded and mutations are infrequent.
 */
export function invalidateByUserId(userId: string): void {
  for (const [key, user] of cache.entries()) {
    if (user.id === userId) {
      cache.delete(key);
    }
  }
}

/**
 * Update cache entry for a user if it exists.
 * Used to refresh cached data after mutations.
 */
export function updateCachedUser(userId: string, updatedUser: User): void {
  for (const [key, user] of cache.entries()) {
    if (user.id === userId) {
      cache.set(key, updatedUser);
    }
  }
}

export function clearCache(): void {
  cache.clear();
}
