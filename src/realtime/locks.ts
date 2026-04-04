import { randomUUID } from 'crypto';
import { logger } from '../core/logger.js';
import { withSpan } from '../core/tracing.js';
import { getRedisClient } from './redis.js';

// Store tokens for local locks: key -> { token, timeout }
const localLocks = new Map<string, { token: string; timeout: NodeJS.Timeout }>();

// Lua script for atomic compare-and-delete
// Only deletes the key if the value matches the token
const RELEASE_LOCK_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  else
    return 0
  end
`;

export interface LockResult {
  acquired: boolean;
  token?: string;
}

/**
 * Acquire a distributed lock with a unique token.
 * Returns { acquired: true, token } on success, { acquired: false } on failure.
 * The token MUST be passed to releaseLock() to release the lock.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<LockResult> {
  return withSpan('redis.lock.acquire', {
    'quizball.lock_key': key,
    'quizball.lock_ttl_ms': ttlMs,
  }, async (span) => {
    const token = randomUUID();
    const client = getRedisClient();

    if (client && client.isOpen) {
      span.setAttribute('quizball.lock_backend', 'redis');
      const result = await client.set(key, token, { NX: true, PX: ttlMs });
      const acquired = result === 'OK';
      span.setAttribute('quizball.lock_acquired', acquired);
      if (acquired) {
        return { acquired: true, token };
      }
      return { acquired: false };
    }

    span.setAttribute('quizball.lock_backend', 'local');
    if (localLocks.has(key)) {
      span.setAttribute('quizball.lock_acquired', false);
      return { acquired: false };
    }

    const timeout = setTimeout(() => localLocks.delete(key), ttlMs);
    localLocks.set(key, { token, timeout });
    span.setAttribute('quizball.lock_acquired', true);
    return { acquired: true, token };
  });
}

/**
 * Release a lock only if we own it (token matches).
 * This prevents accidentally releasing another process's lock.
 */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  return withSpan('redis.lock.release', {
    'quizball.lock_key': key,
  }, async (span) => {
    const client = getRedisClient();

    if (client && client.isOpen) {
      span.setAttribute('quizball.lock_backend', 'redis');
      if (typeof client.eval !== 'function') {
        logger.warn({ key }, 'Redis client missing eval; skipping lock release');
        return false;
      }
      const result = await client.eval(RELEASE_LOCK_SCRIPT, {
        keys: [key],
        arguments: [token],
      });
      const released = result === 1;
      span.setAttribute('quizball.lock_released', released);
      return released;
    }

    span.setAttribute('quizball.lock_backend', 'local');
    const lock = localLocks.get(key);
    const released = Boolean(lock && lock.token === token);
    span.setAttribute('quizball.lock_released', released);
    if (released && lock) {
      clearTimeout(lock.timeout);
      localLocks.delete(key);
      return true;
    }
    return false;
  });
}
