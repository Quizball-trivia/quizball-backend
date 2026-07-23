import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import { registerRankedHandlers } from '../../src/realtime/handlers/ranked.handler.js';
import { AppError } from '../../src/core/errors.js';
import {
  RANKED_MM_CANCEL_SEARCH_SCRIPT,
  RANKED_MM_CLAIM_FALLBACK_SCRIPT,
  RANKED_MM_PAIR_TWO_OLDEST_SCRIPT,
  RANKED_MM_STALE_RESULT,
} from '../../src/realtime/lua/ranked-matchmaking.scripts.js';
import '../setup.js';

type RedisMultiOp = () => void | Promise<void>;

class FakeRedis {
  private kv = new Map<string, string>();
  private kvExpiresAt = new Map<string, number>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private failAssignedLobbyWrites = false;

  rejectAssignedLobbyWrites(): void {
    this.failAssignedLobbyWrites = true;
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number; PX?: number }
  ): Promise<'OK' | null> {
    if (this.failAssignedLobbyWrites && key.startsWith('ranked:mm:assigned-lobby:')) {
      throw new Error('assigned-lobby marker unavailable');
    }
    this.expireKvIfDue(key);
    if (options?.NX && this.kv.has(key)) return null;
    this.kv.set(key, value);
    if (typeof options?.EX === 'number') {
      this.kvExpiresAt.set(key, Date.now() + options.EX * 1_000);
    } else if (typeof options?.PX === 'number') {
      this.kvExpiresAt.set(key, Date.now() + options.PX);
    } else {
      this.kvExpiresAt.delete(key);
    }
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.expireKvIfDue(key);
    return this.kv.get(key) ?? null;
  }

  async del(keyOrKeys: string | string[]): Promise<number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    let removed = 0;
    for (const key of keys) {
      this.expireKvIfDue(key);
      if (this.kv.delete(key)) removed += 1;
      this.kvExpiresAt.delete(key);
      if (this.hashes.delete(key)) removed += 1;
      if (this.zsets.delete(key)) removed += 1;
    }
    return removed;
  }

  async exists(key: string): Promise<number> {
    this.expireKvIfDue(key);
    return this.kv.has(key) || this.hashes.has(key) || this.zsets.has(key) ? 1 : 0;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async hGet(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hSet(key: string, fieldOrObject: string | Record<string, string>, value?: string): Promise<number> {
    const hash = this.getOrCreateHash(key);
    if (typeof fieldOrObject === 'string') {
      hash.set(fieldOrObject, value ?? '');
      return 1;
    }
    Object.entries(fieldOrObject).forEach(([field, v]) => { hash.set(field, String(v)); });
    return 1;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash.entries());
  }

  async hDel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    let removed = 0;
    for (const field of fields) {
      if (hash.delete(field)) removed += 1;
    }
    return removed;
  }

  async zAdd(key: string, item: { score: number; value: string }): Promise<number> {
    const zset = this.getOrCreateZset(key);
    zset.set(item.value, item.score);
    return 1;
  }

  async zRangeByScore(
    key: string,
    min: number,
    max: number,
    options?: { LIMIT?: { offset: number; count: number } }
  ): Promise<string[]> {
    const zset = this.zsets.get(key);
    if (!zset) return [];
    const sorted = [...zset.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([value]) => value);

    const offset = options?.LIMIT?.offset ?? 0;
    const count = options?.LIMIT?.count ?? sorted.length;
    return sorted.slice(offset, offset + count);
  }

  async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  multi(): {
    hSet: (
      key: string,
      fieldOrObject: string | Record<string, string>,
      value?: string
    ) => ReturnType<FakeRedis['multi']>;
    expire: (key: string, seconds: number) => ReturnType<FakeRedis['multi']>;
    zAdd: (key: string, item: { score: number; value: string }) => ReturnType<FakeRedis['multi']>;
    exec: () => Promise<(unknown | null)[]>;
  } {
    const ops: RedisMultiOp[] = [];
    const chain = {
      hSet: (
        key: string,
        fieldOrObject: string | Record<string, string>,
        value?: string
      ) => {
        ops.push(() => this.hSet(key, fieldOrObject, value));
        return chain;
      },
      expire: (key: string, seconds: number) => {
        ops.push(() => this.expire(key, seconds));
        return chain;
      },
      zAdd: (key: string, item: { score: number; value: string }) => {
        ops.push(() => this.zAdd(key, item));
        return chain;
      },
      exec: async () => {
        const results: (unknown | null)[] = [];
        for (const op of ops) {
          results.push(await op());
        }
        return results;
      },
    };
    return chain;
  }

  forceAllTimeoutsDue(nowMs: number): void {
    const timeouts = this.zsets.get('ranked:mm:timeouts');
    if (!timeouts) return;
    for (const key of timeouts.keys()) {
      timeouts.set(key, nowMs - 1);
      const searchHash = this.hashes.get(`ranked:mm:search:${key}`);
      if (searchHash && searchHash.get('status') === 'queued') {
        searchHash.set('deadlineAt', String(nowMs - 1));
      }
    }
  }

  getUserSearchId(userId: string): string | null {
    return this.hashes.get('ranked:mm:user')?.get(userId) ?? null;
  }

  async eval(
    script: string,
    data: {
      keys: string[];
      arguments: string[];
    }
  ): Promise<string[]> {
    if (script === RANKED_MM_PAIR_TWO_OLDEST_SCRIPT) {
      const queueKey = data.keys[0];
      const timeoutKey = data.keys[1];
      const userMapKey = data.keys[2];
      const searchPrefix = data.arguments[0] ?? 'ranked:mm:search:';
      const matchedAt = data.arguments[1] ?? String(Date.now());
      const pairingPrefix = data.arguments[2] ?? 'ranked:mm:pairing:';
      const pairingTtlSec = Number(data.arguments[3] ?? 30);

      const queue = this.zsets.get(queueKey);
      if (!queue || queue.size < 2) return [];

      const picks = [...queue.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, 2)
        .map(([searchId]) => searchId);
      if (picks.length < 2) return [];

      const [searchIdA, searchIdB] = picks;
      const searchKeyA = `${searchPrefix}${searchIdA}`;
      const searchKeyB = `${searchPrefix}${searchIdB}`;
      const statusA = await this.hGet(searchKeyA, 'status');
      const statusB = await this.hGet(searchKeyB, 'status');
      if (statusA !== 'queued' || statusB !== 'queued') return [];

      const userIdA = await this.hGet(searchKeyA, 'userId');
      const userIdB = await this.hGet(searchKeyB, 'userId');
      if (!userIdA || !userIdB) return [];

      await this.hSet(searchKeyA, { status: 'matched', matchedAt });
      await this.hSet(searchKeyB, { status: 'matched', matchedAt });
      queue.delete(searchIdA);
      queue.delete(searchIdB);
      this.zsets.get(timeoutKey)?.delete(searchIdA);
      this.zsets.get(timeoutKey)?.delete(searchIdB);
      await this.hDel(userMapKey, userIdA, userIdB);
      await this.set(`${pairingPrefix}${userIdA}`, '1', { EX: pairingTtlSec });
      await this.set(`${pairingPrefix}${userIdB}`, '1', { EX: pairingTtlSec });
      return [searchIdA, userIdA, searchIdB, userIdB];
    }

    if (script === RANKED_MM_CLAIM_FALLBACK_SCRIPT) {
      const queueKey = data.keys[0];
      const timeoutKey = data.keys[1];
      const userMapKey = data.keys[2];
      const searchKey = data.keys[3];
      const searchId = data.arguments[0] ?? '';
      const nowMs = Number(data.arguments[1] ?? Date.now());
      const fallbackAt = data.arguments[2] ?? String(Date.now());

      const status = await this.hGet(searchKey, 'status');
      if (status !== 'queued') return [];
      const deadlineAt = Number(await this.hGet(searchKey, 'deadlineAt'));
      if (!Number.isFinite(deadlineAt) || deadlineAt > nowMs) return [];

      const userId = await this.hGet(searchKey, 'userId');
      if (!userId) return [];

      await this.hSet(searchKey, { status: 'fallback', fallbackAt });
      this.zsets.get(queueKey)?.delete(searchId);
      this.zsets.get(timeoutKey)?.delete(searchId);
      await this.hDel(userMapKey, userId);
      return [userId];
    }

    if (script === RANKED_MM_CANCEL_SEARCH_SCRIPT) {
      const queueKey = data.keys[0];
      const timeoutKey = data.keys[1];
      const userMapKey = data.keys[2];
      const searchPrefix = data.arguments[0] ?? 'ranked:mm:search:';
      const userId = data.arguments[1] ?? '';
      const cancelledAt = data.arguments[2] ?? String(Date.now());

      const searchId = await this.hGet(userMapKey, userId);
      if (!searchId) return [];

      const searchKey = `${searchPrefix}${searchId}`;
      const status = await this.hGet(searchKey, 'status');
      if (status !== 'queued') return [];

      await this.hSet(searchKey, { status: 'cancelled', cancelledAt });
      this.zsets.get(queueKey)?.delete(searchId);
      this.zsets.get(timeoutKey)?.delete(searchId);
      await this.hDel(userMapKey, userId);
      return [searchId];
    }

    if (data.keys.length === 1 && data.arguments.length === 1) {
      const key = data.keys[0];
      const token = data.arguments[0];
      if (this.kv.get(key) === token) {
        this.kv.delete(key);
        return 1 as unknown as string[];
      }
      return 0 as unknown as string[];
    }

    return [];
  }

  private expireKvIfDue(key: string): void {
    const expiresAt = this.kvExpiresAt.get(key);
    if (expiresAt === undefined || expiresAt > Date.now()) return;
    this.kv.delete(key);
    this.kvExpiresAt.delete(key);
  }

  private getOrCreateHash(key: string): Map<string, string> {
    const existing = this.hashes.get(key);
    if (existing) return existing;
    const map = new Map<string, string>();
    this.hashes.set(key, map);
    return map;
  }

  private getOrCreateZset(key: string): Map<string, number> {
    const existing = this.zsets.get(key);
    if (existing) return existing;
    const map = new Map<string, number>();
    this.zsets.set(key, map);
    return map;
  }
}

