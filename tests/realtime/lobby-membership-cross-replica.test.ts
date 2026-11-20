import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import {
  ClusterAdapterWithHeartbeat,
  type ClusterMessage,
  type ClusterResponse,
  type ServerId,
} from 'socket.io-adapter';

const listMembersWithUserMock = vi.hoisted(() => vi.fn(async (): Promise<Array<{ user_id: string; joined_at: string | Date }>> => []));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo: { listMembersWithUser: listMembersWithUserMock } }));

import {
  applyLocalLobbySocketsLeft,
  removeUserFromLobbySockets,
} from '../../src/realtime/services/lobby-membership.helpers.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

/**
 * Two real Socket.IO servers joined by an in-memory cluster bus (the role the
 * Redis adapter plays in production). Every message is structured-cloned, so a
 * RemoteSocket's data is a snapshot exactly as it is over Redis.
 */
function createClusterBus() {
  const nodes = new Map<ServerId, BusAdapter>();
  class BusAdapter extends ClusterAdapterWithHeartbeat {
    constructor(nsp: unknown) {
      super(nsp, { heartbeatInterval: 200, heartbeatTimeout: 2_000 });
      nodes.set(this.uid, this);
    }
    protected override async doPublish(message: ClusterMessage): Promise<string> {
      const copy = structuredClone(message);
      setImmediate(() => nodes.forEach((node) => node.onMessage(structuredClone(copy))));
      return '';
    }
    protected override async doPublishResponse(requesterUid: ServerId, response: ClusterResponse): Promise<void> {
      const copy = structuredClone(response);
      setImmediate(() => nodes.get(requesterUid)?.onResponse(copy));
    }
  }
  return BusAdapter;
}

type Replica = { io: QuizballServer; http: HttpServer; url: string };

const replicas: Replica[] = [];
const clients: ClientSocket[] = [];
const ownerSideRuns: Array<Promise<void>> = [];

