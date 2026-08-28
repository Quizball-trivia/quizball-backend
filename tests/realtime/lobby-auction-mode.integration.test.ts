/**
 * AUCTION as a friend-lobby match mode.
 *
 * Drives the REAL lobby handlers (lobby:create / join_by_code / update_settings /
 * ready / start) against an in-memory lobby store, with the auction match-creation
 * seam (`startAuctionMatchForHumans`) mocked so we can assert exactly which humans
 * get seated and how many bots backfill.
 *
 * Covers the 8 contract edge cases; each test names the one it pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import { registerLobbyHandlers } from '../../src/realtime/handlers/lobby.handler.js';
import '../setup.js';

type LobbyMode = 'friendly' | 'ranked';
type LobbyStatus = 'waiting' | 'active' | 'closed';
type LobbyGameMode =
  | 'friendly_possession'
  | 'friendly_party_quiz'
  | 'auction'
  | 'ranked_sim';

type LobbyRow = {
  id: string;
  invite_code: string | null;
  mode: LobbyMode;
  game_mode: LobbyGameMode;
  friendly_random: boolean;
  friendly_category_a_id: string | null;
  friendly_category_b_id: string | null;
  is_public: boolean;
  display_name: string;
  host_user_id: string;
  status: LobbyStatus;
  created_at: string;
  updated_at: string;
};

type LobbyMember = { user_id: string; is_ready: boolean; joined_at: string };

const store = {
  lobbies: new Map<string, LobbyRow>(),
  members: new Map<string, LobbyMember[]>(),
  /** userId -> live auction matchId (drives the "already in a match" guard). */
  auctionMatchByUser: new Map<string, string>(),
  auctionStates: new Map<string, unknown>(),
  idCounter: 0,
  joinCounter: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

function nextJoinedAt(): string {
  store.joinCounter += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, store.joinCounter)).toISOString();
}

function listMembers(lobbyId: string): LobbyMember[] {
  return [...(store.members.get(lobbyId) ?? [])].sort((a, b) =>
    a.joined_at.localeCompare(b.joined_at)
  );
}

function listOpenLobbiesForUser(userId: string): Array<LobbyRow & { joined_at: string }> {
  const rows: Array<LobbyRow & { joined_at: string }> = [];
  for (const [lobbyId, members] of store.members.entries()) {
    const member = members.find((entry) => entry.user_id === userId);
    if (!member) continue;
    const lobby = store.lobbies.get(lobbyId);
    if (!lobby) continue;
    if (lobby.status !== 'waiting' && lobby.status !== 'active') continue;
    rows.push({ ...lobby, joined_at: member.joined_at });
  }
  return rows;
}

class TestSocket {
  public data: QuizballSocket['data'];
  public emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly inbound = new Map<
    string,
    ((payload?: unknown, ack?: (result: unknown) => void) => void | Promise<void>)[]
  >();
  private readonly outbound = new Map<string, ((payload?: unknown) => void)[]>();

  constructor(private readonly io: TestIo, userId: string) {
    this.data = {
      user: {
        id: userId,
        role: 'user',
        nickname: userId,
        avatar_url: null,
        avatar_customization: null,
      },
    } as QuizballSocket['data'];
  }

  on(
    event: string,
    handler: (payload?: unknown, ack?: (result: unknown) => void) => void | Promise<void>
  ): this {
    const handlers = this.inbound.get(event) ?? [];
    handlers.push(handler);
    this.inbound.set(event, handlers);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    (this.outbound.get(event) ?? []).forEach((handler) => { handler(payload); });
    return true;
  }

  onceOutbound(event: string, handler: (payload?: unknown) => void): void {
    const wrapped = (payload?: unknown) => {
      const handlers = (this.outbound.get(event) ?? []).filter((entry) => entry !== wrapped);
      this.outbound.set(event, handlers);
      handler(payload);
    };
    const handlers = this.outbound.get(event) ?? [];
    handlers.push(wrapped);
    this.outbound.set(event, handlers);
  }

