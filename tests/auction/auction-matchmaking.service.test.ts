import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

type FakeSocket = {
  id: string;
  data: {
    user: {
      id: string;
      nickname: string | null;
      avatar_customization?: Record<string, string> | null;
    };
    matchId?: string;
    lobbyId?: string;
  };
  emit: Mock;
};

class FakeRedis {
  isOpen = true;
  hashes = new Map<string, Record<string, string>>();
  zsets = new Map<string, Map<string, number>>();
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.strings.get(key) ?? null);
  }

  set(key: string, value: string, _options?: { NX?: boolean; PX?: number }): Promise<string | null> {
    if (_options?.NX && this.strings.has(key)) return Promise.resolve(null);
    this.strings.set(key, value);
    return Promise.resolve('OK');
  }

  sAdd(key: string, value: string): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const had = set.has(value);
    set.add(value);
    this.sets.set(key, set);
    return Promise.resolve(had ? 0 : 1);
  }

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

  zCard(key: string): Promise<number> {
    return Promise.resolve(this.zsets.get(key)?.size ?? 0);
  }

  zRangeByScore(
    key: string,
    min: number,
    max: number,
    options?: { LIMIT?: { offset: number; count: number } },
  ): Promise<string[]> {
    const values = [...(this.zsets.get(key) ?? new Map<string, number>()).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([value]) => value);
    const offset = options?.LIMIT?.offset ?? 0;
    const count = options?.LIMIT?.count ?? values.length;
    return Promise.resolve(values.slice(offset, offset + count));
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
  startAuctionMatchForHumans: vi.fn(async (
    io: { to: (room: string) => { emit: (event: string, payload?: unknown) => void } },
    input: { formation?: string; humanPlayers: Array<{ userId: string; displayName: string }> },
    options?: {
      beforeStartEvents?: (match: {
        matchId: string;
        formation: string;
        seats: Array<{ seatId: string; displayName: string; isBot: boolean }>;
      }) => void;
    },
  ) => {
    const botCount = 3 - input.humanPlayers.length;
    const match = {
      matchId: 'match-found',
      formation: input.formation ?? '2-2-2',
      seats: [
        ...input.humanPlayers.map((player, index) => ({
          seatId: `seat-human-${index + 1}`,
          displayName: player.displayName,
          isBot: false,
        })),
        ...Array.from({ length: botCount }, (_, index) => ({
          seatId: `seat-bot-${index + 1}`,
          displayName: `Smart Bot ${index + 1}`,
          isBot: true,
        })),
      ],
    };
    options?.beforeStartEvents?.(match);
    io.to(`match:${match.matchId}`).emit('auction:match_started', { matchId: match.matchId });
    return match;
  }),
  rejoinAuctionMatch: vi.fn(async () => true),
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
    resolveStates: vi.fn(async (userIds: string[]) => new Map(userIds.map((userId) => [userId, {
      state: 'IDLE',
      activeMatchId: null,
      waitingLobbyId: null,
      queueSearchId: null,
      openLobbyIds: [],
      resolvedAt: '2026-06-20T10:00:00.000Z',
    }]))),
    prepareForQueueJoin: vi.fn(async () => ({
      ok: true,
      snapshot: {
        state: 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId: null,
        openLobbyIds: [],
        resolvedAt: '2026-06-20T10:00:00.000Z',
      },
    })),
    renewActivityFences: vi.fn(async () => true),
    releaseActivityFences: vi.fn(async (userIds: string[], fenceToken: string) => {
      for (const userId of userIds) {
        const key = `session:pairing:user:${userId}`;
        if (redisMock.client?.strings.get(key) === fenceToken) {
          redisMock.client.strings.delete(key);
        }
      }
    }),
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
  rejoinAuctionMatch: startMatchMock.rejoinAuctionMatch,
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: sessionGuardMock.userSessionGuardService,
}));

import { auctionMatchmakingService } from '../../src/realtime/services/auction-matchmaking.service.js';
import { AuctionContentUnavailableError } from '../../src/modules/auction/index.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

