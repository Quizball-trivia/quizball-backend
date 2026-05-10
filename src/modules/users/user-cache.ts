import { createHash } from 'crypto';
import type { RedisClientType } from 'redis';
import type { User } from '../../db/types.js';
import { logger } from '../../core/logger.js';
import { getRedisClient } from '../../realtime/redis.js';

const USER_CACHE_TTL_SECONDS = 60;
const USER_CACHE_INDEX_TTL_SECONDS = 120;
const USER_CACHE_KEY_PREFIX = 'user-cache:identity:';
const USER_CACHE_INDEX_PREFIX = 'user-cache:user:';
const USER_CACHE_SCAN_PATTERN = 'user-cache:*';

export function getCacheKey(provider: string, subject: string): string {
  const identity = JSON.stringify([provider, subject]);
  return `${USER_CACHE_KEY_PREFIX}${createHash('sha256').update(identity).digest('hex')}`;
}

function getUserIndexKey(userId: string): string {
  return `${USER_CACHE_INDEX_PREFIX}${userId}:keys`;
}

function getRedis(): RedisClientType | null {
  const redis = getRedisClient();
  return redis?.isOpen ? redis : null;
}

function parseCachedUser(raw: string, key: string): User | null {
  try {
    const parsed = JSON.parse(raw) as Partial<User>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
      logger.warn({ key }, 'Ignoring malformed cached user payload');
      return null;
    }
    return parsed as User;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to parse cached user payload');
    return null;
  }
}

async function setUserAtKey(redis: RedisClientType, key: string, user: User): Promise<void> {
  await redis.set(key, JSON.stringify(user), { EX: USER_CACHE_TTL_SECONDS });
}

export async function getCachedUser(provider: string, subject: string): Promise<User | null> {
  const redis = getRedis();
  if (!redis) return null;

  const key = getCacheKey(provider, subject);
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return parseCachedUser(raw, key);
  } catch (err) {
    logger.warn({ err, key }, 'Failed to read user from Redis cache');
    return null;
  }
}

export async function setCachedUser(provider: string, subject: string, user: User): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = getCacheKey(provider, subject);
  const indexKey = getUserIndexKey(user.id);
  try {
    await setUserAtKey(redis, key, user);
    await redis.sAdd(indexKey, key);
    await redis.expire(indexKey, USER_CACHE_INDEX_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, key, userId: user.id }, 'Failed to write user to Redis cache');
  }
}

export async function invalidateUser(
  provider: string,
  subject: string,
  userId: string
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = getCacheKey(provider, subject);
  const indexKey = getUserIndexKey(userId);
  try {
    await redis.del(key);
    await redis.sRem(indexKey, key);
  } catch (err) {
    logger.warn({ err, key, userId }, 'Failed to invalidate user identity cache key');
  }
}

export async function invalidateByUserId(userId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const indexKey = getUserIndexKey(userId);
  try {
    const keys = await redis.sMembers(indexKey);
    if (keys.length > 0) {
      await redis.del(keys);
    }
    await redis.del(indexKey);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to invalidate Redis user cache entries');
  }
}

export async function updateCachedUser(userId: string, updatedUser: User): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const indexKey = getUserIndexKey(userId);
  try {
    const keys = await redis.sMembers(indexKey);
    if (keys.length === 0) return;

    await Promise.all(keys.map((key) => setUserAtKey(redis, key, updatedUser)));
    await redis.expire(indexKey, USER_CACHE_INDEX_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to update Redis user cache entries');
  }
}

export async function clearCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  try {
    const keys: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: USER_CACHE_SCAN_PATTERN, COUNT: 100 })) {
      keys.push(String(key));
    }
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clear Redis user cache');
  }
}
