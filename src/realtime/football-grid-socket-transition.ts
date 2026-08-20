import { logger } from '../core/logger.js';
import type { QuizballServer } from './socket-server.js';

export interface FootballGridSocketTransitionPayload {
  socketId: string;
  matchId: string;
  clearLobby: boolean;
}

/**
 * Mutate only a socket physically owned by this replica. Socket.IO
 * RemoteSocket objects are transport proxies: room operations propagate, but
 * assigning to their data object does not update the owning process.
 */
export async function applyLocalFootballGridSocketTransition(
  io: QuizballServer,
  payload: FootballGridSocketTransitionPayload,
): Promise<boolean> {
  const socket = io.sockets.sockets.get(payload.socketId);
  if (!socket) return false;

  const previousLobbyId = payload.clearLobby ? socket.data.lobbyId : undefined;
  if (payload.clearLobby) socket.data.lobbyId = undefined;
  socket.data.matchId = payload.matchId;
  socket.data.gridMatchId = payload.matchId;

  if (previousLobbyId) await socket.leave(`lobby:${previousLobbyId}`);
  await socket.join(`grid:${payload.matchId}`);
  return true;
}

export async function transitionFootballGridSocket(
  io: QuizballServer,
  payload: FootballGridSocketTransitionPayload,
): Promise<void> {
  if (await applyLocalFootballGridSocketTransition(io, payload)) return;
  io.serverSideEmit('grid:socket_transition', payload);
}

export function handleFootballGridSocketTransition(
  io: QuizballServer,
  payload: FootballGridSocketTransitionPayload,
): void {
  void applyLocalFootballGridSocketTransition(io, payload).catch((error) => {
    logger.warn(
      { error, socketId: payload.socketId, matchId: payload.matchId },
      'Football Grid socket transition failed on owning replica',
    );
  });
}
