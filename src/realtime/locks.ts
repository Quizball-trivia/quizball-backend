import { randomUUID } from 'crypto';
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
  const token = randomUUID();
  const client = getRedisClient();

  if (client && client.isOpen) {
    const result = await client.set(key, token, { NX: true, PX: ttlMs });
    if (result === 'OK') {
      return { acquired: true, token };
    }
    return { acquired: false };
  }

  // Fallback to local locks (single instance mode)
  if (localLocks.has(key)) {
    return { acquired: false };
  }

  const timeout = setTimeout(() => localLocks.delete(key), ttlMs);
  localLocks.set(key, { token, timeout });
  return { acquired: true, token };
}

/**
 * Release a lock only if we own it (token matches).
 * This prevents accidentally releasing another process's lock.
 */
export async function releaseLock(key: string, token: string): Promise<boolean> {
  const client = getRedisClient();

  if (client && client.isOpen) {
    if (typeof client.eval !== 'function') {
      // Test/mocked Redis clients may not implement eval; keep a safe fallback.
      const currentToken = await client.get(key);
      if (currentToken !== token) {
        return false;
      }
      await client.del(key);
      return true;
    }
    // Atomic compare-and-delete using Lua script
    const result = await client.eval(RELEASE_LOCK_SCRIPT, {
      keys: [key],
      arguments: [token],
    });
    return result === 1;
  }

  // Fallback to local locks
  const lock = localLocks.get(key);
  if (lock && lock.token === token) {
    clearTimeout(lock.timeout);
    localLocks.delete(key);
    return true;
  }
  return false;
}
