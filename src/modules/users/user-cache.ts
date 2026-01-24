import type { User } from '../../db/types.js';

/**
 * Simple in-memory cache for user lookups.
 * Reduces database calls on every authenticated request.
 */

interface CacheEntry {
  user: User;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 1000; // 60 seconds

export function getCacheKey(provider: string, subject: string): string {
  return `${provider}:${subject}`;
}

export function getCachedUser(provider: string, subject: string): User | null {
  const key = getCacheKey(provider, subject);
  const entry = cache.get(key);

  if (!entry) {
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.user;
}

export function setCachedUser(provider: string, subject: string, user: User): void {
  const key = getCacheKey(provider, subject);
  cache.set(key, { user, expiresAt: Date.now() + TTL_MS });
}

export function invalidateUser(provider: string, subject: string): void {
  cache.delete(getCacheKey(provider, subject));
}

export function clearCache(): void {
  cache.clear();
}
