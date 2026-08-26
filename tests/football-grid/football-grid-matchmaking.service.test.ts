import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

class FakeRedis {
  isOpen = true;
  hashes = new Map<string, Record<string, string>>();
  strings = new Map<string, string>();
  zsets = new Map<string, Map<string, number>>();

  async get(key: string) { return this.strings.get(key) ?? null; }
  async set(key: string, value: string) { this.strings.set(key, value); return 'OK'; }
  async mGet(keys: string[]) { return keys.map((key) => this.strings.get(key) ?? null); }
  async del(key: string) { return this.strings.delete(key) ? 1 : 0; }
  async hGet(key: string, field: string) { return this.hashes.get(key)?.[field] ?? null; }
  async hSet(key: string, field: string, value: string) {
    const hash = this.hashes.get(key) ?? {};
    hash[field] = value;
    this.hashes.set(key, hash);
    return 1;
  }
  async hDel(key: string, field: string) {
    const hash = this.hashes.get(key) ?? {};
    const found = field in hash;
    delete hash[field];
    this.hashes.set(key, hash);
    return found ? 1 : 0;
  }
  async zAdd(key: string, entries: Array<{ score: number; value: string }>) {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    for (const entry of entries) zset.set(entry.value, entry.score);
    this.zsets.set(key, zset);
    return entries.length;
  }
  async zRange(key: string, start: number, stop: number) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(start, stop + 1)
      .map(([value]) => value);
  }
  async zRem(key: string, values: string | string[]) {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    let removed = 0;
    for (const value of Array.isArray(values) ? values : [values]) if (zset.delete(value)) removed += 1;
    return removed;
  }
  async expire() { return true; }
  async eval(_script: string, input: { keys: string[]; arguments: string[] }) {
    if (input.arguments.length === 2) {
      if (input.keys.some((key) => this.strings.has(key))) return 0;
      for (const key of input.keys) this.strings.set(key, input.arguments[0]);
      return 1;
    }
    for (const key of input.keys) {
      if (this.strings.get(key) === input.arguments[0]) this.strings.delete(key);
    }
    return 1;
  }
  multi() {
    const operations: Array<() => Promise<unknown>> = [];
    const chain = {
      set: (key: string, value: string) => { operations.push(() => this.set(key, value)); return chain; },
      del: (key: string) => { operations.push(() => this.del(key)); return chain; },
      hSet: (key: string, field: string, value: string) => { operations.push(() => this.hSet(key, field, value)); return chain; },
      hDel: (key: string, field: string) => { operations.push(() => this.hDel(key, field)); return chain; },
      zAdd: (key: string, entries: Array<{ score: number; value: string }>) => { operations.push(() => this.zAdd(key, entries)); return chain; },
      zRem: (key: string, value: string) => { operations.push(() => this.zRem(key, value)); return chain; },
      expire: () => chain,
      exec: async () => { for (const operation of operations) await operation(); return []; },
    };
    return chain;
  }
}

