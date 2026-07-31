/**
 * WL's single clock domain + fail-closed Redis access.
 *
 * Replica wall-clocks have skewed ~5.5s in prod; every WL timing decision
 * uses Redis TIME instead. WL never falls back to process-local behavior
 * when Redis is unavailable — callers get an error and the reconciler
 * retries later (fail closed, unlike the shared locks/scheduler fallbacks).
 */

import { getRedisClient } from '../../realtime/redis.js';

export class WlRedisUnavailableError extends Error {
  constructor(operation: string) {
    super(`WL requires Redis for ${operation}; failing closed`);
    this.name = 'WlRedisUnavailableError';
  }
}

export function wlRedis(): NonNullable<ReturnType<typeof getRedisClient>> {
  const redis = getRedisClient();
  if (!redis || !redis.isOpen) throw new WlRedisUnavailableError('this operation');
  return redis;
}

/** Redis server time in ms — the only clock WL trusts. */
export async function wlRedisNowMs(): Promise<number> {
  const redis = wlRedis();
  const time = await redis.time();
  return time.getTime();
}
