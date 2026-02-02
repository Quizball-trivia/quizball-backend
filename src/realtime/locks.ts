import { getRedisClient } from './redis.js';

const localLocks = new Map<string, NodeJS.Timeout>();

export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  const client = getRedisClient();
  if (client && client.isOpen) {
    const result = await client.set(key, '1', { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  if (localLocks.has(key)) return false;
  const timeout = setTimeout(() => localLocks.delete(key), ttlMs);
  localLocks.set(key, timeout);
  return true;
}

export async function releaseLock(key: string): Promise<void> {
  const client = getRedisClient();
  if (client && client.isOpen) {
    await client.del(key);
    return;
  }
  const timeout = localLocks.get(key);
  if (timeout) {
    clearTimeout(timeout);
    localLocks.delete(key);
  }
}
