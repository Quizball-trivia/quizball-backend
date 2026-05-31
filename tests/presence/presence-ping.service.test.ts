import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// In-memory ZSET fake: member -> score
const zset = new Map<string, number>();
let isOpen = true;

const fakeRedis = {
  get isOpen() {
    return isOpen;
  },
  async zAdd(_key: string, entry: { score: number; value: string }) {
    zset.set(entry.value, entry.score);
    return 1;
  },
  async zRem(_key: string, member: string) {
    return zset.delete(member) ? 1 : 0;
  },
  async zRemRangeByScore(_key: string, min: number, max: number) {
    let removed = 0;
    for (const [member, score] of [...zset]) {
      if (score >= min && score <= max) {
        zset.delete(member);
        removed += 1;
      }
    }
    return removed;
  },
  async zCard(_key: string) {
    return zset.size;
  },
};

let redisClient: typeof fakeRedis | null = fakeRedis;

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisClient,
}));

import {
  recordPing,
  getOnlineCount,
  PRESENCE_PING_TTL_MS,
} from '../../src/realtime/presence-ping.service.js';

describe('presence-ping.service', () => {
  const now = 1_780_000_000_000;

  beforeEach(() => {
    zset.clear();
    isOpen = true;
    redisClient = fakeRedis;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('recordPing adds a member with the given score', async () => {
    await recordPing('anon:u1', now);
    expect(zset.get('anon:u1')).toBe(now);
  });

  it('getOnlineCount counts fresh members', async () => {
    await recordPing('anon:u1', now);
    await recordPing('anon:abc', now);
    expect(await getOnlineCount(now)).toBe(2);
  });

  it('does not count members older than the TTL', async () => {
    await recordPing('anon:u1', now - PRESENCE_PING_TTL_MS - 1);
    await recordPing('anon:abc', now);
    expect(await getOnlineCount(now)).toBe(1);
  });

  it('trims stale members during the count', async () => {
    await recordPing('anon:old', now - PRESENCE_PING_TTL_MS - 1);
    await getOnlineCount(now);
    expect(zset.has('anon:old')).toBe(false);
  });

  it('counts the same member only once (multi-tab / repeat ping)', async () => {
    await recordPing('anon:abc', now);
    await recordPing('anon:abc', now + 10);
    expect(await getOnlineCount(now + 10)).toBe(1);
  });

  it('is safe when redis is unavailable', async () => {
    redisClient = null;
    await expect(recordPing('anon:abc', now)).resolves.toBeUndefined();
    expect(await getOnlineCount(now)).toBe(0);
  });

  it('is safe when redis is closed', async () => {
    isOpen = false;
    await expect(recordPing('anon:abc', now)).resolves.toBeUndefined();
    expect(await getOnlineCount(now)).toBe(0);
  });
});