function socket(
  userId: string,
  nickname = userId,
  avatarCustomization?: Record<string, string> | null,
): FakeSocket {
  return {
    id: `socket-${userId}`,
    data: {
      user: {
        id: userId,
        nickname,
        ...(avatarCustomization !== undefined
          ? { avatar_customization: avatarCustomization }
          : {}),
      },
    },
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
    auctionMatchmakingService.stop();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
    redisMock.client = new FakeRedis();
    vi.clearAllMocks();
    contentServiceMock.assertPublishedAuctionContentAvailable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    auctionMatchmakingService.stop();
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
      }),
      expect.objectContaining({ beforeStartEvents: expect.any(Function) }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:match_found',
      expect.objectContaining({
        humanUserIds: ['u1', 'u2', 'u3'],
        botCount: 0,
        serverNow: '2026-06-20T10:00:00.000Z',
        lineupEndsAt: '2026-06-20T10:00:02.500Z',
        showdownEndsAt: '2026-06-20T10:00:05.500Z',
        countdownEndsAt: '2026-06-20T10:00:10.500Z',
      })
    );
    const foundCall = roomEmit.mock.calls.findIndex(
      ([room, event]) => room === 'user:u1' && event === 'auction:match_found',
    );
    const startedCall = roomEmit.mock.calls.findIndex(
      ([room, event]) => room === 'match:match-found' && event === 'auction:match_started',
    );
    expect(foundCall).toBeGreaterThanOrEqual(0);
    expect(startedCall).toBeGreaterThan(foundCall);
    expect(lockMock.releaseLock.mock.invocationCallOrder[0]).toBeLessThan(
      startMatchMock.startAuctionMatchForHumans.mock.invocationCallOrder[0],
    );
  });

  it('uses the durable claim token as the idempotent match id', async () => {
    const { io } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u2'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u3'), { locale: 'en' });

    const options = startMatchMock.startAuctionMatchForHumans.mock.calls[0]?.[2] as {
      context?: { createId?: (kind: 'match' | 'round' | 'bot-seat') => string };
    };
    const matchId = options.context?.createId?.('match');
    expect(matchId).toMatch(/^[0-9a-f-]{36}$/);
    expect([...redisMock.client!.hashes.values()]).toContainEqual(expect.objectContaining({
      status: 'completed',
      matchId,
    }));
  });

  it('matches two humans across locales, then immediately seats a named bot on the fill tick', async () => {
    const { io, roomEmit } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'ka' });
    const searchId = scheduledSearchIds()[0];

    expect(roomEmit).toHaveBeenCalledWith(
      'user:u2',
      'auction:search_status',
      expect.objectContaining({
        locale: 'ka',
        queuedUserCount: 2,
        seatsNeeded: 1,
        queuedPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
        ],
        botCount: 0,
      })
    );
    // The first browser receives the same roster update even when the second
    // join lands on another application replica.
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:search_status',
      expect.objectContaining({
        locale: 'en',
        queuedUserCount: 2,
        queuedPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
        ],
      }),
    );

    // One bot completes the table, so start immediately. This avoids exposing
    // an anonymous staged-bot label while the real smart bot is being selected.
    // (The bot fallback delay is randomized 5-18s now — jump past the max.)
    vi.setSystemTime(new Date('2026-06-20T10:00:20.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId,
    });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        locale: 'en',
        humanPlayers: [
          { userId: 'u1', displayName: 'One' },
          { userId: 'u2', displayName: 'Two' },
        ],
      }),
      expect.objectContaining({ beforeStartEvents: expect.any(Function) }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u2',
      'auction:match_found',
      expect.objectContaining({
        humanUserIds: ['u1', 'u2'],
        botCount: 1,
        // Bots now carry a randomized lineup join delay (staggered arrivals).
        botPlayers: [{ seatId: 'seat-bot-1', displayName: 'Smart Bot 1', joinDelayMs: expect.any(Number) }],
        locale: 'en',
      })
    );
  });

  it('broadcasts each queued human\'s saved layered avatar to every client', async () => {
    const { io, roomEmit } = createIo();
    const redAvatar = {
      skin: 'skin_male_white',
      jersey: 'jersey_red',
      hair: 'hair_boy_basic',
    };

    await auctionMatchmakingService.handleSearchStart(
      io,
      socket('u1', 'Red Player', redAvatar),
      { locale: 'en' },
    );
    await auctionMatchmakingService.handleSearchStart(
      io,
      socket('u2', 'Web Player'),
      { locale: 'en' },
    );

    expect(roomEmit).toHaveBeenCalledWith(
      'user:u2',
      'auction:search_status',
      expect.objectContaining({
        queuedPlayers: expect.arrayContaining([
          {
            userId: 'u1',
            displayName: 'Red Player',
            avatarCustomization: redAvatar,
          },
        ]),
      }),
    );
  });

  it('starts immediately when one bot fills the final seat after a second human joins', async () => {
    const { io } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    const firstSearchId = scheduledSearchIds()[0];
    vi.setSystemTime(new Date('2026-06-20T10:00:11.000Z'));
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'en' });
    // Randomized 5-18s fallback: jump past the max before the fill tick.
    vi.setSystemTime(new Date('2026-06-20T10:00:31.000Z'));

    // The selected smart bot is the final seat, so there is no anonymous
    // placeholder step or second fill timer.
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
      }),
      expect.objectContaining({ beforeStartEvents: expect.any(Function) }),
    );
  });

  it('extends a near-deadline two-human group once before bot backfill', async () => {
    const { io } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    const firstSearchId = scheduledSearchIds()[0];
    vi.setSystemTime(new Date('2026-06-20T10:00:17.000Z'));
    await auctionMatchmakingService.handleSearchStart(io, socket('u2', 'Two'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:20.000Z'));

    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: firstSearchId,
    });

    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
    const firstRow = redisMock.client!.hashes.get(`auction:mm:search:${firstSearchId}`);
    expect(firstRow).toEqual(expect.objectContaining({
      humanWaitExtended: '1',
      fallbackAt: String(Date.parse('2026-06-20T10:00:24.000Z')),
    }));

    vi.setSystemTime(new Date('2026-06-20T10:00:25.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId: firstSearchId,
    });
    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledTimes(1);
  });

  it('requeues a failed claim exactly once while preserving original queue order', async () => {
    const { io } = createIo();
    startMatchMock.startAuctionMatchForHumans.mockRejectedValueOnce(new Error('temporary start failure'));

    await auctionMatchmakingService.handleSearchStart(io, socket('u1'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:01.000Z'));
    await auctionMatchmakingService.handleSearchStart(io, socket('u2'), { locale: 'en' });
    vi.setSystemTime(new Date('2026-06-20T10:00:02.000Z'));
    await auctionMatchmakingService.handleSearchStart(io, socket('u3'), { locale: 'en' });

    const queue = redisMock.client!.zsets.get('auction:mm:queue');
    expect(queue?.size).toBe(3);
    expect([...queue!.values()].sort((a, b) => a - b)).toEqual([
      Date.parse('2026-06-20T10:00:00.000Z'),
      Date.parse('2026-06-20T10:00:01.000Z'),
      Date.parse('2026-06-20T10:00:02.000Z'),
    ]);
    const searchRows = [...redisMock.client!.hashes.entries()]
      .filter(([key]) => key.startsWith('auction:mm:search:'))
      .map(([, row]) => row);
    expect(searchRows).toHaveLength(3);
    expect(searchRows.every((row) => row.status === 'queued' && row.startFailures === '1')).toBe(true);
    expect(sessionGuardMock.userSessionGuardService.releaseActivityFences).toHaveBeenCalledTimes(1);
  });

  it('recovers an expired abandoned claim and preserves its queuedAt', async () => {
    const { io } = createIo();
    const search = {
      searchId: 'abandoned-search',
      userId: 'u1',
      displayName: 'One',
      locale: 'en',
      queuedAt: Date.parse('2026-06-20T09:59:50.000Z'),
      fallbackAt: Date.parse('2026-06-20T09:59:55.000Z'),
    };
    redisMock.client!.hashes.set('auction:mm:claim:abandoned-claim', {
      claimToken: 'abandoned-claim',
      matchId: 'abandoned-claim',
      status: 'claimed',
      claimedAt: String(Date.parse('2026-06-20T09:59:00.000Z')),
      leaseUntil: String(Date.parse('2026-06-20T09:59:59.000Z')),
      snapshot: JSON.stringify([search]),
    });
    redisMock.client!.zsets.set('auction:mm:claims', new Map([
      ['abandoned-claim', Date.parse('2026-06-20T09:59:59.000Z')],
    ]));
    redisMock.client!.hashes.set('auction:mm:claim:user', { u1: 'abandoned-claim' });
    redisMock.client!.strings.set('session:pairing:user:u1', 'abandoned-claim');

    auctionMatchmakingService.start(io);
    await vi.advanceTimersByTimeAsync(5_100);

    expect(redisMock.client!.zsets.get('auction:mm:queue')?.get('abandoned-search')).toBe(search.queuedAt);
    expect(redisMock.client!.hashes.get('auction:mm:search:abandoned-search')).toEqual(
      expect.objectContaining({ status: 'queued', startFailures: '1' }),
    );
    expect(redisMock.client!.hashes.get('auction:mm:claim:abandoned-claim')).toEqual(
      expect.objectContaining({ status: 'requeued' }),
    );
  });

  it('fills a lone human with two named smart bots on the first fallback tick', async () => {
    const { io, roomEmit } = createIo();

    await auctionMatchmakingService.handleSearchStart(io, socket('u1', 'One'), { locale: 'en' });
    const searchId = scheduledSearchIds()[0];

    // Like ranked fallback, the server selects the actual named opponents
    // before telling the client those seats are occupied.
    vi.setSystemTime(new Date('2026-06-20T10:00:20.000Z'));
    await auctionMatchmakingService.runFillTimer(io, {
      kind: 'auction_matchmaking_fill',
      searchId,
    });

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledWith(
      io,
      expect.objectContaining({
        humanPlayers: [{ userId: 'u1', displayName: 'One' }],
      }),
      expect.objectContaining({ beforeStartEvents: expect.any(Function) }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:match_found',
      expect.objectContaining({
        humanUserIds: ['u1'],
        botCount: 2,
        botPlayers: [
          { seatId: 'seat-bot-1', displayName: 'Smart Bot 1', joinDelayMs: expect.any(Number) },
          { seatId: 'seat-bot-2', displayName: 'Smart Bot 2', joinDelayMs: expect.any(Number) },
        ],
      })
    );
  });

  it('does not create a duplicate search for the same user (re-attaches and re-arms the fill timer)', async () => {
    const { io } = createIo();
    const firstSocket = socket('u1', 'One');

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });

    // Only one search row exists for the user (no duplicate).
    expect(scheduledSearchIds()).toEqual([scheduledSearchIds()[0], scheduledSearchIds()[0]]);
    // The second start re-attaches to the existing search and re-arms the fill
    // timer (so a reload doesn't leave the search hanging) — two schedules total.
    expect(timerMock.scheduleRealtimeTimer).toHaveBeenCalledTimes(2);
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
  });

  it('re-joins an existing live match (by userId) on reload instead of starting a new one', async () => {
    const { io } = createIo();
    // Seed Redis as if the user is already seated in a live match — the state
    // (auction:match:*) and the user→match index (auction:user:*:match).
    const matchId = 'live-match-1';
    const liveState = {
      matchId,
      version: 12,
      phase: 'bidding',
      seats: [
        { seatId: 'seat-human', userId: 'u1', displayName: 'One', isBot: false },
        { seatId: 'seat-bot-1', userId: null, displayName: 'lukaberidze', isBot: true },
        { seatId: 'seat-bot-2', userId: null, displayName: 'zaqoo', isBot: true },
      ],
    };
    redisMock.client!.strings.set(`auction:match:${matchId}`, JSON.stringify(liveState));
    redisMock.client!.strings.set('auction:user:u1:match', matchId);

    // A fresh socket (post-reload) has no socket.data.matchId.
    const reloadedSocket = socket('u1', 'One');
    await auctionMatchmakingService.handleSearchStart(io, reloadedSocket, { locale: 'en' });

    // Re-joined the live match; did NOT start a second match or a new search.
    expect(startMatchMock.rejoinAuctionMatch).toHaveBeenCalledWith(io, reloadedSocket, matchId);
    expect(startMatchMock.startAuctionMatchForHumans).not.toHaveBeenCalled();
    expect(timerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
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

  it('broadcasts the smaller roster to remaining players when someone cancels', async () => {
    const { io, roomEmit } = createIo();
    const firstSocket = socket('u1', 'One');
    const secondSocket = socket('u2', 'Two');

    await auctionMatchmakingService.handleSearchStart(io, firstSocket, { locale: 'en' });
    await auctionMatchmakingService.handleSearchStart(io, secondSocket, { locale: 'ka' });
    roomEmit.mockClear();

    await auctionMatchmakingService.handleSearchCancel(io, secondSocket);

    expect(roomEmit).toHaveBeenCalledWith(
      'user:u1',
      'auction:search_status',
      expect.objectContaining({
        queuedUserCount: 1,
        seatsNeeded: 2,
        queuedPlayers: [{ userId: 'u1', displayName: 'One' }],
        botCount: 0,
      })
    );
  });

  it('rejects cancellation after matchmaking has already seated the user', async () => {
    const { io } = createIo();
    const firstSocket = socket('u1', 'One');
    const matchId = 'claimed-match';
    redisMock.client!.strings.set(`auction:match:${matchId}`, JSON.stringify({
      matchId,
      version: 1,
      phase: 'bidding',
      seats: [
        { seatId: 'seat-human', userId: 'u1', displayName: 'One', isBot: false },
      ],
    }));
    redisMock.client!.strings.set('auction:user:u1:match', matchId);

    await auctionMatchmakingService.handleSearchCancel(io, firstSocket);

    expect(firstSocket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'auction_search_cancel_rejected',
      })
    );
    expect(firstSocket.emit).not.toHaveBeenCalledWith(
      'auction:search_cancelled',
      expect.anything()
    );
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

  it('never runs more than four match creations concurrently on one replica', async () => {
    const { io } = createIo();
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    let matchIndex = 0;
    startMatchMock.startAuctionMatchForHumans.mockImplementation(async (_io, input) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      matchIndex += 1;
      return {
        matchId: `bounded-${matchIndex}`,
        formation: '2-2-2',
        seats: input.humanPlayers.map((player, index) => ({
          seatId: `seat-${index}`,
          displayName: player.displayName,
          isBot: false,
        })),
      };
    });

    const thirdJoinPromises: Promise<void>[] = [];
    for (let group = 0; group < 5; group += 1) {
      await auctionMatchmakingService.handleSearchStart(io, socket(`u${group * 3 + 1}`), { locale: 'en' });
      await auctionMatchmakingService.handleSearchStart(io, socket(`u${group * 3 + 2}`), { locale: 'en' });
      thirdJoinPromises.push(auctionMatchmakingService.handleSearchStart(
        io,
        socket(`u${group * 3 + 3}`),
        { locale: 'en' },
      ));
      await vi.advanceTimersByTimeAsync(0);
    }

    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledTimes(4);
    expect(peakActive).toBe(4);

    releases.shift()?.();
    await thirdJoinPromises[0];
    auctionMatchmakingService.start(io);
    await vi.advanceTimersByTimeAsync(300);
    expect(startMatchMock.startAuctionMatchForHumans).toHaveBeenCalledTimes(5);
    expect(peakActive).toBe(4);

    for (const release of releases.splice(0)) release();
    await Promise.all(thirdJoinPromises);
  });
});