class TestSocket {
  public data: QuizballSocket['data'];
  private readonly inbound = new Map<string, ((payload?: unknown) => void | Promise<void>)[]>();
  private readonly outbound = new Map<string, ((payload?: unknown) => void)[]>();
  private readonly rooms = new Set<string>();
  constructor(
    private readonly io: TestIo,
    userId: string
  ) {
    this.data = { user: { id: userId, role: 'user' } };
  }

  on(event: string, handler: (payload?: unknown) => void | Promise<void>): this {
    const handlers = this.inbound.get(event) ?? [];
    handlers.push(handler);
    this.inbound.set(event, handlers);
    return this;
  }

  onceOutbound(event: string, handler: (payload?: unknown) => void): void {
    const wrapped = (payload?: unknown) => {
      this.offOutbound(event, wrapped);
      handler(payload);
    };
    const handlers = this.outbound.get(event) ?? [];
    handlers.push(wrapped);
    this.outbound.set(event, handlers);
  }

  offOutbound(event: string, handler: (payload?: unknown) => void): void {
    const handlers = this.outbound.get(event) ?? [];
    this.outbound.set(
      event,
      handlers.filter((entry) => entry !== handler)
    );
  }

  emit(event: string, payload?: unknown): boolean {
    const handlers = this.outbound.get(event) ?? [];
    handlers.forEach((handler) => handler(payload));
    return true;
  }