  async trigger(event: string, payload?: unknown): Promise<void> {
    for (const handler of this.inbound.get(event) ?? []) {
      await handler(payload);
    }
  }

  async triggerWithAck<T = unknown>(event: string, payload?: unknown): Promise<T | undefined> {
    let ackPayload: T | undefined;
    const ack = (result: T) => { ackPayload = result; };
    for (const handler of this.inbound.get(event) ?? []) {
      await handler(payload, ack as (result: unknown) => void);
    }
    return ackPayload;
  }

  join(room: string): this {
    this.io.joinRoom(room, this);
    return this;
  }

  leave(room: string): this {
    this.io.leaveRoom(room, this);
    return this;
  }

  errorsOfCode(code: string): unknown[] {
    return this.emitted
      .filter((entry) => entry.event === 'error' && (entry.payload as { code?: string })?.code === code)
      .map((entry) => entry.payload);
  }
}

class TestIo {
  private readonly roomMap = new Map<string, Set<TestSocket>>();

  to(room: string): { emit: (event: string, payload?: unknown) => void } {
    return {
      emit: (event: string, payload?: unknown) => {
        (this.roomMap.get(room) ?? new Set<TestSocket>()).forEach((socket) => {
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
        (this.roomMap.get(room) ?? new Set<TestSocket>()).forEach((socket) => socket.join(targetRoom));
      },
      fetchSockets: async () => [...(this.roomMap.get(room) ?? new Set<TestSocket>())],
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
    if (sockets.size === 0) this.roomMap.delete(room);
  }
}

const lockStore = new Map<string, string>();
/** Records every startAuctionMatchForHumans call so tests can assert seating. */
const startAuctionMatchForHumansMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async (key: string) => {
    if (lockStore.has(key)) return { acquired: false, token: null };
    const token = `${key}:token`;
    lockStore.set(key, token);
    return { acquired: true, token };
  }),
  releaseLock: vi.fn(async (key: string, token: string) => {
    if (lockStore.get(key) === token) lockStore.delete(key);
  }),
  startLockHeartbeat: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('../../src/realtime/services/auction-realtime.service.js', () => ({
  startAuctionMatchForHumans: (...args: unknown[]) => startAuctionMatchForHumansMock(...args),
}));

vi.mock('../../src/modules/auction/auction-state.store.js', () => ({
  auctionStateStore: {
    getActiveMatchIdForUser: vi.fn(async (userId: string) =>
      store.auctionMatchByUser.get(userId) ?? null
    ),
    load: vi.fn(async (matchId: string) => store.auctionStates.get(matchId) ?? null),
  },
}));

vi.mock('../../src/realtime/services/warmup-realtime.service.js', () => ({
  warmupRealtimeService: { cleanupLobby: vi.fn(async () => undefined) },
}));

vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: { listByIds: vi.fn(async () => []) },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  PARTY_QUIZ_TOTAL_QUESTIONS: 10,
  matchesService: { createMatchFromLobby: vi.fn() },
}));

vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({
  beginMatchForLobby: vi.fn(),
}));