const state = vi.hoisted(() => ({
  redis: null as FakeRedis | null,
  lobbyConflictUserId: null as string | null,
  activeSessionUserId: null as string | null,
  stalePairings: [] as Array<Record<string, unknown>>,
  markPairingFailed: vi.fn(),
  createPairing: vi.fn(),
  createMatch: vi.fn(async (input: { players: Array<{ userId: string }> }) => ({
    state: {
      matchId: 'grid-match',
      players: input.players,
      phase: 'handoff',
      board: { boardId: 'board-1', boardVersion: 1 },
    },
    created: true,
  })),
  emitMatchFound: vi.fn(),
  emitSessionState: vi.fn(),
  withUserSessionLocks: vi.fn(),
  matchmakingLockAvailable: true,
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    FOOTBALL_GRID_QUEUE_ENABLED: true,
    FOOTBALL_GRID_CONTENT_ENABLED: true,
    FOOTBALL_GRID_BOTS_ENABLED: false,
    FOOTBALL_GRID_BOT_FALLBACK_MS: 30_000,
  },
}));
vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => state.redis }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => state.matchmakingLockAvailable
    ? ({ acquired: true, token: 'mm-lock' })
    : ({ acquired: false, token: null })),
  releaseLock: vi.fn(async () => true),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: vi.fn(),
  cancelRealtimeTimer: vi.fn(),
}));
vi.mock('../../src/modules/football-grid/index.js', () => ({
  FOOTBALL_GRID_HANDOFF_MS: 15_000,
  footballGridRepo: {
    getActiveMatchIdForUser: vi.fn(async () => null),
    countRecentPairingsForCandidates: vi.fn(async (_userId: string, opponentIds: string[]) =>
      new Map(opponentIds.map((opponentId) => [opponentId, 0]))),
    createPairing: (...args: unknown[]) => state.createPairing(...args),
    listStaleClaimedPairings: vi.fn(async () => state.stalePairings),
    markPairingFailed: (...args: unknown[]) => state.markPairingFailed(...args),
  },
  footballGridService: {
    createMatch: (...args: unknown[]) => state.createMatch(...args),
    getState: vi.fn(),
  },
}));
vi.mock('../../src/realtime/services/football-grid-realtime.service.js', () => ({
  footballGridRealtimeService: {
    emitMatchFound: (...args: unknown[]) => state.emitMatchFound(...args),
  },
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService: { ensureProfile: vi.fn() } }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: { isEnabled: () => false, abortLobby: vi.fn(), transferInTx: vi.fn() },
}));
vi.mock('../../src/modules/synthetic-bots/synthetic-bot-selection.service.js', () => ({
  syntheticBotSelectionService: { selectAndReserve: vi.fn(), recordRecentlyFaced: vi.fn() },
}));
vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: { bumpMatchesTodayAndSelectedAtTx: vi.fn() },
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    withUserSessionLock: vi.fn(async (_userId: string, work: () => Promise<unknown>) => work()),
    withUserSessionLocks: (...args: unknown[]) => state.withUserSessionLocks(...args),
    prepareForQueueJoin: vi.fn(async () => ({
      ok: true,
      snapshot: { state: 'IDLE', activeMatchId: null, queueSearchId: null, openLobbyIds: [] },
    })),
    resolveStates: vi.fn(async (userIds: string[]) => new Map(await Promise.all(userIds.map(async (userId) => {
      const searchId = await state.redis?.hGet('football_grid:mm:user', userId) ?? null;
      const conflicted = state.lobbyConflictUserId === userId;
      return [userId, {
        state: conflicted ? 'CORRUPT_MULTI_STATE' : 'IN_QUEUE',
        activeMatchId: null,
        waitingLobbyId: conflicted ? 'other-lobby' : null,
        queueSearchId: searchId,
        openLobbyIds: conflicted ? ['other-lobby'] : [],
        resolvedAt: new Date().toISOString(),
      }];
    })))),
    resolveState: vi.fn(async (userId: string) => ({
      state: state.activeSessionUserId === userId ? 'IN_ACTIVE_MATCH' : 'IDLE',
      activeMatchId: state.activeSessionUserId === userId ? 'other-match' : null,
      waitingLobbyId: null,
      queueSearchId: await state.redis?.hGet('football_grid:mm:user', userId) ?? null,
      openLobbyIds: [],
      resolvedAt: new Date().toISOString(),
    })),
    emitBlocked: vi.fn(),
    emitState: (...args: unknown[]) => state.emitSessionState(...args),
  },
}));

import { footballGridMatchmakingService } from '../../src/realtime/services/football-grid-matchmaking.service.js';

function socket(userId: string) {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId, nickname: userId } },
    emit: vi.fn(),
  } as never;
}

const io = {
  to: vi.fn(() => ({ emit: vi.fn() })),
  in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
} as never;

