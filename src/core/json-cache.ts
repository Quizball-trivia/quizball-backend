import { logger } from './logger.js';
import { getRedisClient } from '../realtime/redis.js';

const pendingLoads = new Map<string, Promise<unknown>>();
const invalidatedLoads = new WeakSet<Promise<unknown>>();

/**
 * Cache shared, JSON-serializable read models in Redis while coalescing cache
 * misses inside each replica. Redis is an optimization only: an unavailable
 * cache falls back to the live loader without changing endpoint behavior.
 */
export async function getOrLoadJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer.');
  }

  const redis = getRedisClient();
  if (redis?.isOpen) {
    try {
      const raw = await redis.get(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn({ err, key }, 'Shared JSON cache read failed');
    }
  }

  const pending = pendingLoads.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  let load!: Promise<T>;
  load = (async () => {
    const value = await loader();
    if (redis?.isOpen && !invalidatedLoads.has(load)) {
      try {
        await redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
      } catch (err) {
        logger.warn({ err, key }, 'Shared JSON cache write failed');
      }
    }
    return value;
  })();
  pendingLoads.set(key, load);
  try {
    return await load;
  } finally {
    if (pendingLoads.get(key) === load) pendingLoads.delete(key);
  }
}

/**
 * Remove exact shared-cache keys after a write changes their source data.
 * Pending in-process loads are forgotten too, so a request arriving after the
 * invalidation cannot attach to an older load that is still resolving.
 */
export async function deleteJsonCacheKeys(keys: string[]): Promise<void> {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) return;

  for (const key of uniqueKeys) {
    const pending = pendingLoads.get(key);
    if (pending) invalidatedLoads.add(pending);
    pendingLoads.delete(key);
  }

  const redis = getRedisClient();
  if (!redis?.isOpen) return;
  try {
    await redis.del(uniqueKeys);
  } catch (err) {
    logger.warn({ err, keys: uniqueKeys }, 'Shared JSON cache invalidation failed');
  }
}
