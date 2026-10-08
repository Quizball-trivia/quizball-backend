import { logger } from '../../core/logger.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { currentRoomEngine } from '../../modules/room/room.registry.js';
import { isRoomGame } from '../../modules/room/room.types.js';
import { emitLobbyState } from '../lobby-utils.js';
import { releaseLock } from '../locks.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { acquireLobbyLockWithRetry, resolveLobbyId } from './lobby-lifecycle.helpers.js';

const LOCK_WAIT_MS = 3500;

/**
 * The host's choices for a room game (which clubs, how hard). The room's game validates them and stores its own
 * normalised form; a change un-readies everyone, so nobody starts a match they did not see the settings of (and a
 * start that raced the change fails its "everyone ready" check).
 */
export async function setRoomOptions(io: QuizballServer, socket: QuizballSocket, payload: { lobbyId?: string; options: Record<string, unknown> | null }): Promise<void> {
  const lobbyId = resolveLobbyId(socket, payload.lobbyId);
  if (!lobbyId) {
    socket.emit('error', { code: 'NOT_IN_LOBBY', message: 'You are not in a lobby' });
    return;
  }
  const lock = await acquireLobbyLockWithRetry(lobbyId, 3000, LOCK_WAIT_MS);
  if (!lock.acquired || !lock.token) {
    socket.emit('error', { code: 'LOBBY_SETTINGS_LOCKED', message: 'Lobby settings update is busy. Please retry.' });
    return;
  }
  try {
    const lobby = await lobbiesRepo.getById(lobbyId);
    if (!lobby) {
      socket.emit('error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby not found' });
      return;
    }
    if (socket.data.user.id !== lobby.host_user_id) {
      socket.emit('error', { code: 'NOT_HOST', message: 'Only the host can update settings' });
      return;
    }
    if (lobby.status !== 'waiting') {
      socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby settings are locked' });
      return;
    }
    if (lobby.game_mode !== 'room_game' || !isRoomGame(lobby.room_game)) {
      socket.emit('error', { code: 'INVALID_SETTINGS', message: 'This room has no game options' });
      return;
    }
    const options = currentRoomEngine(lobby.room_game).parseOptions(payload.options);
    if (options === undefined) {
      socket.emit('error', { code: 'INVALID_SETTINGS', message: 'These options are not offered for this game' });
      return;
    }
    const next = payload.options === null ? null : (options as Record<string, unknown> | null);
    if (JSON.stringify(next ?? null) === JSON.stringify(lobby.room_options ?? null)) return;
    if (!(await lobbiesRepo.setRoomOptions(lobbyId, lobby.room_game, next))) {
      socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby settings are locked' });
      return;
    }
    logger.debug({ lobbyId, roomGame: lobby.room_game, userId: socket.data.user.id }, 'Room options updated');
    await emitLobbyState(io, lobbyId);
  } finally {
    await releaseLock(`lock:lobby:${lobbyId}`, lock.token);
  }
}