describe('footballGridMatchmakingService session fencing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.redis = new FakeRedis();
    state.lobbyConflictUserId = null;
    state.activeSessionUserId = null;
    state.stalePairings = [];
    state.matchmakingLockAvailable = true;
    state.createMatch.mockImplementation(async (input: { players: Array<{ userId: string }> }) => ({
      state: {
        matchId: 'grid-1',
        players: input.players,
        phase: 'handoff',
        board: { boardId: 'board-1', boardVersion: 1 },
      },
      created: true,
    }));
    state.withUserSessionLocks.mockImplementation(async (_userIds, work) => work());
    state.emitSessionState.mockResolvedValue(undefined);
  });

  it('starts a human match immediately when the second search joins', async () => {
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-a'), { locale: 'en' });
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-b'), { locale: 'en' });

    expect(state.withUserSessionLocks).toHaveBeenCalledWith(
      expect.arrayContaining(['user-a', 'user-b']),
      expect.any(Function),
      { waitMs: 1_200 },
    );
    expect(state.createMatch).toHaveBeenCalledOnce();
    expect(state.emitMatchFound).toHaveBeenCalledOnce();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toEqual([]);
  });

  it('keeps a search queued when another replica is draining matchmaking', async () => {
    state.matchmakingLockAvailable = false;
    const userSocket = socket('queued-user');

    await footballGridMatchmakingService.handleSearchStart(io, userSocket, { locale: 'en' });

    expect(await state.redis!.hGet('football_grid:mm:user', 'queued-user')).not.toBeNull();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toHaveLength(1);
    expect(userSocket.emit).not.toHaveBeenCalledWith(
      'grid:error',
      expect.objectContaining({ code: 'GRID_SEARCH_BUSY' }),
    );
  });

  it('starts independent queued pairs concurrently under one drain lock', async () => {
    state.matchmakingLockAvailable = false;
    for (const userId of ['user-a', 'user-b', 'user-c', 'user-d']) {
      await footballGridMatchmakingService.handleSearchStart(io, socket(userId), { locale: 'en' });
    }

    let activeCreates = 0;
    let peakCreates = 0;
    state.createMatch.mockImplementation(async (input: { players: Array<{ userId: string }> }) => {
      activeCreates += 1;
      peakCreates = Math.max(peakCreates, activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCreates -= 1;
      return {
        state: {
          matchId: `grid-${input.players[0].userId}`,
          players: input.players,
          phase: 'handoff',
          board: { boardId: 'board-1', boardVersion: 1 },
        },
        created: true,
      };
    });
    state.matchmakingLockAvailable = true;

    await footballGridMatchmakingService.handleSearchStart(io, socket('user-e'), { locale: 'en' });

    expect(state.createMatch).toHaveBeenCalledTimes(2);
    expect(peakCreates).toBe(2);
  });

  it('keeps a committed pair and continues draining after post-commit handoff failure', async () => {
    state.emitMatchFound.mockRejectedValueOnce(new Error('socket adapter unavailable'));

    await footballGridMatchmakingService.handleSearchStart(io, socket('user-a'), { locale: 'en' });
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-b'), { locale: 'en' });
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-c'), { locale: 'en' });
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-d'), { locale: 'en' });

    expect(state.createMatch).toHaveBeenCalledTimes(2);
    expect(state.markPairingFailed).not.toHaveBeenCalled();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toEqual([]);
  });

  it('revalidates both users and refuses pairing when one joined a lobby', async () => {
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-a'), { locale: 'en' });
    state.lobbyConflictUserId = 'user-b';
    await footballGridMatchmakingService.handleSearchStart(io, socket('user-b'), { locale: 'en' });

    expect(state.createMatch).not.toHaveBeenCalled();
    expect((await state.redis!.zRange('football_grid:mm:queue', 0, 10))).toHaveLength(2);
  });

  it('expires a search at its original queue deadline instead of refreshing it forever', async () => {
    const expired = {
      searchId: '00000000-0000-4000-8000-000000000199',
      userId: 'expired-user',
      displayName: 'Expired',
      locale: 'en',
      queuedAt: Date.now() - 181_000,
      fallbackAt: Date.now() - 1_000,
    };
    await state.redis!.set(`football_grid:mm:search:${expired.searchId}`, JSON.stringify(expired));
    await state.redis!.hSet('football_grid:mm:user', expired.userId, expired.searchId);
    await state.redis!.zAdd('football_grid:mm:queue', [{ score: expired.queuedAt, value: expired.searchId }]);

    await footballGridMatchmakingService.handleFallbackTimer(io, expired.searchId, expired.userId);

    expect(await state.redis!.hGet('football_grid:mm:user', expired.userId)).toBeNull();
    expect(await state.redis!.get(`football_grid:mm:search:${expired.searchId}`)).toBeNull();
    expect(state.createMatch).not.toHaveBeenCalled();
    expect(state.emitSessionState).toHaveBeenCalledWith(io, expired.userId);
  });

  it('recovers stale pairings under both user locks and restores only still-eligible humans', async () => {
    const now = Date.now() - 30_000;
    const searchA = {
      searchId: '00000000-0000-4000-8000-000000000101',
      userId: 'user-a',
      displayName: 'A',
      locale: 'en',
      queuedAt: now,
      fallbackAt: now,
    };
    const searchB = {
      searchId: '00000000-0000-4000-8000-000000000102',
      userId: 'user-b',
      displayName: 'B',
      locale: 'en',
      queuedAt: now,
      fallbackAt: now,
    };
    state.activeSessionUserId = 'user-b';
    state.stalePairings = [{
      pairingToken: 'pairing-token',
      userAId: 'user-a',
      userBId: 'user-b',
      opponentType: 'human',
      searchASnapshot: searchA,
      searchBSnapshot: searchB,
    }];

    await footballGridMatchmakingService.reconcileStalePairings(io);

    expect(state.withUserSessionLocks).toHaveBeenCalledWith(
      ['user-a', 'user-b'],
      expect.any(Function),
      { waitMs: 1_200 },
    );
    expect(state.markPairingFailed).toHaveBeenCalledWith(
      'pairing-token',
      'recovered_after_interrupted_pairing',
    );
    expect(await state.redis!.hGet('football_grid:mm:user', 'user-a')).toBe(searchA.searchId);
    expect(await state.redis!.hGet('football_grid:mm:user', 'user-b')).toBeNull();
  });
});
