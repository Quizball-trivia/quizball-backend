import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory Redis stand-in capturing the last set value + TTL per key.
const store = new Map<string, string>();
const lastSet: { key?: string; value?: string; ttl?: number } = {};
let redisAvailable = true;
let getThrows = false;

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () =>
    redisAvailable
      ? {
          isOpen: true,
          set: (key: string, value: string, opts?: { EX?: number }) => {
            store.set(key, value);
            lastSet.key = key;
            lastSet.value = value;
            lastSet.ttl = opts?.EX;
            return Promise.resolve('OK');
          },
          get: (key: string) =>
            getThrows ? Promise.reject(new Error('redis down')) : Promise.resolve(store.get(key) ?? null),
        }
      : null,
}));

import { setUserPingMs, getUserPingMs } from '../../src/realtime/user-ping.js';

beforeEach(() => {
  store.clear();
  delete lastSet.key; delete lastSet.value; delete lastSet.ttl;
  redisAvailable = true;
  getThrows = false;
});

describe('user-ping store', () => {
  it('round-trips a reported RTT for a user', async () => {
    await setUserPingMs('user-1', 73);
    expect(await getUserPingMs('user-1')).toBe(73);
  });

  it('writes under the per-user key with a short TTL', async () => {
    await setUserPingMs('user-1', 50);
    expect(lastSet.key).toBe('user:ping_ms:user-1');
    expect(lastSet.ttl).toBe(90);
  });

  it('rounds and clamps absurd values (no 999999ms leaking to the opponent)', async () => {
    await setUserPingMs('user-1', 999999);
    expect(await getUserPingMs('user-1')).toBe(5000); // clamped to MAX
    await setUserPingMs('user-2', -20);
    expect(await getUserPingMs('user-2')).toBe(0); // clamped to MIN
    await setUserPingMs('user-3', 42.7);
    expect(await getUserPingMs('user-3')).toBe(43); // rounded
  });

  it('ignores non-finite reports', async () => {
    await setUserPingMs('user-1', Number.NaN);
    expect(await getUserPingMs('user-1')).toBeNull();
  });

  it('returns null for an unknown user', async () => {
    expect(await getUserPingMs('nobody')).toBeNull();
  });

  it('returns null (no throw) when Redis is unavailable', async () => {
    redisAvailable = false;
    await expect(setUserPingMs('user-1', 50)).resolves.toBeUndefined();
    expect(await getUserPingMs('user-1')).toBeNull();
  });

  it('degrades to null (no throw) when a Redis read rejects', async () => {
    await setUserPingMs('user-1', 60);
    getThrows = true;
    await expect(getUserPingMs('user-1')).resolves.toBeNull();
  });
});
