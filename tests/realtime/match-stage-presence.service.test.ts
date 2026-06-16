import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const redisValues = new Map<string, string>();
const fakeRedis = {
  isOpen: true,
  set: vi.fn(async (key: string, value: string) => {
    redisValues.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => redisValues.get(key) ?? null),
  exists: vi.fn(async (key: string) => (redisValues.has(key) ? 1 : 0)),
};

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

describe('match-stage-presence.service', () => {
  beforeEach(() => {
    redisValues.clear();
    vi.clearAllMocks();
    fakeRedis.isOpen = true;
  });

  it('records heartbeat and ready markers scoped to the exact stage key', async () => {
    const {
      hasMatchStagePresence,
      recordMatchStagePresenceHeartbeat,
      recordMatchStageReady,
      waitForMatchStageReady,
    } = await import('../../src/realtime/services/match-stage-presence.service.js');

    await recordMatchStagePresenceHeartbeat({ matchId: 'm1', userId: 'u1', stageKey: 'penalties' });
    await recordMatchStageReady({ matchId: 'm1', userId: 'u1', stageKey: 'penalties' });

    await expect(hasMatchStagePresence({ matchId: 'm1', userId: 'u1', stageKey: 'penalties' })).resolves.toBe(true);
    await expect(hasMatchStagePresence({ matchId: 'm1', userId: 'u1', stageKey: 'kickoff' })).resolves.toBe(false);
    await expect(waitForMatchStageReady({
      matchId: 'm1',
      userIds: ['u1'],
      stageKey: 'penalties',
      ceilingMs: 0,
    })).resolves.toEqual({
      readyUserIds: ['u1'],
      missingUserIds: [],
      reason: 'all_ready',
    });
  });

  it('hits the absolute ceiling when stage_ready is missing', async () => {
    const { waitForMatchStageReady } = await import('../../src/realtime/services/match-stage-presence.service.js');

    await expect(waitForMatchStageReady({
      matchId: 'm1',
      userIds: ['u1', 'u2'],
      stageKey: 'resume',
      ceilingMs: 0,
    })).resolves.toEqual({
      readyUserIds: [],
      missingUserIds: ['u1', 'u2'],
      reason: 'timeout',
    });
  });

  it('does not count a stale heartbeat from a previous stage as current-stage presence', async () => {
    const {
      hasMatchStagePresence,
      recordMatchStagePresenceHeartbeat,
    } = await import('../../src/realtime/services/match-stage-presence.service.js');

    await recordMatchStagePresenceHeartbeat({ matchId: 'm1', userId: 'u1', stageKey: 'kickoff' });

    await expect(hasMatchStagePresence({ matchId: 'm1', userId: 'u1', stageKey: 'resume' })).resolves.toBe(false);
  });

  it('only trusts socket-scoped heartbeat values for replacement socket checks', async () => {
    const {
      hasMatchStagePresenceFromSocketIds,
      recordMatchStagePresenceHeartbeat,
    } = await import('../../src/realtime/services/match-stage-presence.service.js');

    await recordMatchStagePresenceHeartbeat({
      matchId: 'm1',
      userId: 'u1',
      stageKey: 'question',
      socketId: 'match-socket-1',
    });

    await expect(hasMatchStagePresenceFromSocketIds({
      matchId: 'm1',
      userId: 'u1',
      stageKey: 'question',
      socketIds: ['match-socket-1'],
    })).resolves.toBe(true);
    await expect(hasMatchStagePresenceFromSocketIds({
      matchId: 'm1',
      userId: 'u1',
      stageKey: 'question',
      socketIds: ['menu-socket-1'],
    })).resolves.toBe(false);
  });

  it('returns redis_unavailable if Redis fails while polling stage readiness', async () => {
    const { waitForMatchStageReady } = await import('../../src/realtime/services/match-stage-presence.service.js');
    fakeRedis.exists.mockRejectedValueOnce(new Error('redis failover'));

    await expect(waitForMatchStageReady({
      matchId: 'm1',
      userIds: ['u1', 'u2'],
      stageKey: 'resume',
      ceilingMs: 0,
    })).resolves.toEqual({
      readyUserIds: [],
      missingUserIds: ['u1', 'u2'],
      reason: 'redis_unavailable',
    });
  });
});
