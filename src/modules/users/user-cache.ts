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

export function clearCache(): void {
  cache.clear();
}
