import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

type FakeSocket = {
  id: string;
  data: {
    user: { id: string; nickname: string | null };
    matchId?: string;
    lobbyId?: string;
  };
  emit: Mock;
};

class FakeRedis {
  isOpen = true;
  hashes = new Map<string, Record<string, string>>();
  zsets = new Map<string, Map<string, number>>();

  hGet(key: string, field: string): Promise<string | null> {
    return Promise.resolve(this.hashes.get(key)?.[field] ?? null);
  }

  hSet(key: string, fieldOrValues: string | Record<string, string>, value?: string): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    if (typeof fieldOrValues === 'string') {
      hash[fieldOrValues] = value ?? '';
    } else {
      Object.assign(hash, fieldOrValues);
    }
    this.hashes.set(key, hash);
    return Promise.resolve(1);
  }

  hGetAll(key: string): Promise<Record<string, string>> {
    return Promise.resolve({ ...(this.hashes.get(key) ?? {}) });
  }

  hDel(key: string, fields: string | string[]): Promise<number> {
    const hash = this.hashes.get(key) ?? {};
    const list = Array.isArray(fields) ? fields : [fields];
    let count = 0;
    for (const field of list) {
      if (field in hash) count += 1;
      delete hash[field];
    }
    this.hashes.set(key, hash);
    return Promise.resolve(count);
  }

  zAdd(key: string, entry: { score: number; value: string }): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    zset.set(entry.value, entry.score);
    this.zsets.set(key, zset);
    return Promise.resolve(1);
  }

  zRange(key: string, _start: number, _stop: number): Promise<string[]> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    return Promise.resolve(
      [...zset.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([value]) => value)
    );
  }

  zRem(key: string, values: string | string[]): Promise<number> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    const list = Array.isArray(values) ? values : [values];
    let count = 0;
    for (const value of list) {
      if (zset.delete(value)) count += 1;
    }
    this.zsets.set(key, zset);
    return Promise.resolve(count);
  }

  expire(_key: string, _seconds: number): Promise<boolean> {
    return Promise.resolve(true);
  }

  multi() {
    const ops: Array<() => Promise<unknown>> = [];
    const chain = {
      hSet: (key: string, fieldOrValues: string | Record<string, string>, value?: string) => {
        ops.push(() => this.hSet(key, fieldOrValues, value));
        return chain;
      },
      hDel: (key: string, fields: string | string[]) => {
        ops.push(() => this.hDel(key, fields));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => this.expire(key, seconds));
        return chain;
      },
      zAdd: (key: string, entry: { score: number; value: string }) => {
        ops.push(() => this.zAdd(key, entry));
        return chain;
      },
      zRem: (key: string, values: string | string[]) => {
        ops.push(() => this.zRem(key, values));
        return chain;
      },
      exec: async () => {
        for (const op of ops) await op();
        return [];
      },
    };
    return chain;
  }
}

const redisMock = vi.hoisted(() => ({
  client: null as FakeRedis | null,
}));

const lockMock = vi.hoisted(() => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'lock-token' })),
  releaseLock: vi.fn(async () => undefined),
}));

const timerMock = vi.hoisted(() => ({
  scheduleRealtimeTimer: vi.fn(),
  cancelRealtimeTimer: vi.fn(),
}));

const startMatchMock = vi.hoisted(() => ({
  startAuctionMatchForHumans: vi.fn(async (_io: unknown, input: { formation?: string }) => {
    return {
      matchId: 'match-found',
      formation: input.formation ?? '4-3-3',
    };
  }),
}));

const sessionGuardMock = vi.hoisted(() => ({
  userSessionGuardService: {
    runWithUserTransitionLock: vi.fn(async (_io: unknown, _socket: unknown, work: () => Promise<void>) => {
      await work();
      return true;
    }),
    resolveState: vi.fn(async () => ({
      state: 'IDLE',
      activeMatchId: null,
      waitingLobbyId: null,
      queueSearchId: null,
      openLobbyIds: [],
      resolvedAt: '2026-06-20T10:00:00.000Z',
    })),
    emitBlocked: vi.fn(),
  },
}));

const contentServiceMock = vi.hoisted(() => ({
  assertPublishedAuctionContentAvailable: vi.fn(),
}));

vi.mock('../../src/modules/auction/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/index.js')>();
  return {
    ...actual,
    auctionContentService: contentServiceMock,
  };
});

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => redisMock.client,
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: lockMock.acquireLock,
  releaseLock: lockMock.releaseLock,
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: timerMock.scheduleRealtimeTimer,
  cancelRealtimeTimer: timerMock.cancelRealtimeTimer,
}));

vi.mock('../../src/realtime/services/auction-realtime.service.js', () => ({
  startAuctionMatchForHumans: startMatchMock.startAuctionMatchForHumans,
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: sessionGuardMock.userSessionGuardService,
}));

import { auctionMatchmakingService } from '../../src/realtime/services/auction-matchmaking.service.js';
import { AuctionContentUnavailableError } from '../../src/modules/auction/index.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