vi.mock('../../src/modules/users/users.repo.js', () => {
  const getById = vi.fn(async (id: string) => ({
    id,
    nickname: id,
    avatar_url: null,
    avatar_customization: null,
    is_deleted: false,
  }));
  return {
    isUserAccountInactive: () => false,
    usersRepo: {
      getById,
      getByIds: vi.fn(async (ids: string[]) => {
        const map = new Map<string, Awaited<ReturnType<typeof getById>>>();
        for (const id of [...new Set(ids)]) map.set(id, await getById(id));
        return map;
      }),
    },
  };
});

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: vi.fn(async (data: {
      mode: LobbyMode;
      hostUserId: string;
      inviteCode: string | null;
      isPublic?: boolean;
      displayName?: string;
    }) => {
      store.idCounter += 1;
      const id = `lobby-${store.idCounter}`;
      const row: LobbyRow = {
        id,
        invite_code: data.inviteCode,
        mode: data.mode,
        game_mode: data.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession',
        friendly_random: true,
        friendly_category_a_id: null,
        friendly_category_b_id: null,
        is_public: data.isPublic ?? false,
        display_name: data.displayName ?? '',
        host_user_id: data.hostUserId,
        status: 'waiting',
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.lobbies.set(id, row);
      return row;
    }),

    getById: vi.fn(async (id: string) => store.lobbies.get(id) ?? null),

    getByInviteCode: vi.fn(async (inviteCode: string) => {
      for (const lobby of store.lobbies.values()) {
        if (
          lobby.invite_code === inviteCode &&
          lobby.status === 'waiting' &&
          lobby.mode === 'friendly'
        ) {
          return lobby;
        }
      }
      return null;
    }),

    findWaitingLobbyForUser: vi.fn(async (userId: string) =>
      listOpenLobbiesForUser(userId).find((lobby) => lobby.status === 'waiting') ?? null
    ),
    findOpenLobbyForUser: vi.fn(async (userId: string) =>
      listOpenLobbiesForUser(userId)[0] ?? null
    ),
    listOpenLobbiesForUser: vi.fn(async (userId: string) => listOpenLobbiesForUser(userId)),

    setLobbyStatus: vi.fn(async (lobbyId: string, status: LobbyStatus) => {
      const lobby = store.lobbies.get(lobbyId);
      if (lobby) lobby.status = status;
    }),

    setHostUser: vi.fn(async (lobbyId: string, userId: string) => {
      const lobby = store.lobbies.get(lobbyId);
      if (lobby) lobby.host_user_id = userId;
    }),

    deleteLobby: vi.fn(async (lobbyId: string) => {
      store.lobbies.delete(lobbyId);
      store.members.delete(lobbyId);
    }),

    updateLobbySettings: vi.fn(async (lobbyId: string, settings: {
      gameMode: LobbyGameMode;
      friendlyRandom: boolean;
      friendlyCategoryAId: string | null;
      friendlyCategoryBId: string | null;
    }) => {
      const lobby = store.lobbies.get(lobbyId);
      if (!lobby) return null;
      lobby.game_mode = settings.gameMode;
      lobby.friendly_random = settings.friendlyRandom;
      lobby.friendly_category_a_id = settings.friendlyCategoryAId;
      lobby.friendly_category_b_id = settings.friendlyCategoryBId;
      return lobby;
    }),

    setVisibility: vi.fn(async (lobbyId: string, isPublic: boolean) => {
      const lobby = store.lobbies.get(lobbyId);
      if (lobby) lobby.is_public = isPublic;
    }),

    addMember: vi.fn(async (lobbyId: string, userId: string, isReady: boolean) => {
      const members = listMembers(lobbyId);
      const existing = members.find((member) => member.user_id === userId);
      if (existing) {
        existing.is_ready = isReady;
      } else {
        members.push({ user_id: userId, is_ready: isReady, joined_at: nextJoinedAt() });
      }
      store.members.set(lobbyId, members);
      return { lobby_id: lobbyId, user_id: userId, is_ready: isReady };
    }),

    removeMember: vi.fn(async (lobbyId: string, userId: string) => {
      store.members.set(lobbyId, listMembers(lobbyId).filter((m) => m.user_id !== userId));
    }),

    updateMemberReady: vi.fn(async (lobbyId: string, userId: string, isReady: boolean) => {
      const members = listMembers(lobbyId);
      const existing = members.find((member) => member.user_id === userId);
      if (!existing) return false;
      existing.is_ready = isReady;
      store.members.set(lobbyId, members);
      return true;
    }),

    listMembersWithUser: vi.fn(async (lobbyId: string) =>
      listMembers(lobbyId).map((member) => ({
        lobby_id: lobbyId,
        user_id: member.user_id,
        is_ready: member.is_ready,
        joined_at: member.joined_at,
        nickname: member.user_id,
        avatar_url: null,
        avatar_customization: { skin: member.user_id },
      }))
    ),

    countMembers: vi.fn(async (lobbyId: string) => listMembers(lobbyId).length),
    countReadyMembers: vi.fn(async (lobbyId: string) =>
      listMembers(lobbyId).filter((member) => member.is_ready).length
    ),
    setAllReady: vi.fn(async (lobbyId: string, isReady: boolean) => {
      const members = listMembers(lobbyId).map((m) => ({ ...m, is_ready: isReady }));
      store.members.set(lobbyId, members);
      return members.length;
    }),

    clearLobbyCategoryBans: vi.fn(async () => undefined),
    clearLobbyCategories: vi.fn(async () => undefined),
    insertLobbyCategories: vi.fn(async () => undefined),
    listValidCategoryIds: vi.fn(async (ids: string[]) => ids),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  MIN_QUESTIONS_PER_CATEGORY: 5,
  lobbiesService: {
    buildLobbyState: vi.fn(async (lobby: LobbyRow) => ({
      lobbyId: lobby.id,
      mode: lobby.mode,
      status: lobby.status,
      inviteCode: lobby.invite_code,
      displayName: lobby.display_name,
      isPublic: lobby.is_public,
      hostUserId: lobby.host_user_id,
      settings: {
        gameMode: lobby.game_mode,
        friendlyRandom: lobby.friendly_random,
        friendlyCategoryAId: lobby.friendly_category_a_id,
        friendlyCategoryBId: lobby.friendly_category_b_id,
      },
      members: listMembers(lobby.id).map((member) => ({
        userId: member.user_id,
        isReady: member.is_ready,
        isHost: member.user_id === lobby.host_user_id,
      })),
    })),
    selectRandomCategories: vi.fn(async () => [{ id: 'cat-1' }]),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getActiveMatchForUser: vi.fn(async () => null),
    getActiveMatchForLobby: vi.fn(async () => null),
    abandonMatch: vi.fn(async () => false),
  },
}));

