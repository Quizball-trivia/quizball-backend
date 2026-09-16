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
  activeMatchByUser: new Map<string, string>(),
  stalePairings: [] as Array<Record<string, unknown>>,
  markPairingFailed: vi.fn(),
  createPairing: vi.fn(),
  heartbeatPairing: vi.fn(async () => true),
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
  matchmakingLockHeld: false,
}));

const flags = vi.hoisted(() => ({ guestBotMatches: true, rateLimited: false }));
vi.mock('../../src/core/config.js', () => ({
  config: {
    FOOTBALL_GRID_QUEUE_ENABLED: true,
    FOOTBALL_GRID_CONTENT_ENABLED: true,
    FOOTBALL_GRID_BOTS_ENABLED: true,
    FOOTBALL_GRID_BOT_FALLBACK_MS: 30_000,
    FOOTBALL_GRID_MM_SWEEP_MS: 750,
    FOOTBALL_GRID_BOT_MODEL_VERSION: 2,
    get GUEST_BOT_MATCHES_ENABLED() { return flags.guestBotMatches; },
  },
}));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({
  allowGuestOperation: vi.fn(async () => !flags.rateLimited),
}));
vi.mock('../../src/realtime/socket-auth.js', () => ({ socketIpBucket: () => 'ip-bucket' }));
vi.mock('../../src/core/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => state.redis }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => {
    if (!state.matchmakingLockAvailable) return { acquired: false, token: null };
    state.matchmakingLockHeld = true;
    return { acquired: true, token: 'mm-lock' };
  }),
  releaseLock: vi.fn(async () => {
    state.matchmakingLockHeld = false;
    return true;
  }),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));
vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: vi.fn(),
  cancelRealtimeTimer: vi.fn(),
}));
vi.mock('../../src/modules/football-grid/index.js', () => ({
  FOOTBALL_GRID_HANDOFF_MS: 30_000,
  footballGridRepo: {
    getActiveMatchIdForUser: vi.fn(async (userId: string) => state.activeMatchByUser.get(userId) ?? null),
    countRecentPairingsForCandidates: vi.fn(async (_userId: string, opponentIds: string[]) =>
      new Map(opponentIds.map((opponentId) => [opponentId, 0]))),
    createPairing: (...args: unknown[]) => state.createPairing(...args),
    heartbeatPairing: (...args: unknown[]) => state.heartbeatPairing(...args),
    listStaleClaimedPairings: vi.fn(async () => state.stalePairings),
    markPairingFailed: (...args: unknown[]) => state.markPairingFailed(...args),
  },
  footballGridService: {
    createMatch: (...args: unknown[]) => state.createMatch(...args),
    getState: vi.fn(async (matchId: string) => ({ matchId, phase: 'active', players: [] })),
    resolveStaleMatchOnSearchStart: vi.fn(async () => 'resumable'),
  },
}));
vi.mock('../../src/realtime/services/football-grid-realtime.service.js', () => ({
  footballGridRealtimeService: {
    emitMatchFound: (...args: unknown[]) => state.emitMatchFound(...args),
  },
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({ rankedService: { ensureProfile: vi.fn() } }));
const reservation = vi.hoisted(() => ({ abortLobby: vi.fn(async () => {}), transferInTx: vi.fn(async () => true) }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: { isEnabled: () => true, abortLobby: reservation.abortLobby, transferInTx: reservation.transferInTx },
}));
vi.mock('../../src/modules/synthetic-bots/synthetic-bot-selection.service.js', () => ({
  syntheticBotSelectionService: {
    selectAndReserve: vi.fn(async () => ({ bot: { user_id: 'bot-1', rp: 500, tier: 'Youth Prospect' }, reservation: { fence: 'fence-1' } })),
    recordRecentlyFaced: vi.fn(async () => {}),
  },
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
        primaryLobbyStatus: conflicted ? 'waiting' as const : null,
        queueSearchId: searchId,
        openLobbyIds: conflicted ? ['other-lobby'] : [],
        resolvedAt: new Date().toISOString(),
      }];
    })))),
    resolveState: vi.fn(async (userId: string) => ({
      state: state.activeSessionUserId === userId ? 'IN_ACTIVE_MATCH' : 'IDLE',
      activeMatchId: state.activeSessionUserId === userId ? 'other-match' : null,
      waitingLobbyId: null,
      primaryLobbyStatus: null,
      queueSearchId: await state.redis?.hGet('football_grid:mm:user', userId) ?? null,
      openLobbyIds: [],
      resolvedAt: new Date().toISOString(),
    })),
    emitBlocked: vi.fn(),
    emitState: (...args: unknown[]) => state.emitSessionState(...args),
  },
}));

