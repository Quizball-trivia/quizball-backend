import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

class SharedRedis {
  isOpen = true;
  values = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, options?: { NX?: boolean }): Promise<'OK' | null> {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }

  async sAdd(key: string, members: string | string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    for (const member of Array.isArray(members) ? members : [members]) set.add(member);
    this.sets.set(key, set);
    return set.size - before;
  }

  async sMembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Set<string>())];
  }

  async sRem(key: string, members: string | string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of Array.isArray(members) ? members : [members]) {
      if (set.delete(member)) removed += 1;
    }
    return removed;
  }

  async expire(): Promise<boolean> {
    return true;
  }
}

const redis = new SharedRedis();
let latestState: AuctionMatchState | null = null;
const advanceRetryMock = vi.hoisted(() => ({
  scheduleAuctionAdvanceRetryTimer: vi.fn(),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redis,
}));

vi.mock('../../src/modules/auction/auction-state.store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/auction-state.store.js')>();
  return {
    ...actual,
    auctionStateStore: {
      load: async () => latestState,
    },
  };
});

vi.mock('../../src/realtime/services/auction-advance-retry-timer.js', () => ({
  scheduleAuctionAdvanceRetryTimer: advanceRetryMock.scheduleAuctionAdvanceRetryTimer,
}));

function state(): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 7,
    seats: [
      { isBot: false, userId: 'user-1' },
      { isBot: false, userId: 'user-2' },
    ],
    currentRound: { roundId: 'round-1' },
  } as AuctionMatchState;
}

function io(): QuizballServer {
  return { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as QuizballServer;
}

function flushGateDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const payload = {
  matchId: 'match-1',
  phase: 'round' as const,
  roundId: 'round-1',
  stateVersion: 7,
};

describe('auction UI-ready shared gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.values.clear();
    redis.sets.clear();
    latestState = state();
    advanceRetryMock.scheduleAuctionAdvanceRetryTimer.mockResolvedValue(undefined);
    vi.resetModules();
  });

  it('counts an acknowledgement recorded on a replica with no local gate', async () => {
    const owner = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const dispatch = vi.fn();
    owner.openAuctionUiReadyGate({ io: io(), state: state(), phase: 'round', dispatch });
    await Promise.resolve();
    owner.clearAuctionUiReadyGate('match-1', 'round', 'round-1', 7);

    vi.resetModules();
    const remote = await import('../../src/realtime/services/auction-ui-ready.service.js');
    await expect(remote.acknowledgeAuctionUiReady(io(), 'user-1', payload)).resolves.toBe(true);

    owner.openAuctionUiReadyGate({ io: io(), state: state(), phase: 'round', dispatch });
    await owner.acknowledgeAuctionUiReady(io(), 'user-2', payload);
    await flushGateDispatch();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ reason: 'all_ready', missingUserIds: [] });
    owner.clearAuctionUiReadyGate('match-1', 'round', 'round-1', 7);
  });

  it('dispatches once when two replica owners concurrently observe completeness', async () => {
    const replicaA = await import('../../src/realtime/services/auction-ui-ready.service.js');
    vi.resetModules();
    const replicaB = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const dispatchA = vi.fn();
    const dispatchB = vi.fn();
    replicaA.openAuctionUiReadyGate({ io: io(), state: state(), phase: 'round', dispatch: dispatchA });
    replicaB.openAuctionUiReadyGate({ io: io(), state: state(), phase: 'round', dispatch: dispatchB });
    await Promise.resolve();

    await Promise.all([
      replicaA.acknowledgeAuctionUiReady(io(), 'user-1', payload),
      replicaB.acknowledgeAuctionUiReady(io(), 'user-2', payload),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushGateDispatch();

    expect(dispatchA.mock.calls.length + dispatchB.mock.calls.length).toBe(1);
    replicaA.clearAuctionUiReadyGate('match-1', 'round', 'round-1', 7);
    replicaB.clearAuctionUiReadyGate('match-1', 'round', 'round-1', 7);
  });

  it('does not wait for a forfeited human seat', async () => {
    const service = await import('../../src/realtime/services/auction-ui-ready.service.js');
    latestState = state();
    latestState.seats[1]!.forfeited = true;
    const dispatch = vi.fn();
    service.openAuctionUiReadyGate({ io: io(), state: latestState, phase: 'round', dispatch });

    await service.acknowledgeAuctionUiReady(io(), 'user-1', payload);
    await flushGateDispatch();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ reason: 'all_ready', missingUserIds: [] });
  });

  it('releases an open gate when a waiting human forfeits after the other human is ready', async () => {
    const service = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const dispatch = vi.fn();
    service.openAuctionUiReadyGate({ io: io(), state: latestState!, phase: 'round', dispatch });
    await service.acknowledgeAuctionUiReady(io(), 'user-1', payload);
    expect(dispatch).not.toHaveBeenCalled();

    latestState = {
      ...latestState!,
      version: 8,
      seats: latestState!.seats.map((seat) => (
        seat.userId === 'user-2' ? { ...seat, forfeited: true, isEliminated: true } : seat
      )),
    };
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushGateDispatch();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ reason: 'all_ready', missingUserIds: [] });
  });

  it('schedules a durable backstop when dispatch fails with a database error', async () => {
    const service = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const databaseError = Object.assign(new Error('getaddrinfo ENOTFOUND db.example'), {
      code: 'ENOTFOUND',
    });
    const dispatch = vi.fn().mockRejectedValue(databaseError);
    service.openAuctionUiReadyGate({
      io: io(),
      state: latestState!,
      phase: 'reveal',
      dispatch,
    });

    await service.acknowledgeAuctionUiReady(io(), 'user-1', {
      ...payload,
      phase: 'reveal',
    });
    await service.acknowledgeAuctionUiReady(io(), 'user-2', {
      ...payload,
      phase: 'reveal',
    });
    await flushGateDispatch();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledOnce();
    expect(advanceRetryMock.scheduleAuctionAdvanceRetryTimer).toHaveBeenCalledWith(
      'match-1',
      'reveal',
    );
  });
});