/** A live auction state seating `userIds` as non-bot, non-forfeited players. */
function liveAuctionState(matchId: string, userIds: string[]): unknown {
  return {
    matchId,
    phase: 'bidding',
    seats: userIds.map((userId, index) => ({
      seatId: `seat-human-${index + 1}`,
      userId,
      isBot: false,
      forfeited: false,
    })),
  };
}

describe('lobby auction mode', () => {
  let io: TestIo;
  const sockets: TestSocket[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    lockStore.clear();
    store.lobbies.clear();
    store.members.clear();
    store.auctionMatchByUser.clear();
    store.auctionStates.clear();
    store.idCounter = 0;
    store.joinCounter = 0;
    io = new TestIo();
    startAuctionMatchForHumansMock.mockImplementation(async (_io, input: {
      humanPlayers: Array<{ userId: string; displayName: string }>;
    }) => ({
      matchId: 'auction-match-1',
      version: 4,
      locale: 'en',
      phase: 'bidding',
      formation: '2-2-2',
      seats: input.humanPlayers.map((player, index) => ({
        seatId: `seat-human-${index + 1}`,
        userId: player.userId,
        displayName: player.displayName,
        isBot: false,
        forfeited: false,
        budget: 100,
        team: { formation: '2-2-2', slots: { GK: [], DEF: [], MID: [], FWD: [] } },
        isEliminated: false,
      })),
      currentRound: null,
      completedRounds: [],
      soloPick: null,
      usedClueCardIds: [],
      rankings: null,
    }));
  });

  afterEach(() => {
    sockets.splice(0, sockets.length);
  });

  function createSocket(userId: string): TestSocket {
    const socket = new TestSocket(io, userId);
    sockets.push(socket);
    socket.join(`user:${userId}`);
    registerLobbyHandlers(io as unknown as QuizballServer, socket as unknown as QuizballSocket);
    return socket;
  }

  /** Create a friendly lobby in auction mode and return [lobbyId, inviteCode]. */
  async function createAuctionLobby(host: TestSocket): Promise<{ lobbyId: string; inviteCode: string }> {
    const ack = await host.triggerWithAck<{ ok: boolean; lobbyId: string; inviteCode: string }>(
      'lobby:create',
      { mode: 'friendly', isPublic: false }
    );
    await host.trigger('lobby:update_settings', { gameMode: 'auction' });
    return { lobbyId: ack!.lobbyId, inviteCode: ack!.inviteCode };
  }

  async function readyAll(members: TestSocket[]): Promise<void> {
    for (const member of members) {
      await member.trigger('lobby:ready', { ready: true });
    }
  }

  function seatedUserIds(): string[] {
    const call = startAuctionMatchForHumansMock.mock.calls[0]?.[1] as {
      humanPlayers: Array<{ userId: string }>;
    };
    return call.humanPlayers.map((player) => player.userId);
  }

  it('EDGE 1: switching TO auction with 2 members opens a third slot and resets ready states', async () => {
    const host = createSocket('e1-host');
    const guest = createSocket('e1-guest');

    const ack = await host.triggerWithAck<{ lobbyId: string; inviteCode: string }>('lobby:create', {
      mode: 'friendly',
      isPublic: false,
    });
    await guest.trigger('lobby:join_by_code', { inviteCode: ack!.inviteCode });

    // Both ready in possession mode first.
    await readyAll([host, guest]);
    expect(listMembers(ack!.lobbyId).every((m) => m.is_ready)).toBe(true);

    // Ready-locked settings guard: unready one member so the host may switch.
    await guest.trigger('lobby:ready', { ready: false });
    await host.trigger('lobby:update_settings', { gameMode: 'auction' });

    expect(store.lobbies.get(ack!.lobbyId)?.game_mode).toBe('auction');
    // Ready states reset on entering auction.
    expect(listMembers(ack!.lobbyId).some((m) => m.is_ready)).toBe(false);

    // The third slot is genuinely open — a third player can join.
    const third = createSocket('e1-third');
    const joinAck = await third.triggerWithAck<{ ok: boolean }>('lobby:join_by_code', {
      inviteCode: ack!.inviteCode,
    });
    expect(joinAck).toMatchObject({ ok: true });
    expect(listMembers(ack!.lobbyId)).toHaveLength(3);
    // Joining a 3rd member must NOT promote an auction lobby to party quiz.
    expect(store.lobbies.get(ack!.lobbyId)?.game_mode).toBe('auction');
  });

  it('EDGE 2: switching AWAY from auction with 3 members is rejected, nobody is kicked', async () => {
    const host = createSocket('e2-host');
    const guestA = createSocket('e2-a');
    const guestB = createSocket('e2-b');

    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guestA.trigger('lobby:join_by_code', { inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode });
    expect(listMembers(lobbyId)).toHaveLength(3);

    await host.trigger('lobby:update_settings', { gameMode: 'friendly_possession' });

    const errors = host.errorsOfCode('LOBBY_MODE_CAPACITY');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ meta: { memberCount: 3, maxMembers: 2 } });
    // Mode unchanged and all three members still seated.
    expect(store.lobbies.get(lobbyId)?.game_mode).toBe('auction');
    expect(listMembers(lobbyId)).toHaveLength(3);
  });

  it('EDGE 3: joining a full 3/3 auction lobby is rejected with LOBBY_FULL', async () => {
    const host = createSocket('e3-host');
    const guestA = createSocket('e3-a');
    const guestB = createSocket('e3-b');
    const fourth = createSocket('e3-fourth');

    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guestA.trigger('lobby:join_by_code', { inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode });

    const ack = await fourth.triggerWithAck<{ ok: boolean; code?: string }>('lobby:join_by_code', {
      inviteCode,
    });

    expect(ack).toMatchObject({ ok: false, code: 'LOBBY_FULL' });
    expect(fourth.errorsOfCode('LOBBY_FULL')).toHaveLength(1);
    expect(listMembers(lobbyId)).toHaveLength(3);
  });

  it('EDGE 4a: host starts alone (1 human) -> 2 bots backfill', async () => {
    const host = createSocket('e4a-host');
    const { lobbyId } = await createAuctionLobby(host);

    await readyAll([host]);
    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    expect(seatedUserIds()).toEqual(['e4a-host']);
    expect(store.lobbies.get(lobbyId)?.status).toBe('active');
  });

  it('EDGE 4b: 2 humans -> 1 bot backfill', async () => {
    const host = createSocket('e4b-host');
    const guest = createSocket('e4b-guest');
    const { inviteCode } = await createAuctionLobby(host);
    await guest.trigger('lobby:join_by_code', { inviteCode });

    await readyAll([host, guest]);
    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    expect(seatedUserIds()).toEqual(['e4b-host', 'e4b-guest']);
  });

  it('EDGE 4c: 3 humans -> 0 bots', async () => {
    const host = createSocket('e4c-host');
    const guestA = createSocket('e4c-a');
    const guestB = createSocket('e4c-b');
    const { inviteCode } = await createAuctionLobby(host);
    await guestA.trigger('lobby:join_by_code', { inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode });

    await readyAll([host, guestA, guestB]);
    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    expect(seatedUserIds()).toEqual(['e4c-host', 'e4c-a', 'e4c-b']);
  });

  it('EDGE 5: a member leaving an auction lobby pre-start keeps the lobby usable at the new size', async () => {
    const host = createSocket('e5-host');
    const guestA = createSocket('e5-a');
    const guestB = createSocket('e5-b');
    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guestA.trigger('lobby:join_by_code', { inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode });

    await guestB.trigger('lobby:leave', {});

    expect(listMembers(lobbyId).map((m) => m.user_id)).toEqual(['e5-host', 'e5-a']);
    // Dropping to 2 must not flip an auction lobby into another mode.
    expect(store.lobbies.get(lobbyId)?.game_mode).toBe('auction');

    // The remaining two can still start (1 bot backfills the vacated seat).
    await readyAll([host, guestA]);
    await host.trigger('lobby:start');
    expect(seatedUserIds()).toEqual(['e5-host', 'e5-a']);
  });

  it('EDGE 6: a double lobby:start creates exactly one auction match', async () => {
    const host = createSocket('e6-host');
    const guest = createSocket('e6-guest');
    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guest.trigger('lobby:join_by_code', { inviteCode });
    await readyAll([host, guest]);

    await Promise.all([host.trigger('lobby:start'), host.trigger('lobby:start')]);

    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    expect(store.lobbies.get(lobbyId)?.status).toBe('active');

    // A third, sequential click after the lobby is active is still a no-op.
    await host.trigger('lobby:start');
    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
  });

  it('EDGE 7: start is rejected when a member is already in a live auction match', async () => {
    const host = createSocket('e7-host');
    const guest = createSocket('e7-guest');
    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guest.trigger('lobby:join_by_code', { inviteCode });
    await readyAll([host, guest]);

    store.auctionMatchByUser.set('e7-guest', 'live-match-9');
    store.auctionStates.set('live-match-9', liveAuctionState('live-match-9', ['e7-guest']));

    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).not.toHaveBeenCalled();
    const errors = host.errorsOfCode('MEMBER_BUSY');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ meta: { userId: 'e7-guest' } });
    // Lobby stays startable once the stale match clears.
    expect(store.lobbies.get(lobbyId)?.status).toBe('waiting');

    store.auctionMatchByUser.clear();
    await host.trigger('lobby:start');
    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
  });

  it('EDGE 7b: a FINISHED or forfeited prior auction match does not block the start', async () => {
    const host = createSocket('e7b-host');
    const { lobbyId } = await createAuctionLobby(host);
    await readyAll([host]);

    store.auctionMatchByUser.set('e7b-host', 'old-match');
    store.auctionStates.set('old-match', {
      matchId: 'old-match',
      phase: 'finished',
      seats: [{ seatId: 'seat-human-1', userId: 'e7b-host', isBot: false, forfeited: false }],
    });

    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    expect(store.lobbies.get(lobbyId)?.status).toBe('active');
  });

  it('EDGE 8: all members land in the SAME match with names/avatars, and no tickets are spent', async () => {
    const host = createSocket('e8-host');
    const guestA = createSocket('e8-a');
    const guestB = createSocket('e8-b');
    const { lobbyId, inviteCode } = await createAuctionLobby(host);
    await guestA.trigger('lobby:join_by_code', { inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode });
    await readyAll([host, guestA, guestB]);

    await host.trigger('lobby:start');

    // ONE match creation call carrying ALL three members.
    expect(startAuctionMatchForHumansMock).toHaveBeenCalledTimes(1);
    const input = startAuctionMatchForHumansMock.mock.calls[0][1] as {
      humanPlayers: Array<{ userId: string; displayName: string; avatarCustomization: unknown }>;
      locale: string;
      origin: string;
      sourceLobbyId: string;
      sourceSocket: unknown;
    };
    expect(input.humanPlayers).toEqual([
      { userId: 'e8-host', displayName: 'e8-host', avatarCustomization: { skin: 'e8-host' } },
      { userId: 'e8-a', displayName: 'e8-a', avatarCustomization: { skin: 'e8-a' } },
      { userId: 'e8-b', displayName: 'e8-b', avatarCustomization: { skin: 'e8-b' } },
    ]);
    expect(input.locale).toBe('en');
    // Friendly: stamped as a lobby match so the finish path awards no AP.
    expect(input.origin).toBe('lobby');
    expect(input.sourceLobbyId).toBe(lobbyId);

    // Friendly economy: the auction lobby path never touches the store service.
    const storeService = await import('../../src/modules/store/store.service.js');
    expect(storeService.storeService.consumeRankedTickets).toBeUndefined;
    // And it never routes through the ranked/possession match creator.
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    expect(vi.mocked(matchesService.createMatchFromLobby)).not.toHaveBeenCalled();
  });

  it('emits app-wide auction:state to every seated member on start', async () => {
    const host = createSocket('st-host');
    const guest = createSocket('st-guest');
    const { inviteCode } = await createAuctionLobby(host);
    await guest.trigger('lobby:join_by_code', { inviteCode });
    await readyAll([host, guest]);

    await host.trigger('lobby:start');

    for (const member of [host, guest]) {
      const states = member.emitted.filter((entry) => entry.event === 'auction:state');
      expect(states).toHaveLength(1);
      expect(states[0].payload).toMatchObject({
        matchId: 'auction-match-1',
        stateVersion: 4,
      });
      expect((states[0].payload as { state: { matchId: string } }).state.matchId)
        .toBe('auction-match-1');
    }
  });

  it('rejects host start when not every auction member is ready', async () => {
    const host = createSocket('nr-host');
    const guest = createSocket('nr-guest');
    const { inviteCode } = await createAuctionLobby(host);
    await guest.trigger('lobby:join_by_code', { inviteCode });

    await readyAll([host]);
    await host.trigger('lobby:start');

    expect(startAuctionMatchForHumansMock).not.toHaveBeenCalled();
    expect(host.errorsOfCode('LOBBY_NOT_READY')).toHaveLength(1);
  });

  it('unreadies everyone and surfaces the error when auction match creation fails', async () => {
    const host = createSocket('fail-host');
    const { lobbyId } = await createAuctionLobby(host);
    await readyAll([host]);

    startAuctionMatchForHumansMock.mockRejectedValueOnce(new Error('no auction content'));
    await host.trigger('lobby:start');

    expect(store.lobbies.get(lobbyId)?.status).toBe('waiting');
    expect(listMembers(lobbyId).some((m) => m.is_ready)).toBe(false);
    expect(host.emitted.some((entry) => entry.event === 'auction:error')).toBe(true);
  });
});
