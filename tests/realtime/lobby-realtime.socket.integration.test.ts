import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import { registerLobbyHandlers } from '../../src/realtime/handlers/lobby.handler.js';
import { lobbyRealtimeService } from '../../src/realtime/services/lobby-realtime.service.js';
import '../setup.js';

type LobbyMode = 'friendly' | 'ranked';
type LobbyStatus = 'waiting' | 'active' | 'closed';
type LobbyRow = {
  id: string;
  invite_code: string | null;
  mode: LobbyMode;
  game_mode: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
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

type LobbyMember = {
  user_id: string;
  is_ready: boolean;
  joined_at: string;
};

type ChallengeInvite = {
  id: string;
  lobby_id: string;
  from_user_id: string;
  to_user_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'canceled' | 'expired';
  expires_at: string;
  created_at: string;
  updated_at: string;
};

const store = {
  lobbies: new Map<string, LobbyRow>(),
  members: new Map<string, LobbyMember[]>(),
  challengeInvites: new Map<string, ChallengeInvite>(),
  activeMatchByUser: new Map<string, { id: string; lobby_id: string; started_at: string }>(),
  idCounter: 0,
  inviteCounter: 0,
};

function nowIso(): string {
  return new Date().toISOString();
}

function nextLobbyId(): string {
  store.idCounter += 1;
  return `lobby-${store.idCounter}`;
}

function nextInviteId(): string {
  store.inviteCounter += 1;
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(store.inviteCounter).padStart(12, '0')}`;
}

function listMembers(lobbyId: string): LobbyMember[] {
  return [...(store.members.get(lobbyId) ?? [])].sort((a, b) => a.joined_at.localeCompare(b.joined_at));
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
  return rows.sort((a, b) => b.joined_at.localeCompare(a.joined_at));
}

class TestSocket {
  public data: QuizballSocket['data'];
  public emitted: Array<{ event: string; payload: unknown }> = [];
  private readonly inbound = new Map<string, ((payload?: unknown) => void | Promise<void>)[]>();
  private readonly outbound = new Map<string, ((payload?: unknown) => void)[]>();
  private readonly rooms = new Set<string>();

  constructor(
    private readonly io: TestIo,
    userId: string
  ) {
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

  on(event: string, handler: (payload?: unknown) => void | Promise<void>): this {
    const handlers = this.inbound.get(event) ?? [];
    handlers.push(handler);
    this.inbound.set(event, handlers);
    return this;
  }

  emit(event: string, payload?: unknown): boolean {
    this.emitted.push({ event, payload });
    const handlers = this.outbound.get(event) ?? [];
    handlers.forEach((handler) => { handler(payload); });
    return true;
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
}

class TestIo {
  private readonly roomMap = new Map<string, Set<TestSocket>>();
  constructor(private readonly sockets: TestSocket[]) {}

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
    if (sockets.size === 0) this.roomMap.delete(room);
  }
}

const cleanupLobbyMock = vi.fn(async () => undefined);
const lockStore = new Map<string, string>();

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => null,
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async (key: string) => {
    if (lockStore.has(key)) {
      return { acquired: false, token: null };
    }
    const token = `${key}:token`;
    lockStore.set(key, token);
    return { acquired: true, token };
  }),
  releaseLock: vi.fn(async (key: string, token: string) => {
    if (lockStore.get(key) === token) {
      lockStore.delete(key);
    }
  }),
}));

vi.mock('../../src/realtime/services/warmup-realtime.service.js', () => ({
  warmupRealtimeService: {
    cleanupLobby: (...args: unknown[]) => cleanupLobbyMock(...args),
  },
}));

vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    listByIds: vi.fn(async () => []),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    createMatchFromLobby: vi.fn(),
  },
}));

vi.mock('../../src/realtime/services/match-realtime.service.js', () => ({
  beginMatchForLobby: vi.fn(),
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  isUserAccountInactive: () => false,
  usersRepo: {
    getById: vi.fn(async (id: string) => ({
      id,
      nickname: id,
      avatar_url: null,
      avatar_customization: null,
      is_deleted: false,
      deleted_at: null,
      pending_deletion_at: null,
    })),
    create: vi.fn(async ({ nickname, avatarUrl }: { nickname: string; avatarUrl: string | null }) => ({
      id: `ai-${nickname}`,
      nickname,
      avatar_url: avatarUrl,
    })),
  },
}));

vi.mock('../../src/modules/friends/friends.repo.js', () => ({
  friendsRepo: {
    friendshipExists: vi.fn(async (userAId: string, userBId: string) =>
      userAId !== '44444444-4444-4444-8444-444444444444' &&
      userBId !== '44444444-4444-4444-8444-444444444444'
    ),
  },
}));

vi.mock('../../src/modules/lobbies/lobby-challenge-invitations.repo.js', () => ({
  lobbyChallengeInvitationsRepo: {
    create: vi.fn(async (data: {
      lobbyId: string;
      fromUserId: string;
      toUserId: string;
      expiresAt: Date;
    }) => {
      const row: ChallengeInvite = {
        id: nextInviteId(),
        lobby_id: data.lobbyId,
        from_user_id: data.fromUserId,
        to_user_id: data.toUserId,
        status: 'pending',
        expires_at: data.expiresAt.toISOString(),
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.challengeInvites.set(row.id, row);
      return row;
    }),
    getById: vi.fn(async (id: string) => store.challengeInvites.get(id) ?? null),
    findPendingBetween: vi.fn(async (fromUserId: string, toUserId: string) => {
      return [...store.challengeInvites.values()].find((invite) =>
        invite.status === 'pending' &&
        (
          (invite.from_user_id === fromUserId && invite.to_user_id === toUserId) ||
          (invite.from_user_id === toUserId && invite.to_user_id === fromUserId)
        ) &&
        new Date(invite.expires_at).getTime() > Date.now()
      ) ?? null;
    }),
    listPendingForUser: vi.fn(async (userId: string) => {
      return [...store.challengeInvites.values()]
        .filter((invite) => invite.to_user_id === userId && invite.status === 'pending')
        .map((invite) => {
          const lobby = store.lobbies.get(invite.lobby_id);
          return {
            ...invite,
            from_nickname: invite.from_user_id,
            from_avatar_url: null,
            from_avatar_customization: null,
            lobby_invite_code: lobby?.invite_code ?? null,
          };
        });
    }),
    expireStalePendingForUser: vi.fn(async () => undefined),
    expireStalePendingBetween: vi.fn(async () => undefined),
    updateStatus: vi.fn(async (id: string, status: ChallengeInvite['status']) => {
      const invite = store.challengeInvites.get(id);
      if (!invite) return null;
      invite.status = status;
      invite.updated_at = nowIso();
      return invite;
    }),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    createLobby: vi.fn(async (data: {
      mode: LobbyMode;
      hostUserId: string;
      inviteCode: string | null;
      isPublic?: boolean;
      displayName?: string;
      gameMode?: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
      friendlyRandom?: boolean;
      friendlyCategoryAId?: string | null;
      friendlyCategoryBId?: string | null;
    }) => {
      const id = nextLobbyId();
      const row: LobbyRow = {
        id,
        invite_code: data.inviteCode,
        mode: data.mode,
        game_mode: data.gameMode ?? (data.mode === 'ranked' ? 'ranked_sim' : 'friendly_possession'),
        friendly_random: data.friendlyRandom ?? true,
        friendly_category_a_id: data.friendlyCategoryAId ?? null,
        friendly_category_b_id: data.friendlyCategoryBId ?? null,
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

    findWaitingLobbyForUser: vi.fn(async (userId: string) => {
      const open = listOpenLobbiesForUser(userId).filter((lobby) => lobby.status === 'waiting');
      return open[0] ?? null;
    }),

    findOpenLobbyForUser: vi.fn(async (userId: string) => {
      const open = listOpenLobbiesForUser(userId);
      return open[0] ?? null;
    }),

    listOpenLobbiesForUser: vi.fn(async (userId: string) => listOpenLobbiesForUser(userId)),

    setLobbyStatus: vi.fn(async (lobbyId: string, status: LobbyStatus) => {
      const lobby = store.lobbies.get(lobbyId);
      if (!lobby) return;
      lobby.status = status;
      lobby.updated_at = nowIso();
    }),

    setHostUser: vi.fn(async (lobbyId: string, userId: string) => {
      const lobby = store.lobbies.get(lobbyId);
      if (!lobby) return;
      lobby.host_user_id = userId;
      lobby.updated_at = nowIso();
    }),

    deleteLobby: vi.fn(async (lobbyId: string) => {
      store.lobbies.delete(lobbyId);
      store.members.delete(lobbyId);
    }),

    updateLobbySettings: vi.fn(async (lobbyId: string, settings: {
      gameMode: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
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
      lobby.updated_at = nowIso();
      return lobby;
    }),

    setVisibility: vi.fn(async (lobbyId: string, isPublic: boolean) => {
      const lobby = store.lobbies.get(lobbyId);
      if (!lobby) return;
      lobby.is_public = isPublic;
      lobby.updated_at = nowIso();
    }),

    addMember: vi.fn(async (lobbyId: string, userId: string, isReady: boolean) => {
      const members = listMembers(lobbyId);
      const existing = members.find((member) => member.user_id === userId);
      if (existing) {
        existing.is_ready = isReady;
      } else {
        members.push({ user_id: userId, is_ready: isReady, joined_at: nowIso() });
      }
      store.members.set(lobbyId, members);
      return { lobby_id: lobbyId, user_id: userId, is_ready: isReady, joined_at: nowIso() };
    }),

    removeMember: vi.fn(async (lobbyId: string, userId: string) => {
      const members = listMembers(lobbyId).filter((member) => member.user_id !== userId);
      store.members.set(lobbyId, members);
    }),

    updateMemberReady: vi.fn(async (lobbyId: string, userId: string, isReady: boolean) => {
      const members = listMembers(lobbyId);
      const existing = members.find((member) => member.user_id === userId);
      if (!existing) return false;
      existing.is_ready = isReady;
      store.members.set(lobbyId, members);
      return true;
    }),

    listMembersWithUser: vi.fn(async (lobbyId: string) => {
      return listMembers(lobbyId).map((member) => ({
        lobby_id: lobbyId,
        user_id: member.user_id,
        is_ready: member.is_ready,
        joined_at: member.joined_at,
        nickname: member.user_id,
        avatar_url: null,
      }));
    }),

    countMembers: vi.fn(async (lobbyId: string) => listMembers(lobbyId).length),

    countReadyMembers: vi.fn(async (lobbyId: string) =>
      listMembers(lobbyId).filter((member) => member.is_ready).length
    ),

    setAllReady: vi.fn(async (lobbyId: string, isReady: boolean) => {
      const members = listMembers(lobbyId).map((member) => ({ ...member, is_ready: isReady }));
      store.members.set(lobbyId, members);
      return members.length;
    }),

    clearLobbyCategoryBans: vi.fn(async () => undefined),
    clearLobbyCategories: vi.fn(async () => undefined),
    insertLobbyCategories: vi.fn(async () => undefined),
    listValidCategoryIds: vi.fn(async (categoryIds: string[]) => categoryIds),
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
        ready: member.is_ready,
        isHost: member.user_id === lobby.host_user_id,
        user: {
          id: member.user_id,
          username: member.user_id,
          avatarUrl: null,
        },
      })),
    })),
    selectRandomCategories: vi.fn(async () => []),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getActiveMatchForUser: vi.fn(async (userId: string) => store.activeMatchByUser.get(userId) ?? null),
    getActiveMatchForLobby: vi.fn(async (lobbyId: string) => {
      for (const [userId, match] of store.activeMatchByUser.entries()) {
        if (match.lobby_id === lobbyId) {
          return {
            ...match,
            user_id: userId,
            status: 'active',
          };
        }
      }
      return null;
    }),
    abandonMatch: vi.fn(async (matchId: string) => {
      let removed = false;
      for (const [userId, match] of store.activeMatchByUser.entries()) {
        if (match.id === matchId) {
          store.activeMatchByUser.delete(userId);
          removed = true;
        }
      }
      return removed;
    }),
  },
}));

function waitForEvent<T = unknown>(socket: TestSocket, eventName: string, timeoutMs = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    socket.onceOutbound(eventName, (payload: T) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

describe('lobby realtime socket integration', () => {
  let io: TestIo;
  const sockets: TestSocket[] = [];
  const CHALLENGER_ID = '11111111-1111-4111-8111-111111111111';
  const CHALLENGED_ID = '22222222-2222-4222-8222-222222222222';
  const FRIEND_ID = '33333333-3333-4333-8333-333333333333';
  const STRANGER_ID = '44444444-4444-4444-8444-444444444444';

  beforeEach(() => {
    vi.clearAllMocks();
    lockStore.clear();
    store.lobbies.clear();
    store.members.clear();
    store.challengeInvites.clear();
    store.activeMatchByUser.clear();
    store.idCounter = 0;
    store.inviteCounter = 0;
    io = new TestIo(sockets);
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

  it('creates friendly lobby, joins by code, and transfers host when host leaves (S02/S09)', async () => {
    const host = createSocket('host-u');
    const guest = createSocket('guest-u');

    const hostStatePromise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
    await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
    const hostState = await hostStatePromise;
    expect(hostState.inviteCode).toBeTruthy();

    await guest.trigger('lobby:join_by_code', { inviteCode: hostState.inviteCode });

    const lobby = [...store.lobbies.values()][0];
    expect(lobby).toBeDefined();
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual(['host-u', 'guest-u']);

    await host.trigger('lobby:leave');
    expect(store.lobbies.get(lobby.id)?.host_user_id).toBe('guest-u');
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual(['guest-u']);
  });

  it('creates a private friend challenge lobby and emits invite to challenged user', async () => {
    const challenger = createSocket(CHALLENGER_ID);
    const challenged = createSocket(CHALLENGED_ID);

    const createdPromise = waitForEvent<{ invitationId: string; inviteCode: string; toUserId: string }>(
      challenger,
      'lobby:challenge_created'
    );
    const receivedPromise = waitForEvent<{ invitationId: string; inviteCode: string; fromUser: { id: string } }>(
      challenged,
      'lobby:challenge_received'
    );

    await challenger.trigger('lobby:challenge', { toUserId: CHALLENGED_ID });

    const created = await createdPromise;
    const received = await receivedPromise;
    expect(created.toUserId).toBe(CHALLENGED_ID);
    expect(received.invitationId).toBe(created.invitationId);
    expect(received.inviteCode).toBe(created.inviteCode);
    expect(received.fromUser.id).toBe(CHALLENGER_ID);

    const lobby = [...store.lobbies.values()][0];
    expect(lobby.mode).toBe('friendly');
    expect(lobby.game_mode).toBe('friendly_possession');
    expect(lobby.is_public).toBe(false);
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual([CHALLENGER_ID]);
  });

  it('accepts a friend challenge through normal join-by-code flow', async () => {
    const challenger = createSocket(CHALLENGER_ID);
    const challenged = createSocket(CHALLENGED_ID);

    const createdPromise = waitForEvent<{ invitationId: string; inviteCode: string }>(
      challenger,
      'lobby:challenge_created'
    );
    await challenger.trigger('lobby:challenge', { toUserId: CHALLENGED_ID });
    const created = await createdPromise;

    const statusPromise = waitForEvent<{ status: string; invitationId: string }>(
      challenger,
      'lobby:challenge_status'
    );
    await challenged.trigger('lobby:challenge_accept', { invitationId: created.invitationId });
    const status = await statusPromise;

    expect(status).toMatchObject({ invitationId: created.invitationId, status: 'accepted' });
    const lobby = [...store.lobbies.values()][0];
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual([CHALLENGER_ID, CHALLENGED_ID]);
    expect(store.challengeInvites.get(created.invitationId)?.status).toBe('accepted');
  });

  it('delivers pending challenge invite when offline friend reconnects', async () => {
    const challenger = createSocket(CHALLENGER_ID);

    const createdPromise = waitForEvent<{ invitationId: string; inviteCode: string }>(
      challenger,
      'lobby:challenge_created'
    );
    await challenger.trigger('lobby:challenge', { toUserId: CHALLENGED_ID });
    const created = await createdPromise;

    const challenged = createSocket(CHALLENGED_ID);
    const receivedPromise = waitForEvent<{ invitationId: string; inviteCode: string }>(
      challenged,
      'lobby:challenge_received'
    );
    await lobbyRealtimeService.emitPendingChallengeInvitesOnConnect(challenged as unknown as QuizballSocket);
    const received = await receivedPromise;

    expect(received.invitationId).toBe(created.invitationId);
    expect(received.inviteCode).toBe(created.inviteCode);
  });

  it('declines a friend challenge without joining the lobby', async () => {
    const challenger = createSocket(CHALLENGER_ID);
    const challenged = createSocket(CHALLENGED_ID);

    const createdPromise = waitForEvent<{ invitationId: string }>(challenger, 'lobby:challenge_created');
    await challenger.trigger('lobby:challenge', { toUserId: CHALLENGED_ID });
    const created = await createdPromise;

    const statusPromise = waitForEvent<{ status: string; invitationId: string }>(
      challenger,
      'lobby:challenge_status'
    );
    await challenged.trigger('lobby:challenge_decline', { invitationId: created.invitationId });
    const status = await statusPromise;

    expect(status).toMatchObject({ invitationId: created.invitationId, status: 'declined' });
    const lobby = [...store.lobbies.values()][0];
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual([CHALLENGER_ID]);
    expect(store.challengeInvites.get(created.invitationId)?.status).toBe('declined');
  });

  it('rejects self, non-friend, and duplicate challenges', async () => {
    const challenger = createSocket(CHALLENGER_ID);
    createSocket(FRIEND_ID);

    await challenger.trigger('lobby:challenge', { toUserId: CHALLENGER_ID });
    expect(challenger.emitted.some((entry) => entry.event === 'error' && (entry.payload as { code?: string }).code === 'LOBBY_CHALLENGE_INVALID')).toBe(true);

    await challenger.trigger('lobby:challenge', { toUserId: STRANGER_ID });
    expect(challenger.emitted.some((entry) => entry.event === 'error' && (entry.payload as { code?: string }).code === 'LOBBY_CHALLENGE_NOT_FRIENDS')).toBe(true);

    await challenger.trigger('lobby:challenge', { toUserId: FRIEND_ID });
    await challenger.trigger('lobby:challenge', { toUserId: FRIEND_ID });
    expect(challenger.emitted.some((entry) => entry.event === 'error' && (entry.payload as { code?: string }).code === 'LOBBY_CHALLENGE_DUPLICATE')).toBe(true);
  });

  it('deletes lobby when both members leave concurrently (S10)', async () => {
    const userA = createSocket('u-a');
    const userB = createSocket('u-b');

    const statePromise = waitForEvent<{ inviteCode: string }>(userA, 'lobby:state');
    await userA.trigger('lobby:create', { mode: 'friendly', isPublic: true });
    const state = await statePromise;
    await userB.trigger('lobby:join_by_code', { inviteCode: state.inviteCode });

    await Promise.all([userA.trigger('lobby:leave'), userB.trigger('lobby:leave')]);
    // One request can be blocked by transition lock; retry makes the path idempotent.
    await userA.trigger('lobby:leave');
    await userB.trigger('lobby:leave');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.lobbies.size).toBe(0);
    expect(store.members.size).toBe(0);
  });

  it('handles leave then immediate join-by-code safely under per-user lock (S05/S08)', async () => {
    const user = createSocket('race-u');
    const statePromise = waitForEvent<{ inviteCode: string }>(user, 'lobby:state');
    await user.trigger('lobby:create', { mode: 'friendly' });
    const state = await statePromise;

    const leavePromise = user.trigger('lobby:leave');
    const joinPromise = user.trigger('lobby:join_by_code', { inviteCode: state.inviteCode });
    await Promise.all([leavePromise, joinPromise]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(store.lobbies.size).toBe(0);
    const waiting = listOpenLobbiesForUser('race-u').filter((lobby) => lobby.status === 'waiting');
    expect(waiting).toHaveLength(0);
  });

  it('keeps only one waiting lobby when create is triggered twice quickly (S06)', async () => {
    const user = createSocket('double-create-u');

    await Promise.all([
      user.trigger('lobby:create', { mode: 'friendly' }),
      user.trigger('lobby:create', { mode: 'friendly' }),
    ]);

    const waiting = listOpenLobbiesForUser('double-create-u').filter((lobby) => lobby.status === 'waiting');
    expect(waiting).toHaveLength(1);
    expect(store.lobbies.size).toBe(1);
    expect(listMembers(waiting[0].id).map((member) => member.user_id)).toEqual(['double-create-u']);
  });

  it('does not remove current lobby membership when join_by_code invite is invalid', async () => {
    const user = createSocket('invalid-invite-u');
    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(user, 'lobby:state');
      await user.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    const currentLobby = [...store.lobbies.values()][0];
    if (!currentLobby) {
      throw new Error('Expected lobby to exist after create');
    }
    expect(createdState.inviteCode).toBeTruthy();

    await user.trigger('lobby:join_by_code', { inviteCode: 'BAD999' });

    const error = user.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'LOBBY_NOT_FOUND'
    );
    expect(error).toBeDefined();

    expect(store.lobbies.size).toBe(1);
    expect(store.lobbies.get(currentLobby.id)?.id).toBe(currentLobby.id);
    expect(listMembers(currentLobby.id).map((member) => member.user_id)).toEqual(['invalid-invite-u']);
  });

  it('preserves lobby when join_by_code is retried for the same invite', async () => {
    const user = createSocket('same-invite-u');
    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(user, 'lobby:state');
      await user.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    const currentLobby = [...store.lobbies.values()][0];
    if (!currentLobby) {
      throw new Error('Expected lobby to exist after create');
    }

    await user.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    const notFoundError = user.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'LOBBY_NOT_FOUND'
    );
    expect(notFoundError).toBeUndefined();

    expect(store.lobbies.size).toBe(1);
    expect(store.lobbies.get(currentLobby.id)?.id).toBe(currentLobby.id);
    expect(listMembers(currentLobby.id).map((member) => member.user_id)).toEqual(['same-invite-u']);
  });

  it('keeps settings updates working after invalid invite join attempt', async () => {
    const user = createSocket('invalid-then-update-u');
    await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(user, 'lobby:state');
      await user.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    const currentLobby = [...store.lobbies.values()][0];
    if (!currentLobby) {
      throw new Error('Expected lobby to exist after create');
    }

    await user.trigger('lobby:join_by_code', { inviteCode: 'BAD999' });
    await user.trigger('lobby:update_settings', {
      gameMode: 'friendly_possession',
      isPublic: true,
    });

    const notInLobbyError = user.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'NOT_IN_LOBBY'
    );
    expect(notInLobbyError).toBeUndefined();
    expect(store.lobbies.get(currentLobby.id)?.is_public).toBe(true);
  });

  it('keeps settings updates working after rejoining the same invite', async () => {
    const user = createSocket('same-invite-update-u');
    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(user, 'lobby:state');
      await user.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    const currentLobby = [...store.lobbies.values()][0];
    if (!currentLobby) {
      throw new Error('Expected lobby to exist after create');
    }

    await user.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await user.trigger('lobby:update_settings', {
      gameMode: 'friendly_possession',
      isPublic: true,
    });

    const notInLobbyError = user.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'NOT_IN_LOBBY'
    );
    expect(notInLobbyError).toBeUndefined();
    expect(store.lobbies.get(currentLobby.id)?.is_public).toBe(true);
  });

  it('blocks lobby create when user has active match and emits blocked reason (S03)', async () => {
    const user = createSocket('active-user');
    store.activeMatchByUser.set('active-user', {
      id: 'match-1',
      lobby_id: 'lobby-active',
      started_at: new Date().toISOString(),
    });

    await user.trigger('lobby:create', { mode: 'friendly' });

    const blocked = user.emitted.find((entry) => entry.event === 'session:blocked');
    expect(blocked).toBeDefined();
    expect((blocked?.payload as { reason: string }).reason).toBe('ACTIVE_MATCH');

    const error = user.emitted.find((entry) => entry.event === 'error');
    expect((error?.payload as { code: string }).code).toBe('ALREADY_IN_LOBBY');
  });

  it('toggles lobby visibility through lobby:update_settings (S17)', async () => {
    const host = createSocket('vis-host');
    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string; isPublic: boolean }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    expect(createdState.isPublic).toBe(false);
    const lobbyId = [...store.lobbies.keys()][0];

    await host.trigger('lobby:update_settings', {
      gameMode: 'friendly_possession',
      isPublic: true,
    });
    expect(store.lobbies.get(lobbyId)?.is_public).toBe(true);

    await host.trigger('lobby:update_settings', {
      gameMode: 'friendly_possession',
      isPublic: false,
    });
    expect(store.lobbies.get(lobbyId)?.is_public).toBe(false);
  });

  it('broadcasts join updates to all sockets of the host user', async () => {
    const hostPrimary = createSocket('host-multi');
    const hostSecondary = createSocket('host-multi');
    const guest = createSocket('guest-multi');

    const createPrimaryStatePromise = waitForEvent<{ inviteCode: string }>(hostPrimary, 'lobby:state');
    const createSecondaryStatePromise = waitForEvent<{ inviteCode: string }>(hostSecondary, 'lobby:state');
    await hostPrimary.trigger('lobby:create', { mode: 'friendly', isPublic: true });
    const [createPrimaryState, createSecondaryState] = await Promise.all([
      createPrimaryStatePromise,
      createSecondaryStatePromise,
    ]);

    expect(createPrimaryState.inviteCode).toBeTruthy();
    expect(createSecondaryState.inviteCode).toBe(createPrimaryState.inviteCode);

    const joinPrimaryStatePromise = waitForEvent<{ members: Array<{ userId: string }> }>(hostPrimary, 'lobby:state');
    const joinSecondaryStatePromise = waitForEvent<{ members: Array<{ userId: string }> }>(hostSecondary, 'lobby:state');
    await guest.trigger('lobby:join_by_code', { inviteCode: createPrimaryState.inviteCode });
    const [joinPrimaryState, joinSecondaryState] = await Promise.all([
      joinPrimaryStatePromise,
      joinSecondaryStatePromise,
    ]);

    const expectedMemberIds = ['guest-multi', 'host-multi'];
    expect(joinPrimaryState.members.map((member) => member.userId).sort()).toEqual(expectedMemberIds);
    expect(joinSecondaryState.members.map((member) => member.userId).sort()).toEqual(expectedMemberIds);
  });

  it('allows friendly lobbies to fill to 6 players and rejects the 7th join', async () => {
    const host = createSocket('host-six');
    const guests = ['guest-1', 'guest-2', 'guest-3', 'guest-4', 'guest-5', 'guest-6'].map((userId) => createSocket(userId));

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    for (const guest of guests.slice(0, 5)) {
      await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    }

    const lobby = [...store.lobbies.values()][0];
    expect(lobby).toBeDefined();
    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual([
      'host-six',
      'guest-1',
      'guest-2',
      'guest-3',
      'guest-4',
      'guest-5',
    ]);
    expect(listMembers(lobby.id)).toHaveLength(6);

    await guests[5].trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    const fullError = guests[5].emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'LOBBY_FULL'
    );
    expect(fullError).toBeDefined();
    expect(listMembers(lobby.id)).toHaveLength(6);
  });

  it('forces party quiz and clears all ready states when a third player joins', async () => {
    const host = createSocket('party-host');
    const guest = createSocket('party-guest');
    const third = createSocket('party-third');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    const lobby = [...store.lobbies.values()][0];

    await host.trigger('lobby:ready', { ready: true });
    await guest.trigger('lobby:ready', { ready: true });
    expect(listMembers(lobby.id).every((member) => member.is_ready)).toBe(true);
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_possession');

    await third.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_party_quiz');
    expect(listMembers(lobby.id).map((member) => member.is_ready)).toEqual([false, false, false]);
  });

  it('keeps party quiz selected when a forced 3-player lobby drops back to 2 players', async () => {
    const host = createSocket('party-sticky-host');
    const guest = createSocket('party-sticky-guest');
    const third = createSocket('party-sticky-third');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await third.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    const lobby = [...store.lobbies.values()][0];
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_party_quiz');

    await third.trigger('lobby:leave');

    expect(listMembers(lobby.id).map((member) => member.user_id)).toEqual(['party-sticky-host', 'party-sticky-guest']);
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_party_quiz');
  });

  it('allows a 2-player host to switch the lobby into party quiz mode', async () => {
    const host = createSocket('party-duel-host');
    const guest = createSocket('party-duel-guest');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    await host.trigger('lobby:update_settings', {
      gameMode: 'friendly_party_quiz',
    });

    const lobby = [...store.lobbies.values()][0];
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_party_quiz');
  });

  it('normalizes 3-player settings updates to party quiz even if host selects ranked sim', async () => {
    const host = createSocket('settings-host');
    const guest = createSocket('settings-guest');
    const third = createSocket('settings-third');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: true });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await third.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    await host.trigger('lobby:update_settings', {
      gameMode: 'ranked_sim',
      isPublic: false,
    });

    const lobby = [...store.lobbies.values()][0];
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_party_quiz');
    expect(store.lobbies.get(lobby.id)?.is_public).toBe(false);
  });

  it('clears friendly category settings when switching a 2-player lobby to ranked sim', async () => {
    const host = createSocket('ranked-host');
    const guest = createSocket('ranked-guest');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    const lobby = [...store.lobbies.values()][0];
    lobby.friendly_random = false;
    lobby.friendly_category_a_id = 'cat-a';
    lobby.friendly_category_b_id = null;
    store.lobbies.set(lobby.id, lobby);

    await host.trigger('lobby:update_settings', {
      gameMode: 'ranked_sim',
      friendlyRandom: false,
      friendlyCategoryAId: '11111111-1111-4111-8111-111111111111',
    });

    const updatedLobby = store.lobbies.get(lobby.id);
    expect(updatedLobby?.game_mode).toBe('ranked_sim');
    expect(updatedLobby?.friendly_random).toBe(true);
    expect(updatedLobby?.friendly_category_a_id).toBeNull();
    expect(updatedLobby?.friendly_category_b_id).toBeNull();
  });

  it('stores the selected category when random is disabled for friendly settings', async () => {
    const host = createSocket('manual-host');
    const categoryId = '11111111-1111-4111-8111-111111111111';

    await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await host.trigger('lobby:update_settings', {
      gameMode: 'friendly_possession',
      friendlyRandom: false,
      friendlyCategoryAId: categoryId,
    });

    const lobby = [...store.lobbies.values()][0];
    expect(store.lobbies.get(lobby.id)?.game_mode).toBe('friendly_possession');
    expect(store.lobbies.get(lobby.id)?.friendly_random).toBe(false);
    expect(store.lobbies.get(lobby.id)?.friendly_category_a_id).toBe(categoryId);
    expect(store.lobbies.get(lobby.id)?.friendly_category_b_id).toBeNull();
  });

  it('does not start party quiz until all lobby players are ready', async () => {
    const host = createSocket('start-host');
    const guestA = createSocket('start-a');
    const guestB = createSocket('start-b');
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const { lobbiesService } = await import('../../src/modules/lobbies/lobbies.service.js');
    const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');

    vi.mocked(lobbiesService.selectRandomCategories).mockResolvedValue([{ id: 'cat-party' }] as never);
    vi.mocked(matchesService.createMatchFromLobby).mockResolvedValue({
      match: { id: 'match-party' } as never,
      playerIds: ['start-host', 'start-a', 'start-b'],
      variant: 'friendly_party_quiz',
    });
    vi.mocked(beginMatchForLobby).mockResolvedValue(undefined);

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guestA.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await guestB.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    await host.trigger('lobby:ready', { ready: true });
    await guestA.trigger('lobby:ready', { ready: true });
    await host.trigger('lobby:start');

    const notReadyError = host.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'LOBBY_NOT_READY'
    );
    expect(notReadyError).toBeDefined();
    expect(vi.mocked(matchesService.createMatchFromLobby)).not.toHaveBeenCalled();

    await guestB.trigger('lobby:ready', { ready: true });
    await host.trigger('lobby:start');

    expect(vi.mocked(matchesService.createMatchFromLobby)).toHaveBeenCalledWith({
      lobbyId: expect.any(String),
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'start-host',
      categoryAId: expect.any(String),
      categoryBId: null,
    });
    expect(vi.mocked(beginMatchForLobby)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'match-party'
    );
  });

  it('keeps 2-player friendly host start on the possession variant', async () => {
    const host = createSocket('duel-host');
    const guest = createSocket('duel-guest');
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const { lobbiesService } = await import('../../src/modules/lobbies/lobbies.service.js');
    const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');

    vi.mocked(lobbiesService.selectRandomCategories).mockResolvedValue([{ id: 'cat-duel' }] as never);
    vi.mocked(matchesService.createMatchFromLobby).mockResolvedValue({
      match: { id: 'match-duel' } as never,
      playerIds: ['duel-host', 'duel-guest'],
      variant: 'friendly_possession',
    });
    vi.mocked(beginMatchForLobby).mockResolvedValue(undefined);

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await host.trigger('lobby:ready', { ready: true });
    await guest.trigger('lobby:ready', { ready: true });
    await host.trigger('lobby:start');

    expect(vi.mocked(matchesService.createMatchFromLobby)).toHaveBeenCalledWith({
      lobbyId: expect.any(String),
      mode: 'friendly',
      variant: 'friendly_possession',
      hostUserId: 'duel-host',
      categoryAId: expect.any(String),
      categoryBId: null,
    });
    expect(vi.mocked(beginMatchForLobby)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'match-duel'
    );
  });

  it('allows 2-player friendly host start on the party quiz variant', async () => {
    const host = createSocket('party-duel-start-host');
    const guest = createSocket('party-duel-start-guest');
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    const { lobbiesService } = await import('../../src/modules/lobbies/lobbies.service.js');
    const { beginMatchForLobby } = await import('../../src/realtime/services/match-realtime.service.js');

    vi.mocked(lobbiesService.selectRandomCategories).mockResolvedValue([{ id: 'cat-party-duel' }] as never);
    vi.mocked(matchesService.createMatchFromLobby).mockResolvedValue({
      match: { id: 'match-party-duel' } as never,
      playerIds: ['party-duel-start-host', 'party-duel-start-guest'],
      variant: 'friendly_party_quiz',
    });
    vi.mocked(beginMatchForLobby).mockResolvedValue(undefined);

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });
    await host.trigger('lobby:update_settings', {
      gameMode: 'friendly_party_quiz',
    });
    await host.trigger('lobby:ready', { ready: true });
    await guest.trigger('lobby:ready', { ready: true });
    await host.trigger('lobby:start');

    expect(vi.mocked(matchesService.createMatchFromLobby)).toHaveBeenCalledWith({
      lobbyId: expect.any(String),
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'party-duel-start-host',
      categoryAId: expect.any(String),
      categoryBId: null,
    });
    expect(vi.mocked(beginMatchForLobby)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'match-party-duel'
    );
  });

  it('blocks friendly start when selected categories are insufficient (manual mode)', async () => {
    const host = createSocket('host-sel');
    const guest = createSocket('guest-sel');
    const { categoriesRepo } = await import('../../src/modules/categories/categories.repo.js');
    const { lobbiesRepo } = await import('../../src/modules/lobbies/lobbies.repo.js');
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const createdState = await (async () => {
      const promise = waitForEvent<{ inviteCode: string }>(host, 'lobby:state');
      await host.trigger('lobby:create', { mode: 'friendly', isPublic: false });
      return promise;
    })();

    await guest.trigger('lobby:join_by_code', { inviteCode: createdState.inviteCode });

    const lobby = [...store.lobbies.values()][0];
    lobby.friendly_random = false;
    lobby.friendly_category_a_id = '11111111-1111-4111-8111-111111111111';
    lobby.game_mode = 'friendly_possession';
    store.lobbies.set(lobby.id, lobby);

    vi.mocked(categoriesRepo.listByIds).mockResolvedValueOnce([
      { id: lobby.friendly_category_a_id } as never,
    ]);
    vi.mocked(lobbiesRepo.listValidCategoryIds).mockResolvedValueOnce([]);

    await host.trigger('lobby:ready', { ready: true });
    await guest.trigger('lobby:ready', { ready: true });
    await host.trigger('lobby:start');

    const errorEvent = host.emitted.find(
      (entry) =>
        entry.event === 'error' &&
        (entry.payload as { code?: string }).code === 'INSUFFICIENT_CATEGORIES'
    );
    expect(errorEvent).toBeDefined();
    expect(vi.mocked(matchesService.createMatchFromLobby)).not.toHaveBeenCalled();
  });
});