  async trigger(event: string, payload?: unknown): Promise<void> {
    const handlers = this.inbound.get(event) ?? [];
    for (const handler of handlers) {
      await handler(payload);
    }
  }

  join(room: string): this {
    this.rooms.add(room);
    this.io.joinRoom(room, this);
    return this;
  }

  leave(room: string): this {
    this.rooms.delete(room);
    this.io.leaveRoom(room, this);
    return this;
  }

  inRoom(room: string): boolean {
    return this.rooms.has(room);
  }
}

class TestIo {
  private readonly roomMap = new Map<string, Set<TestSocket>>();
  private fetchSocketFailuresRemaining = 0;
  constructor(private readonly sockets: TestSocket[]) {}

  failNextFetchSockets(count: number): void {
    this.fetchSocketFailuresRemaining = count;
  }

  to(room: string): { emit: (event: string, payload?: unknown) => void } {
    return {
      emit: (event: string, payload?: unknown) => {
        const sockets = this.roomMap.get(room) ?? new Set<TestSocket>();
        sockets.forEach((socket) => {
          socket.emit(event, payload);
        });
      },
    };
  }

  in(room: string): {
    socketsJoin: (targetRoom: string) => Promise<void>;
    fetchSockets: () => Promise<TestSocket[]>;
  } {
    return {
      socketsJoin: async (targetRoom: string) => {
        const sockets = this.roomMap.get(room) ?? new Set<TestSocket>();
        sockets.forEach((socket) => socket.join(targetRoom));
      },
      fetchSockets: async () => {
        if (this.fetchSocketFailuresRemaining > 0) {
          this.fetchSocketFailuresRemaining -= 1;
          throw new Error('adapter unavailable');
        }
        return [...(this.roomMap.get(room) ?? new Set<TestSocket>())];
      },
    };
  }

