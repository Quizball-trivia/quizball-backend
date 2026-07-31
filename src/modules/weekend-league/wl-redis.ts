/**
 * WL's single clock domain + fail-closed Redis access.
 *
 * Replica wall-clocks have skewed ~5.5s in prod; every WL timing decision
 * uses Redis TIME instead. WL never falls back to process-local behavior
 * when Redis is unavailable — callers get an error and the reconciler
 * retries later (fail closed, unlike the shared locks/scheduler fallbacks).
 */

import { randomUUID } from 'node:crypto';
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

/**
 * Strict distributed lock — never falls back to process-local state (unlike
 * the shared locks.ts helper). Returns a token for fenced renewal/release,
 * or null when the lock is held elsewhere or Redis is unavailable.
 */
export async function wlAcquireStrictLock(key: string, ttlMs: number): Promise<string | null> {
  try {
    const redis = wlRedis();
    const token = randomUUID();
    const ok = await redis.set(key, token, { NX: true, PX: ttlMs });
    return ok === 'OK' ? token : null;
  } catch {
    return null;
  }
}

const RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

/** Fenced renewal: false = the lock was lost (stop working immediately). */
export async function wlRenewStrictLock(key: string, token: string, ttlMs: number): Promise<boolean> {
  try {
    const redis = wlRedis();
    const result = await redis.eval(RENEW_SCRIPT, { keys: [key], arguments: [token, String(ttlMs)] });
    return result === 1;
  } catch {
    return false;
  }
}

const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

export async function wlReleaseStrictLock(key: string, token: string): Promise<void> {
  try {
    const redis = wlRedis();
    await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
  } catch {
    // Lock expires by TTL.
  }
}
