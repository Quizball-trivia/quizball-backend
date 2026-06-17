import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// K1: pauseMatchForDisconnectedPlayer must degrade gracefully when Redis is
// unavailable. A disconnect mid-match with the cache down must NOT throw (which
// would bubble out of the socket 'disconnect' handler) — it returns a no-op
// pause result (finalized:false, no reconnects granted) and lets the durable
// sweeper handle the match later. Previously untested; this pins the null-redis
// guard so a refactor can't reintroduce a crash on the disconnect path.

const getMatchMock = vi.fn();
const getRedisClientMock = vi.fn();

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => getRedisClientMock(),
}));
vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: { getMatch: (...a: unknown[]) => getMatchMock(...a) },
}));

function createIo(): QuizballServer {
  return {
    in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
    to: vi.fn(() => ({ emit: vi.fn() })),
  } as unknown as QuizballServer;
}

describe('pauseMatchForDisconnectedPlayer — Redis-down resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('K1: returns a no-op pause (no throw) when Redis is unavailable', async () => {
    getMatchMock.mockResolvedValue({
      id: 'm1',
      mode: 'ranked',
      status: 'active',
      state_payload: { variant: 'ranked_sim' },
    });
    getRedisClientMock.mockReturnValue(null);

    const { pauseMatchForDisconnectedPlayer } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );

    const result = await pauseMatchForDisconnectedPlayer(createIo(), 'm1', 'u1');

    expect(result.finalized).toBe(false);
    expect(result.remainingReconnects).toBe(0);
    expect(result.graceMs).toBeGreaterThan(0);
  });

  it('returns a no-op pause when the match is already gone / not active', async () => {
    getMatchMock.mockResolvedValue({ id: 'm1', mode: 'ranked', status: 'completed' });
    getRedisClientMock.mockReturnValue(null);

    const { pauseMatchForDisconnectedPlayer } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );

    const result = await pauseMatchForDisconnectedPlayer(createIo(), 'm1', 'u1');

    expect(result.finalized).toBe(false);
    expect(result.remainingReconnects).toBe(0);
  });
});