  joinRoom(room: string, socket: TestSocket): void {
    const sockets = this.roomMap.get(room) ?? new Set<TestSocket>();
    sockets.add(socket);
    this.roomMap.set(room, sockets);
  }

  leaveRoom(room: string, socket: TestSocket): void {
    const sockets = this.roomMap.get(room);
    if (!sockets) return;
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.roomMap.delete(room);
    }
  }
}

const mockStartDraft = vi.fn();
const mockGetWallet = vi.fn(async () => ({ coins: 0, tickets: 1 }));
const mockStartRankedAiForUser = vi.fn(async (io: QuizballServer, userId: string) => {
  io.to(`user:${userId}`).emit('ranked:match_found', {
    lobbyId: `ai-lobby-${userId}`,
    opponent: {
      id: `ai-${userId}`,
      username: 'AI Opponent',
      avatarUrl: null,
    },
  });
});

let fakeRedis: FakeRedis;
let lobbyCounter = 0;
const lobbyMembers = new Map<string, string[]>();

vi.mock('../../src/core/config.js', () => ({
  config: {
    RANKED_HUMAN_QUEUE_ENABLED: true,
  },
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => fakeRedis,
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'lock-token' })),
  releaseLock: vi.fn(async () => undefined),
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    resolveState: vi.fn(async (userId: string) => {
      const queueSearchId = fakeRedis?.getUserSearchId(userId) ?? null;
      return {
        state: queueSearchId ? 'IN_QUEUE' : 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId,
        openLobbyIds: [],
        resolvedAt: new Date().toISOString(),
      };
    }),
    resolveStates: vi.fn(async (userIds: string[]) => new Map(userIds.map((userId) => {
      const queueSearchId = fakeRedis?.getUserSearchId(userId) ?? null;
      return [userId, {
        state: queueSearchId ? 'IN_QUEUE' : 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId,
        openLobbyIds: [],
        resolvedAt: new Date().toISOString(),
      }];
    }))),
    runWithUserTransitionLock: vi.fn(async (_io: QuizballServer, _socket: QuizballSocket, work: () => Promise<void>) => {
      await work();
      return true;
    }),
    prepareForQueueJoin: vi.fn(async () => ({
      ok: true,
      snapshot: {
        state: 'IDLE',
        activeMatchId: null,
        waitingLobbyId: null,
        queueSearchId: null,
        openLobbyIds: [],
        resolvedAt: new Date().toISOString(),
      },
    })),
    emitState: vi.fn(async () => undefined),
    emitBlocked: vi.fn(),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  const getById = vi.fn(async (userId: string) => ({
    id: userId,
    nickname: userId,
    avatar_url: null,
  }));
  return {
    usersRepo: {
      getById,
      getByIds: vi.fn(async (ids: string[]) => {
        const usersById = new Map<string, Awaited<ReturnType<typeof getById>>>();
        for (const id of [...new Set(ids)]) {
          const user = await getById(id);
          if (user) usersById.set(id, user);
        }
        return usersById;
      }),
    },
  };
});

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: vi.fn(async () => ({
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'placed',
      placement_required: 3,
      placement_played: 3,
      placement_wins: 2,
    })),
    ensureProfiles: vi.fn(async (userIds: string[]) => new Map(userIds.map((userId) => [userId, {
      user_id: userId,
      rp: 1200,
      tier: 'Rotation',
      placement_status: 'placed',
      placement_required: 3,
      placement_played: 3,
      placement_wins: 2,
    }]))),
  },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: {
    getWallet: (...args: unknown[]) => mockGetWallet(...args),
    getRankedTicketWallets: async (userIds: string[]) => new Map(
      await Promise.all(userIds.map(async (userId) => [userId, await mockGetWallet(userId)] as const))
    ),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => {
  const createLobby = async ({ hostUserId }: { hostUserId: string }) => {
    lobbyCounter += 1;
    const id = `lobby-${lobbyCounter}`;
    lobbyMembers.set(id, [hostUserId]);
    return {
      id,
      mode: 'ranked',
      status: 'waiting',
      host_user_id: hostUserId,
      invite_code: null,
      display_name: null,
      is_public: false,
      game_mode: 'ranked_sim',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  };

  return {
    lobbiesRepo: {
      createLobby: vi.fn(createLobby),
      createLobbyWithMembers: vi.fn(async (
        data: { hostUserId: string },
        members: Array<{ userId: string }>,
      ) => {
        const lobby = await createLobby(data);
        lobbyMembers.set(lobby.id, members.map((member) => member.userId));
        return lobby;
      }),
      addMember: vi.fn(async (lobbyId: string, userId: string) => {
        const members = lobbyMembers.get(lobbyId) ?? [];
        if (!members.includes(userId)) {
          members.push(userId);
        }
        lobbyMembers.set(lobbyId, members);
      }),
      getById: vi.fn(async (lobbyId: string) => ({
        id: lobbyId,
        mode: 'ranked',
        status: 'waiting',
        host_user_id: lobbyMembers.get(lobbyId)?.[0] ?? 'u1',
        invite_code: null,
        display_name: null,
        is_public: false,
        game_mode: 'ranked_sim',
        friendly_random: true,
        friendly_category_a_id: null,
        friendly_category_b_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })),
    },
  };
});

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    buildLobbyState: vi.fn(async (lobby: { id: string; host_user_id: string }) => ({
      lobbyId: lobby.id,
      mode: 'ranked',
      status: 'waiting',
      inviteCode: null,
      displayName: null,
      hostUserId: lobby.host_user_id,
      isPublic: false,
      settings: {
        gameMode: 'ranked_sim',
        friendlyRandom: true,
        friendlyCategoryAId: null,
        friendlyCategoryBId: null,
      },
      members: (lobbyMembers.get(lobby.id) ?? []).map((userId) => ({
        userId,
        isHost: userId === lobby.host_user_id,
        ready: true,
        user: {
          id: userId,
          username: userId,
          avatarUrl: null,
        },
      })),
    })),
  },
}));

