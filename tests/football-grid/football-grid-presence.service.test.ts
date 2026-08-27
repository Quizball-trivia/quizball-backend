import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

class FakeRedis {
  isOpen = true;
  strings = new Map<string, string>();
  hashes = new Map<string, Record<string, string>>();

  async set(key: string, value: string) { this.strings.set(key, value); return 'OK'; }
  async hGet(key: string, field: string) { return this.hashes.get(key)?.[field] ?? null; }
  async hSet(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? {};
    hash[field] = value;
    this.hashes.set(key, hash);
    return 1;
  }
  async expire() { return true; }
  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    const chain = {
      hSet: (key: string, field: string, value: string) => {
        operations.push(() => this.hSet(key, field, value));
        return chain;
      },
      expire: () => chain,
      exec: async () => { for (const operation of operations) await operation(); return []; },
    };
    return chain;
  }
}

const state = vi.hoisted(() => ({
  redis: null as FakeRedis | null,
  getPresenceGeneration: vi.fn(async () => 7),
  scheduleTimer: vi.fn(),
}));

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => state.redis }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'presence-lock' })),
  releaseLock: vi.fn(async () => true),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: (...args: unknown[]) => state.scheduleTimer(...args),
}));
vi.mock('../../src/modules/football-grid/index.js', () => ({
  footballGridRepo: {
    getPresenceGeneration: (...args: unknown[]) => state.getPresenceGeneration(...args),
  },
}));

import { footballGridPresenceService } from '../../src/realtime/services/football-grid-presence.service.js';

describe('footballGridPresenceService heartbeat refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.redis = new FakeRedis();
  });

  it('refreshes an existing fenced lease without reading PostgreSQL', async () => {
    await state.redis!.hSet(
      'football_grid:presence:match-1:user-1',
      'socket-1',
      JSON.stringify({ expiresAt: Date.now() + 1_000, nodeId: 'old-node', generation: 7 }),
    );

    await expect(footballGridPresenceService.refresh('match-1', 'user-1', 'socket-1')).resolves.toBe(true);

    expect(state.getPresenceGeneration).not.toHaveBeenCalled();
    const refreshed = JSON.parse((await state.redis!.hGet(
      'football_grid:presence:match-1:user-1',
      'socket-1',
    ))!) as { expiresAt: number; generation: number };
    expect(refreshed.generation).toBe(7);
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 10_000);
    expect(state.scheduleTimer).toHaveBeenCalledOnce();
  });

  it('falls back when no reusable lease exists', async () => {
    await expect(footballGridPresenceService.refresh('match-1', 'user-1', 'socket-1')).resolves.toBe(false);
    expect(state.getPresenceGeneration).not.toHaveBeenCalled();
    expect(state.scheduleTimer).not.toHaveBeenCalled();
  });
});