import { footballGridMatchmakingService } from '../../src/realtime/services/football-grid-matchmaking.service.js';

function socket(userId: string, isGuest = true) {
  return {
    id: `socket-${userId}`,
    data: { user: { id: userId, nickname: userId, is_guest: isGuest } },
    emit: vi.fn(),
    handshake: { address: '127.0.0.1', headers: {} },
  } as never;
}
function emitted(target: never, event: string) {
  return (target as { emit: { mock: { calls: unknown[][] } } }).emit.mock.calls.filter(([name]) => name === event).map(([, payload]) => payload);
}

const io = {
  to: vi.fn(() => ({ emit: vi.fn() })),
  in: vi.fn(() => ({ fetchSockets: vi.fn(async () => []) })),
} as never;


describe('footballGridMatchmakingService.handlePracticeBotStart (guest "Play now")', () => {
  beforeEach(() => {
    footballGridMatchmakingService.stopSweep();
    vi.clearAllMocks();
    flags.guestBotMatches = true;
    flags.rateLimited = false;
    state.redis = new FakeRedis();
    state.lobbyConflictUserId = null;
    state.activeSessionUserId = null;
    state.activeMatchByUser = new Map();
    state.stalePairings = [];
    state.matchmakingLockAvailable = true;
    state.heartbeatPairing.mockResolvedValue(true);
    state.markPairingFailed.mockResolvedValue(true);
    state.createMatch.mockImplementation(async (input: { players: Array<{ userId: string }> }) => ({
      state: { matchId: 'grid-practice', players: input.players, phase: 'handoff', board: { boardId: 'board-1', boardVersion: 1 } },
      created: true,
    }));
    state.withUserSessionLocks.mockImplementation(async (_userIds, work) => work());
    state.emitSessionState.mockResolvedValue(undefined);
  });

  it('pairs a guest with a bot immediately without ever entering the queue', async () => {
    const guest = socket('guest-1');
    await footballGridMatchmakingService.handlePracticeBotStart(io, guest, { locale: 'en', theme: 'european' });
    expect(state.createMatch).toHaveBeenCalledTimes(1);
    const input = state.createMatch.mock.calls[0][0] as { origin: string; players: Array<{ userId: string; isBot?: boolean }> };
    expect(input.players).toEqual([{ userId: 'guest-1', seat: 1 }, { userId: 'bot-1', seat: 2, isBot: true }]);
    expect(state.emitMatchFound).toHaveBeenCalledTimes(1);
    // Never queued: no user-map entry, nothing in the sorted set.
    expect(await state.redis!.hGet('football_grid:mm:user', 'guest-1')).toBeNull();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toEqual([]);
    expect(emitted(guest, 'grid:error')).toEqual([]);
  });

  it('refuses members — they play through matchmaking', async () => {
    const member = socket('member-1', false);
    await footballGridMatchmakingService.handlePracticeBotStart(io, member, { locale: 'en', theme: 'european' });
    expect(state.createMatch).not.toHaveBeenCalled();
    expect(emitted(member, 'grid:error')).toEqual([expect.objectContaining({ code: 'GRID_PRACTICE_GUEST_ONLY' })]);
  });

  it('is a no-op behind the kill switch and under the rate limit', async () => {
    flags.guestBotMatches = false;
    const guest = socket('guest-2');
    await footballGridMatchmakingService.handlePracticeBotStart(io, guest, { locale: 'en', theme: 'european' });
    expect(emitted(guest, 'grid:error')).toEqual([expect.objectContaining({ code: 'GRID_UNAVAILABLE' })]);

    flags.guestBotMatches = true;
    flags.rateLimited = true;
    const limited = socket('guest-3');
    await footballGridMatchmakingService.handlePracticeBotStart(io, limited, { locale: 'en', theme: 'european' });
    expect(emitted(limited, 'grid:error')).toEqual([expect.objectContaining({ code: 'GRID_RATE_LIMITED' })]);
    expect(state.createMatch).not.toHaveBeenCalled();
  });

  it('refuses a duplicate start while the guest already has a live session (second tab)', async () => {
    state.activeSessionUserId = 'guest-4';
    const guest = socket('guest-4');
    await footballGridMatchmakingService.handlePracticeBotStart(io, guest, { locale: 'en', theme: 'european' });
    expect(state.createMatch).not.toHaveBeenCalled();
    expect(emitted(guest, 'grid:error')).toEqual([expect.objectContaining({ code: 'GRID_BOT_UNAVAILABLE' })]);
  });

  it('re-delivers the match a concurrent start already created instead of failing', async () => {
    // The session re-check under the lock refuses this request (the other tab
    // won), and by then the winner's match is the guest's active match.
    state.activeSessionUserId = 'guest-7';
    state.withUserSessionLocks.mockImplementation(async (_userIds, work) => {
      state.activeMatchByUser.set('guest-7', 'winner-match');
      return work();
    });
    state.emitMatchFound.mockResolvedValueOnce(true);
    const guest = socket('guest-7');
    await footballGridMatchmakingService.handlePracticeBotStart(io, guest, { locale: 'en', theme: 'european' });
    expect(state.createMatch).not.toHaveBeenCalled();
    expect(state.emitMatchFound).toHaveBeenCalledWith(io, expect.objectContaining({ matchId: 'winner-match' }));
    expect(emitted(guest, 'grid:error')).toEqual([]);
    expect(emitted(guest, 'grid:search_state').some((payload) => (payload as { state: string }).state === 'idle')).toBe(false);
  });

  it('leaves the guest idle (never queued) when the bot match cannot be created', async () => {
    state.createMatch.mockRejectedValueOnce(new Error('boom'));
    const guest = socket('guest-5');
    await footballGridMatchmakingService.handlePracticeBotStart(io, guest, { locale: 'en', theme: 'european' });
    expect(reservation.abortLobby).toHaveBeenCalled();
    expect(await state.redis!.hGet('football_grid:mm:user', 'guest-5')).toBeNull();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toEqual([]);
    expect(emitted(guest, 'grid:error')).toEqual([expect.objectContaining({ code: 'GRID_BOT_UNAVAILABLE' })]);
  });

  it('never restores a practice search into the human queue during stale-pairing recovery', async () => {
    state.stalePairings = [{
      pairingToken: 'stale-practice',
      opponentType: 'bot',
      userAId: 'guest-6',
      userBId: 'bot-1',
      searchASnapshot: {
        searchId: 'search-practice', userId: 'guest-6', displayName: 'guest-6', locale: 'en', theme: 'european',
        queuedAt: Date.now(), fallbackAt: Date.now(), practice: true,
      },
      searchBSnapshot: null,
    }];
    await footballGridMatchmakingService.reconcileStalePairings(io);
    expect(state.markPairingFailed).toHaveBeenCalledWith('stale-practice', 'recovered_after_interrupted_pairing');
    expect(await state.redis!.hGet('football_grid:mm:user', 'guest-6')).toBeNull();
    expect(await state.redis!.zRange('football_grid:mm:queue', 0, 10)).toEqual([]);
  });
});
