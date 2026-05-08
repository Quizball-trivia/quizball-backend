import { LRUCache } from 'lru-cache';
import type { RedisClientType } from 'redis';
import type { User } from '../../db/types.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../../realtime/redis.js';

/**
 * Pub/sub channel for cross-pod user-cache invalidation.
 * When a user is mutated (profile update, deletion request, etc.) on one pod,
 * we publish the user id here so every other pod clears its local cache copy.
 */
const USER_INVALIDATION_CHANNEL = 'user:invalidated';

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
  updateAgeOnGet: false, // Don't reset TTL - ensure stale roles/data expire
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
 * Local-only invalidation. Used by the cross-pod subscriber so we don't
 * republish messages that originated on a different pod.
 */
export function invalidateByUserIdLocal(userId: string): void {
  for (const [key, user] of cache.entries()) {
    if (user.id === userId) {
      cache.delete(key);
    }
  }
}

/**
 * Invalidate all cache entries for a given user ID across every pod.
 * Clears the local cache immediately, then best-effort publishes to Redis so
 * other pods clear their copies. A Redis outage degrades to local-only and
 * logs a warning; deletion / profile updates do not fail because pub/sub failed.
 */
export async function invalidateByUserId(userId: string): Promise<void> {
  invalidateByUserIdLocal(userId);

  const pub = getRedisClient();
  if (!pub) return;

  try {
    await pub.publish(USER_INVALIDATION_CHANNEL, userId);
  } catch (err) {
    logger.warn(
      { err, userId },
      'Failed to publish user-cache invalidation across pods (local cache cleared)'
    );
  }
}

/**
 * Subscribe to cross-pod cache invalidations. Called once at server boot.
 * The handler only clears the local cache — it must NOT call the publishing
 * variant, otherwise we'd loop a single invalidation through every pod forever.
 */
export async function subscribeToUserInvalidations(subClient: RedisClientType): Promise<void> {
  await subClient.subscribe(USER_INVALIDATION_CHANNEL, (userId) => {
    if (typeof userId === 'string' && userId.length > 0) {
      invalidateByUserIdLocal(userId);
    }
  });
  logger.info({ channel: USER_INVALIDATION_CHANNEL }, 'Subscribed to user cache invalidations');
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
