import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { logger } from '../../core/logger.js';
import type { QuizballServer } from '../socket-server.js';

export async function transferHostIfNeeded(lobbyId: string, previousHostId: string): Promise<void> {
  const members = await lobbiesRepo.listMembersWithUser(lobbyId);
  if (members.length === 0) return;
  const nextHostId = members[0]?.user_id;
  if (nextHostId && nextHostId !== previousHostId) {
    await lobbiesRepo.setHostUser(lobbyId, nextHostId);
  }
}

export interface LobbySocketsLeftPayload {
  lobbyId: string;
  userId: string;
  /** Sockets the sender found in the lobby room but does not own. */
  socketIds: string[];
  /**
   * joined_at (ms) of the membership the sender saw as it detached, null when
   * there was none. Both sides read it from the database, so a rejoin is a
   * membership whose joined_at differs: no app clock is compared with the
   * database clock, and a rejoin in the same millisecond still differs.
   * Absent (never undefined-valued, which the wire would turn into null) when
   * the sender could not read it, and from replicas that predate this field:
   * the identity is then unknown and the leave stands.
   */
  membershipJoinedAtMs?: number | null;
}

// postgres.js hands timestamptz back as a Date although the row types say
// string. Date.parse() would stringify a Date and drop its milliseconds.
function joinedAtMs(value: string | Date): number {
  return new Date(value).getTime();
}

async function readMembershipJoinedAtMs(lobbyId: string, userId: string): Promise<number | null> {
  const member = (await lobbiesRepo.listMembersWithUser(lobbyId)).find((row) => row.user_id === userId);
  return member ? joinedAtMs(member.joined_at) : null;
}

/**
 * Detach the sockets this replica owns from a lobby the player left (the
 * replica-side half of removeUserFromLobbySockets, which leaves the room to
 * this function so the binding and the room move together). The message can
 * land after the player re-joined the lobby; a membership other than the one
 * the sender saw is a new one, and its binding and room are left alone.
 */
export async function applyLocalLobbySocketsLeft(io: QuizballServer, payload: LobbySocketsLeftPayload): Promise<void> {
  const room = `lobby:${payload.lobbyId}`;
  const owned = () => payload.socketIds
    .map((socketId) => io.sockets.sockets.get(socketId))
    .filter((socket): socket is NonNullable<typeof socket> => Boolean(socket));
  // A leave that cannot be checked stands: a socket left bound to, and in the
  // room of, a lobby its player is not in misleads ranked disconnect cleanup,
  // while losing a rejoin to a failing database is the rarer harm.
  const rejoined = async () => {
    if (payload.membershipJoinedAtMs === undefined) return false;
    try {
      return (await lobbiesRepo.listMembersWithUser(payload.lobbyId))
        .some((member) => member.user_id === payload.userId && joinedAtMs(member.joined_at) !== payload.membershipJoinedAtMs);
    } catch (error) {
      logger.warn({ error, lobbyId: payload.lobbyId }, 'Lobby rejoin check failed; the leave stands');
      return false;
    }
  };
  if (owned().length === 0 || await rejoined()) return;
  // Re-read the sockets after the await: one may have moved or gone meanwhile.
  const sockets = owned();
  const cleared = sockets.filter((socket) => socket.data.lobbyId === payload.lobbyId);
  cleared.forEach((socket) => { socket.data.lobbyId = undefined; });
  // A re-join of this lobby that raced the membership read wins: put it back.
  if (await rejoined()) {
    cleared.forEach((socket) => { if (socket.data.lobbyId === undefined) socket.data.lobbyId = payload.lobbyId; });
    return;
  }
  // Checked synchronously as the leaves are issued: a socket re-bound to this
  // lobby while the read was in flight keeps the room it just joined. One bound
  // elsewhere still leaves this room (its binding is not ours to touch).
  await Promise.all(sockets
    .filter((socket) => socket.data.lobbyId !== payload.lobbyId)
    .map((socket) => socket.leave(room)));
}

export async function removeUserFromLobbySockets(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  // Read the membership the player is detaching from before the slow
  // fetchSockets round trip, so a rejoin that lands during it reads as a new
  // membership. Only awaited when another replica owns a socket to detach.
  const membershipJoinedAtMs = readMembershipJoinedAtMs(lobbyId, userId);
  membershipJoinedAtMs.catch(() => undefined);
  const sockets = (await io.in(`lobby:${lobbyId}`).fetchSockets()).filter((socket) => socket.data.user.id === userId);
  const remote = sockets.filter((socket) => !io.sockets.sockets.has(socket.id));
  sockets.filter((socket) => !remote.includes(socket)).forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
  // A RemoteSocket's data is a snapshot and its leave() is unconditional, so a
  // socket on another replica cannot be detached from here: it may have
  // re-joined this lobby since the snapshot. The owning replica clears its
  // binding and leaves the room together, unless the player rejoined (Codex on
  // #1006: a stale lobbyId made ranked disconnect cleanup cancel a live search).
  try {
    if (remote.length > 0) {
      const payload: LobbySocketsLeftPayload = { lobbyId, userId, socketIds: remote.map((socket) => socket.id) };
      try {
        payload.membershipJoinedAtMs = await membershipJoinedAtMs;
      } catch (error) {
        logger.warn({ error, lobbyId, userId }, 'Failed to read the membership being detached; the leave stands unchecked');
      }
      io.serverSideEmit('lobby:sockets_left', payload);
    }
  } catch (error) {
    logger.warn({ error, lobbyId, userId }, 'Failed to forward lobby leave to the owning replica');
  }
}

export async function emitClosedLobbyStateForMode(
  io: QuizballServer,
  lobbyId: string,
  mode: 'friendly' | 'ranked'
): Promise<void> {
  io.to(`lobby:${lobbyId}`).emit('lobby:state', {
    lobbyId,
    mode,
    status: 'closed',
    inviteCode: null,
    displayName: 'Lobby closed',
    isPublic: false,
    hostUserId: '',
    settings: {
      gameMode: mode === 'ranked' ? 'ranked_sim' : 'friendly_possession',
      duelGame: null,
      roomGame: null,
      friendlyRandom: true,
      friendlyCategoryAId: null,
      friendlyCategoryBId: null,
    },
    members: [],
  });
}