function socket(userId: string, nickname = userId): FakeSocket {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId, nickname } },
    emit: vi.fn(),
  };
}

function createIo() {
  const roomEmit = vi.fn();
  const roomSockets = new Map<string, FakeSocket[]>();
  const to = vi.fn((room: string) => ({
    emit: (event: string, payload?: unknown) => roomEmit(room, event, payload),
  }));
  const inFn = vi.fn((room: string) => ({
    socketsJoin: vi.fn(async (_targetRoom: string) => undefined),
    fetchSockets: vi.fn(async () => roomSockets.get(room) ?? []),
  }));
  return {
    io: { to, in: inFn } as unknown as QuizballServer,
    roomEmit,
    roomSockets,
  };
}

function scheduledSearchIds(): string[] {
  return timerMock.scheduleRealtimeTimer.mock.calls
    .filter(([kind]) => kind === 'auction_matchmaking_fill')
    .map(([, , , payload]) => (payload as { searchId: string }).searchId);
}

describe('auctionMatchmakingService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    redisMock.client = new FakeRedis();
    vi.clearAllMocks();
    contentServiceMock.assertPublishedAuctionContentAvailable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a 3-human auction match immediately without ticket or ranked side effects', async () => {
    const { io, roomEmit } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u3', 'Three'), { locale: 'en' });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledTimes(1);
    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        locale: 'en',
        humanPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
          { userId: 'u3', displayName: 'Three' },
        ],
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:match_found',
      expect.objectContaining({ humanUserIds: ['u1', 'u2', 'u3'], botCount: 0 })
    );
  });

  it('fills one bot when two humans wait for the fallback timer', async () => {
    const { io, roomEmit } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:10.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: scheduledSearchIds()[0],
    });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        humanPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
        ],
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u2',
      'auction:match_found',
      expect.objectContaining({ humanUserIds: ['u1', 'u2'], botCount: 1 })
    );
  });

  it('waits after the second human joins before filling one bot', async () => {
    const { io } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    const firstSearchId = scheduledSearchIds()[0];
    vi.setSystemTime(new Date('2026-06-20T10:00:11.000Z'));
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:12.000Z'));

    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: firstSearchId,
    });

    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
    expect(timerMock.scheduleRealtimeTimer).toHaveBeenLastCalledWith(
      'auction_matchmaking_fill',
      `auction:mm:fill:${firstSearchId}`,
      new Date('2026-06-20T10:00:21.000Z'),
      { kind: 'auction_matchmaking_fill', searchId: firstSearchId }
    );

    vi.setSystemTime(new Date('2026-06-20T10:00:21.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: firstSearchId,
    });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        humanPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
        ],
      })
    );
  });

  it('fills two bots when one human reaches the fallback timer', async () => {
    const { io, roomEmit } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:12.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: scheduledSearchIds()[0],
    });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        humanPlayers: [{ userId: 'u1', displayName: 'One' }],
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:match_found',
      expect.objectContaining({ humanUserIds: ['u1'], botCount: 2 })
    );
  });

  it('does not create a duplicate search for the same user', async () => {
    const { io } = createIo();
    const firstSocket = socket('u1', 'One');

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });

    expect(timerMock.scheduleRealtimeTimer).toHaveBeenCalledTimes(1);
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
  });

  it('cancels a queued search and prevents its fallback from starting a match', async () => {
    const { io } = createIo();
    const firstSocket = socket('u1', 'One');

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });
    const searchId = scheduledSearchIds()[0];
    await auctionMatchmakingService.handleSearchCancel(io, firstSocket);
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId,
    });

    expect(firstSocket.emit).toHaveBeenCalledWith(
      'auction:search_cancelled',
      expect.objectContaining({ searchId, reason: 'cancelled' })
    );
    expect(timerMock.cancelRealtimeTimer).toHaveBeenCalledWith(
      'auction_matchmaking_fill',
      `auction:mm:fill:${searchId}`
    );
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
  });

  it('removes a queued search on disconnect when no other user sockets remain', async () => {
    const { io, roomEmit, roomSockets } = createIo();
    const firstSocket = socket('u1', 'One');
    roomSockets.set('user:u1', []);

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });
    const searchId = scheduledSearchIds()[0];
    await auctionMatchmakingService.handleSocketDisconnect(io, firstSocket);
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId,
    });

    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:search_cancelled',
      expect.objectContaining({ searchId, reason: 'disconnect' })
    );
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
  });

  it('returns auction_content_unavailable before queueing when no published content exists', async () => {
    const { io } = createIo();
    const firstSocket = socket('u1', 'One');
    contentServiceMock.assertPublishedAuctionContentAvailable.mockRejectedValue(
      new AuctionContentUnavailableError({ locale: 'en' })
    );

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });

    expect(firstSocket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'auction_content_unavailable',
        message: 'Published auction content unavailable',
      })
    );
    expect(timerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
  });
});