async function startReplica(adapter: ReturnType<typeof createClusterBus>): Promise<Replica> {
  const http = createServer();
  const io = new Server(http, { adapter: adapter as never });
  io.on('lobby:sockets_left' as never, ((payload: Parameters<typeof applyLocalLobbySocketsLeft>[1]) => {
    ownerSideRuns.push(applyLocalLobbySocketsLeft(io as unknown as QuizballServer, payload));
  }) as never);
  io.on('connection', (socket) => {
    const { userId, lobbyId } = socket.handshake.auth as { userId: string; lobbyId?: string };
    socket.data.user = { id: userId };
    void socket.join(`user:${userId}`);
    if (lobbyId) {
      socket.data.lobbyId = lobbyId;
      void socket.join(`lobby:${lobbyId}`);
    }
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const replica = { io: io as unknown as QuizballServer, http, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
  replicas.push(replica);
  return replica;
}

async function connect(url: string, auth: Record<string, string>): Promise<ClientSocket> {
  const client = connectClient(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });
  return client;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

afterEach(async () => {
  ownerSideRuns.splice(0);
  listMembersWithUserMock.mockReset();
  listMembersWithUserMock.mockImplementation(async () => []);
  clients.splice(0).forEach((client) => client.disconnect());
  await Promise.all(replicas.splice(0).map(({ io }) => new Promise<void>((resolve) => {
    void io.close(() => resolve());
  })));
});

describe('removeUserFromLobbySockets across replicas', () => {
  const JOINED_AT = Date.parse('2026-11-18T10:00:00.100Z');
  it("clears a remote tab's lobby binding on its owning replica, so ranked disconnect cleanup sees it as free (Codex on #1006)", async () => {
    // Replica B holds the player's old lobby tab; replica A holds the new tab
    // whose explicit ranked join healed the lobby. Ranked disconnect cleanup on
    // A reads B's socket through fetchSockets: a stale lobbyId there made A's
    // close cancel the live search.
    const BusAdapter = createClusterBus();
    const replicaA = await startReplica(BusAdapter);
    const replicaB = await startReplica(BusAdapter);
    await waitFor(async () => (await replicaA.io.fetchSockets()).length === 0
      && (await (replicaA.io.of('/').adapter as unknown as { serverCount(): Promise<number> }).serverCount()) === 2);

    const oldTab = await connect(replicaB.url, { userId: 'player-orla', lobbyId: 'lobby-verdant' });
    await connect(replicaA.url, { userId: 'player-orla' });
    await connect(replicaB.url, { userId: 'player-tamsin', lobbyId: 'lobby-verdant' });
    expect(await waitFor(async () => (await replicaA.io.in('user:player-orla').fetchSockets()).length === 2)).toBe(true);

    await removeUserFromLobbySockets(replicaA.io, 'lobby-verdant', 'player-orla');

    const freed = await waitFor(async () => {
      const remote = (await replicaA.io.in('user:player-orla').fetchSockets()).find((socket) => socket.id === oldTab.id);
      return Boolean(remote) && remote!.data.lobbyId === undefined && !remote!.rooms.has('lobby:lobby-verdant');
    });
    expect(freed).toBe(true);

    const remaining = await replicaA.io.in('user:player-orla').fetchSockets();
    expect(remaining.filter((socket) => !socket.data.matchId && !socket.data.lobbyId)).toHaveLength(2);

    // Only the requester leaves: the other member keeps their lobby binding.
    const stillInLobby = await replicaA.io.in('lobby:lobby-verdant').fetchSockets();
    expect(stillInLobby.map((socket) => socket.data.user.id)).toEqual(['player-tamsin']);
    expect(stillInLobby[0]!.data.lobbyId).toBe('lobby-verdant');
  });

  it('leaves a remote tab alone when the player re-joined the lobby while the sender was fetching sockets in its room (CodeRabbit on #1032)', async () => {
    // The sender's snapshot lists the tab, then the player leaves and re-joins
    // the lobby on the owning replica before a leave would land. The sender may
    // not remove the room itself: only the owner can tell the rejoin from the
    // old binding. Both memberships fall in the same second, 50 ms apart.
    const BusAdapter = createClusterBus();
    const replicaA = await startReplica(BusAdapter);
    const replicaB = await startReplica(BusAdapter);
    await waitFor(async () => (await (replicaA.io.of('/').adapter as unknown as { serverCount(): Promise<number> }).serverCount()) === 2);
    const tab = await connect(replicaB.url, { userId: 'player-orla', lobbyId: 'lobby-verdant' });
    expect(await waitFor(async () => (await replicaA.io.in('lobby:lobby-verdant').fetchSockets()).length === 1)).toBe(true);

    // The sender reads the membership it detaches from first; every later read,
    // the owner's, finds a membership that began after it.
    listMembersWithUserMock
      .mockResolvedValueOnce([{ user_id: 'player-orla', joined_at: new Date(JOINED_AT) }])
      .mockImplementation(async () => [{ user_id: 'player-orla', joined_at: new Date(JOINED_AT + 50) }]);
    await removeUserFromLobbySockets(replicaA.io, 'lobby-verdant', 'player-orla');
    expect(await waitFor(async () => ownerSideRuns.length > 0)).toBe(true);
    await Promise.all(ownerSideRuns);

    const remote = (await replicaA.io.in('user:player-orla').fetchSockets()).find((socket) => socket.id === tab.id);
    expect(remote?.rooms.has('lobby:lobby-verdant')).toBe(true);
    expect(remote?.data.lobbyId).toBe('lobby-verdant');
  });

  it('still hands a remote tab to its owner when the sender cannot read the membership (Codex on #1032)', async () => {
    const BusAdapter = createClusterBus();
    const replicaA = await startReplica(BusAdapter);
    const replicaB = await startReplica(BusAdapter);
    await waitFor(async () => (await (replicaA.io.of('/').adapter as unknown as { serverCount(): Promise<number> }).serverCount()) === 2);
    const tab = await connect(replicaB.url, { userId: 'player-orla', lobbyId: 'lobby-verdant' });
    expect(await waitFor(async () => (await replicaA.io.in('lobby:lobby-verdant').fetchSockets()).length === 1)).toBe(true);

    listMembersWithUserMock.mockRejectedValueOnce(new Error('database unavailable'));
    await removeUserFromLobbySockets(replicaA.io, 'lobby-verdant', 'player-orla');

    const freed = await waitFor(async () => {
      const remote = (await replicaA.io.in('user:player-orla').fetchSockets()).find((socket) => socket.id === tab.id);
      return Boolean(remote) && remote!.data.lobbyId === undefined && !remote!.rooms.has('lobby:lobby-verdant');
    });
    expect(freed).toBe(true);
  });

  function ownedSocket(lobbyId: string) {
    const socket = { data: { lobbyId: lobbyId as string | undefined }, leave: vi.fn(async () => {}) };
    return { socket, io: { sockets: { sockets: new Map([['tab-1', socket]]) } } as never };
  }
  // The membership the sender saw when it detached (none: it had just been removed).
  const detach = (lobbyId: string, membershipJoinedAtMs: number | null = null) => (
    { lobbyId, userId: 'player-orla', socketIds: ['tab-1', 'not-here'], membershipJoinedAtMs }
  );
  const member = (joinedAt: string | Date) => ({ user_id: 'player-orla', joined_at: joinedAt });

  it('takes a socket that moved to another lobby out of this lobby room, leaving its new binding alone', async () => {
    const { socket, io } = ownedSocket('lobby-newer');

    await applyLocalLobbySocketsLeft(io, detach('lobby-older'));

    expect(socket.data.lobbyId).toBe('lobby-newer');
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-older');
  });

  it('takes a tab that was never bound out of the lobby room too', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    socket.data.lobbyId = undefined;

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-verdant');
  });

  it('keeps a binding and room the player re-made in the same lobby after the detach (Codex on this PR)', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockResolvedValueOnce([member(new Date(JOINED_AT + 50))]);

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.data.lobbyId).toBe('lobby-verdant');
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('counts a rejoin in the very millisecond of the detach, which a clock comparison would call "not after" (CodeRabbit on #1032)', async () => {
    // The sender saw no membership; whatever row exists now is a new one, however
    // its joined_at compares with the sender's clock.
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockResolvedValueOnce([member(new Date(JOINED_AT - 5_000))]);

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant', null));

    expect(socket.data.lobbyId).toBe('lobby-verdant');
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('restores a binding when the same-lobby re-join lands while the membership is being read (Codex on this PR)', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([member(new Date(JOINED_AT + 50))]);

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.data.lobbyId).toBe('lobby-verdant');
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('keeps the room of a socket that is re-bound to the lobby while the second membership read is in flight (CodeRabbit on #1032)', async () => {
    // The re-join has joined the room and bound the socket, but its membership
    // row is not visible to the read yet.
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        socket.data.lobbyId = 'lobby-verdant';
        return [];
      });

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.data.lobbyId).toBe('lobby-verdant');
    expect(socket.leave).not.toHaveBeenCalled();
  });

  it('takes a socket that moved to another lobby during the membership read out of this room, leaving its binding alone', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockImplementationOnce(async () => {
      socket.data.lobbyId = 'lobby-saffron';
      return [];
    });

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.data.lobbyId).toBe('lobby-saffron');
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-verdant');
  });

  it('still detaches when the membership is the one the sender saw (a live draft the player is detached from)', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockResolvedValueOnce([member(new Date(JOINED_AT - 60_000))]);

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant', JOINED_AT - 60_000));

    expect(socket.data.lobbyId).toBeUndefined();
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-verdant');
  });

  it('lets the leave stand when the rejoin check cannot read the membership (Codex on #1032)', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockRejectedValue(new Error('database unavailable'));

    await applyLocalLobbySocketsLeft(io, detach('lobby-verdant'));

    expect(socket.data.lobbyId).toBeUndefined();
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-verdant');
  });

  it('lets the leave stand, unchecked, when the sender could not say which membership it detached from (Codex on #1032)', async () => {
    const { socket, io } = ownedSocket('lobby-verdant');
    listMembersWithUserMock.mockResolvedValue([member(new Date(JOINED_AT))]);

    await applyLocalLobbySocketsLeft(io, { lobbyId: 'lobby-verdant', userId: 'player-orla', socketIds: ['tab-1'] });

    expect(listMembersWithUserMock).not.toHaveBeenCalled();
    expect(socket.data.lobbyId).toBeUndefined();
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-verdant');
  });

  it('does nothing, and reads nothing, on a replica that owns none of the sockets', async () => {
    await applyLocalLobbySocketsLeft({ sockets: { sockets: new Map() } } as never, detach('lobby-verdant'));

    expect(listMembersWithUserMock).not.toHaveBeenCalled();
  });
});
