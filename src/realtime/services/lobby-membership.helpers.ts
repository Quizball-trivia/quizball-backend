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
  socketIds: string[];
  detachedAtMs: number;
}

/**
 * Clear the lobby binding on the sockets this replica owns (the replica-side
 * half of removeUserFromLobbySockets). The message can land after the player
 * re-joined the same lobby; a membership that started after the detach is a
 * new one and is left alone.
 */
export async function applyLocalLobbySocketsLeft(io: QuizballServer, payload: LobbySocketsLeftPayload): Promise<void> {
  const bound = () => payload.socketIds
    .map((socketId) => io.sockets.sockets.get(socketId))
    .filter((socket): socket is NonNullable<typeof socket> => Boolean(socket) && socket!.data.lobbyId === payload.lobbyId);
  const rejoined = async () => (await lobbiesRepo.listMembersWithUser(payload.lobbyId))
    .some((member) => member.user_id === payload.userId && Date.parse(member.joined_at) > payload.detachedAtMs);
  if (bound().length === 0 || await rejoined()) return;
  // Re-read the bindings after the await: a socket may have moved meanwhile.
  const cleared = bound();
  cleared.forEach((socket) => { socket.data.lobbyId = undefined; });
  // A re-join of this lobby that raced the membership read wins: put it back.
  if (await rejoined()) {
    cleared.forEach((socket) => { if (socket.data.lobbyId === undefined) socket.data.lobbyId = payload.lobbyId; });
    return;
  }
  await Promise.all(cleared.map((socket) => socket.leave(`lobby:${payload.lobbyId}`)));
}

export async function removeUserFromLobbySockets(io: QuizballServer, lobbyId: string, userId: string): Promise<void> {
  const detachedAtMs = Date.now();
  const sockets = (await io.in(`lobby:${lobbyId}`).fetchSockets()).filter((socket) => socket.data.user.id === userId);
  sockets.forEach((socket) => {
    socket.leave(`lobby:${lobbyId}`);
    socket.data.lobbyId = undefined;
  });
  // The room leave propagates to other replicas, but a RemoteSocket's data is
  // a snapshot: without this, a socket on another replica keeps a stale
  // lobbyId, and ranked disconnect cleanup then misreads it as parked in a
  // lobby (Codex on #1006: closing the searching tab cancelled the search).
  try {
    const socketIds = sockets.filter((socket) => !io.sockets.sockets.has(socket.id)).map((socket) => socket.id);
    if (socketIds.length > 0) io.serverSideEmit('lobby:sockets_left', { lobbyId, userId, socketIds, detachedAtMs });
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
