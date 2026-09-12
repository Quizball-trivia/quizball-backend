import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
const { allowGuestOperation, resetGuestRateLimitsForTests } = await import('../../src/modules/guest/guest-rate-limit.js');

describe('guest rate limits (process fallback)', () => {
  beforeEach(() => resetGuestRateLimitsForTests());

  it('allows five room creations an hour per guest, then refuses', async () => {
    for (let i = 0; i < 5; i += 1) expect(await allowGuestOperation('user:g1', 'lobby_create')).toBe(true);
    expect(await allowGuestOperation('user:g1', 'lobby_create')).toBe(false);
    expect(await allowGuestOperation('user:g2', 'lobby_create')).toBe(true);
  });

  it('buckets socket admission per address', async () => {
    for (let i = 0; i < 60; i += 1) expect(await allowGuestOperation('ip:1.2.3.4', 'socket_admission')).toBe(true);
    expect(await allowGuestOperation('ip:1.2.3.4', 'socket_admission')).toBe(false);
    expect(await allowGuestOperation('ip:1.2.3.5', 'socket_admission')).toBe(true);
  });
});