vi.mock('../../src/realtime/services/lobby-realtime.service.js', () => ({
  startDraft: (...args: unknown[]) => mockStartDraft(...args),
  startRankedAiForUser: (...args: unknown[]) => mockStartRankedAiForUser(...args),
}));

function waitForEvent<T = unknown>(socket: TestSocket, eventName: string, timeoutMs = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new AppError(`Timed out waiting for ${eventName}`, { code: 'TIMED_OUT' }));
    }, timeoutMs);

    socket.onceOutbound(eventName, (payload: unknown) => {
      clearTimeout(timeout);
      resolve(payload as T);
    });
  });
}

describe('ranked matchmaking socket integration (in-process)', () => {
  let io: TestIo;
  let rankedMatchmakingService: typeof import('../../src/realtime/services/ranked-matchmaking.service.js').rankedMatchmakingService;
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    fakeRedis = new FakeRedis();
    lobbyCounter = 0;
    lobbyMembers.clear();
    mockStartDraft.mockReset();
    mockGetWallet.mockReset();
    mockGetWallet.mockResolvedValue({ coins: 0, tickets: 1 });
    mockStartRankedAiForUser.mockClear();
    vi.resetModules();

    const module = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    rankedMatchmakingService = module.rankedMatchmakingService;

    io = new TestIo(sockets);
    rankedMatchmakingService.start(io as unknown as QuizballServer);
  });

  afterEach(() => {
    rankedMatchmakingService.stop();
    sockets.splice(0, sockets.length);
  });

  function createSocket(userId: string): TestSocket {
    const socket = new TestSocket(io, userId);
    sockets.push(socket);
    socket.join(`user:${userId}`);
    registerRankedHandlers(io as unknown as QuizballServer, socket as unknown as QuizballSocket);
    return socket;
  }

  it('matches two queued players and emits ranked:match_found to both', async () => {
    const userA = createSocket('u1');
    const userB = createSocket('u2');

    const userASearch = waitForEvent<{ durationMs: number }>(userA, 'ranked:search_started');
    const userBSearch = waitForEvent<{ durationMs: number }>(userB, 'ranked:search_started');
    const userAMatch = waitForEvent<{ lobbyId: string; opponent: { id: string } }>(userA, 'ranked:match_found');
    const userBMatch = waitForEvent<{ lobbyId: string; opponent: { id: string } }>(userB, 'ranked:match_found');

    await userA.trigger('ranked:queue_join', {});
    await userB.trigger('ranked:queue_join', {});

    const [aSearch, bSearch, aMatch, bMatch] = await Promise.all([
      userASearch,
      userBSearch,
      userAMatch,
      userBMatch,
    ]);

    expect(aSearch.durationMs).toBe(10000);
    expect(bSearch.durationMs).toBe(10000);
    expect(aMatch.opponent.id).toBe('u2');
    expect(bMatch.opponent.id).toBe('u1');
    expect(mockStartRankedAiForUser).not.toHaveBeenCalled();
  });

  it('keeps a committed human match when the assigned-lobby marker write fails', async () => {
    const userA = createSocket('marker-a');
    const userB = createSocket('marker-b');
    fakeRedis.rejectAssignedLobbyWrites();

    const userAMatch = waitForEvent<{ lobbyId: string; opponent: { id: string } }>(
      userA,
      'ranked:match_found'
    );
    const userBMatch = waitForEvent<{ lobbyId: string; opponent: { id: string } }>(
      userB,
      'ranked:match_found'
    );

    await userA.trigger('ranked:queue_join', {});
    await userB.trigger('ranked:queue_join', {});

    const [aMatch, bMatch] = await Promise.all([userAMatch, userBMatch]);
    expect(aMatch.lobbyId).toBe(bMatch.lobbyId);
    expect(aMatch.opponent.id).toBe('marker-b');
    expect(bMatch.opponent.id).toBe('marker-a');
    expect(lobbyMembers.get(aMatch.lobbyId)).toEqual(['marker-a', 'marker-b']);
  });

  it('expires atomic pairing reservations using the Lua-provided TTL', async () => {
    rankedMatchmakingService.stop();
    const userA = createSocket('ttl-a');
    const userB = createSocket('ttl-b');
    await userA.trigger('ranked:queue_join', {});
    await userB.trigger('ranked:queue_join', {});

    vi.useFakeTimers();
    try {
      const result = await fakeRedis.eval(RANKED_MM_PAIR_TWO_OLDEST_SCRIPT, {
        keys: ['ranked:mm:queue', 'ranked:mm:timeouts', 'ranked:mm:user'],
        arguments: ['ranked:mm:search:', String(Date.now()), 'ranked:mm:pairing:', '30'],
      });
      expect(result).toHaveLength(4);
      expect(await fakeRedis.exists('ranked:mm:pairing:ttl-a')).toBe(1);
      expect(await fakeRedis.exists('ranked:mm:pairing:ttl-b')).toBe(1);

      await vi.advanceTimersByTimeAsync(30_001);
      expect(await fakeRedis.exists('ranked:mm:pairing:ttl-a')).toBe(0);
      expect(await fakeRedis.exists('ranked:mm:pairing:ttl-b')).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats adapter lookup errors as inconclusive and keeps a healthy pairing', async () => {
    const userA = createSocket('u1');
    const userB = createSocket('u2');
    io.failNextFetchSockets(2);
    const userAMatch = waitForEvent<{ opponent: { id: string } }>(userA, 'ranked:match_found');
    const userBMatch = waitForEvent<{ opponent: { id: string } }>(userB, 'ranked:match_found');

    await userA.trigger('ranked:queue_join', {});
    await userB.trigger('ranked:queue_join', {});

    const [aMatch, bMatch] = await Promise.all([userAMatch, userBMatch]);
    expect(aMatch.opponent.id).toBe('u2');
    expect(bMatch.opponent.id).toBe('u1');
  });

  it('matches four queued players without AI fallback', async () => {
    const users = ['u1', 'u2', 'u3', 'u4'].map((id) => createSocket(id));
    const matches = users.map((socket) =>
      waitForEvent<{ lobbyId: string; opponent: { id: string } }>(socket, 'ranked:match_found', 3000)
    );

    for (const socket of users) {
      await socket.trigger('ranked:queue_join', {});
    }

    const results = await Promise.all(matches);
    expect(results).toHaveLength(4);
    expect(results.every((entry) => entry.opponent.id.startsWith('u'))).toBe(true);
    expect(mockStartRankedAiForUser).not.toHaveBeenCalled();
  });

  it('matches four and falls back remaining fifth user to AI', async () => {
    const users = ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => createSocket(id));
    const matchEvents = users.map((socket) =>
      waitForEvent<{ opponent: { id: string } }>(socket, 'ranked:match_found', 4000)
    );

    for (const socket of users) {
      await socket.trigger('ranked:queue_join', {});
    }

    // Allow matcher to consume two human pairs before forcing fallback due.
    await new Promise((resolve) => setTimeout(resolve, 250));
    fakeRedis.forceAllTimeoutsDue(Date.now());
    const results = await Promise.all(matchEvents);

    const aiMatches = results.filter((entry) => entry.opponent.id.startsWith('ai-'));
    const humanMatches = results.filter((entry) => entry.opponent.id.startsWith('u'));

    expect(humanMatches).toHaveLength(4);
    expect(aiMatches).toHaveLength(1);
    expect(aiMatches[0]?.opponent.id).toBe('ai-u5');
    expect(mockStartRankedAiForUser).toHaveBeenCalledTimes(1);
  });

  it('falls back solo queued user to AI when timeout is due', async () => {
    const user = createSocket('solo');

    const matchFound = waitForEvent<{ opponent: { id: string } }>(user, 'ranked:match_found', 3000);
    await user.trigger('ranked:queue_join', {});
    fakeRedis.forceAllTimeoutsDue(Date.now());

    const result = await matchFound;
    expect(result.opponent.id).toBe('ai-solo');
    expect(mockStartRankedAiForUser).toHaveBeenCalledTimes(1);
  });

  it('removes user from queue on ranked:queue_leave', async () => {
    const user = createSocket('cancel-user');
    const searchStarted = waitForEvent(user, 'ranked:search_started', 2000);
    const queueLeft = waitForEvent(user, 'ranked:queue_left', 2000);

    await user.trigger('ranked:queue_join', {});
    await searchStarted;
    await user.trigger('ranked:queue_leave');
    await queueLeft;

    expect(fakeRedis.getUserSearchId('cancel-user')).toBeNull();
    fakeRedis.forceAllTimeoutsDue(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockStartRankedAiForUser).not.toHaveBeenCalled();
  });

  it('ignores a late queue_join that arrives immediately after ranked:queue_leave', async () => {
    const user = createSocket('late-join-after-leave-user');
    const searchStarted = waitForEvent(user, 'ranked:search_started', 2000);
    const firstQueueLeft = waitForEvent(user, 'ranked:queue_left', 2000);

    await user.trigger('ranked:queue_join', {});
    await searchStarted;
    await user.trigger('ranked:queue_leave');
    await firstQueueLeft;

    const lateJoinQueueLeft = waitForEvent(user, 'ranked:queue_left', 2000);
    await user.trigger('ranked:queue_join', {});
    await lateJoinQueueLeft;

    expect(fakeRedis.getUserSearchId('late-join-after-leave-user')).toBeNull();
    fakeRedis.forceAllTimeoutsDue(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockStartRankedAiForUser).not.toHaveBeenCalled();
  });

  it('blocks ranked search before queueing when the user has no tickets', async () => {
    mockGetWallet.mockResolvedValueOnce({ coins: 0, tickets: 0 });
    const user = createSocket('no-ticket-user');
    const errorEvent = waitForEvent<{ code: string; meta?: { tickets?: number } }>(user, 'error', 2000);
    const queueLeft = waitForEvent(user, 'ranked:queue_left', 2000);

    await user.trigger('ranked:queue_join', {});

    const error = await errorEvent;
    await queueLeft;

    expect(error.code).toBe('INSUFFICIENT_TICKETS');
    expect(error.meta?.tickets).toBe(0);
    expect(fakeRedis.getUserSearchId('no-ticket-user')).toBeNull();
    expect(mockStartRankedAiForUser).not.toHaveBeenCalled();
  });
});
