import { logger } from './logger.js';
import { getRedisClient } from '../realtime/redis.js';

const pendingLoads = new Map<string, Promise<unknown>>();

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

  const load = (async () => {
    const value = await loader();
    if (redis?.isOpen) {
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
