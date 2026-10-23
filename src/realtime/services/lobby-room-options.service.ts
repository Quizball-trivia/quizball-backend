import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { footballGridRoomOptionsSchema } from '../../modules/football-grid/football-grid.settings.js';
import { lobbiesRepo } from '../../modules/lobbies/lobbies.repo.js';
import { currentRoomEngine } from '../../modules/room/room.registry.js';
import { isRoomGame } from '../../modules/room/room.types.js';
import { MEMBERS_NEED_RELOAD_MESSAGE, membersCanDraw, NEEDS_RELOAD_CODE, NEEDS_RELOAD_MESSAGE, roomOptionsToken } from '../client-games.js';
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
  // A word board or a turn timer needs every member's screen to draw it (an older tab would show picture art for words,
  // or no clock). The cross-replica socket lookup can take seconds, so it runs before the room lock; under the lock the
  // member list it checked must still be the room's (a join in between refuses the change).
  let checkedMembers: string | null = null;
  const token = roomOptionsToken({ room_game: 'codenames', room_options: payload.options });
  if (token) {
    if (!(socket.data.games ?? []).includes(token)) {
      socket.emit('error', { code: NEEDS_RELOAD_CODE, message: NEEDS_RELOAD_MESSAGE });
      return;
    }
    const memberIds = (await lobbiesRepo.listMembersWithUser(lobbyId)).map((m) => m.user_id).sort();
    if (!(await membersCanDraw(io, memberIds, 'codenames', token))) {
      socket.emit('error', { code: NEEDS_RELOAD_CODE, message: MEMBERS_NEED_RELOAD_MESSAGE });
      return;
    }
    checkedMembers = memberIds.join(',');
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
    if (lobby.game_mode === 'football_grid') {
      if (!config.FOOTBALL_GRID_RULES_ENABLED) {
        socket.emit('error', { code: 'INVALID_SETTINGS', message: 'This room has no game options' });
        return;
      }
      const parsed = payload.options === null ? null : footballGridRoomOptionsSchema.safeParse(payload.options);
      if (parsed && !parsed.success) {
        socket.emit('error', { code: 'INVALID_SETTINGS', message: 'These options are not offered for this game' });
        return;
      }
      const next = parsed ? (parsed.data as Record<string, unknown>) : null;
      if (JSON.stringify(next) === JSON.stringify(lobby.room_options ?? null)) return;
      if (!(await lobbiesRepo.setFootballGridOptions(lobbyId, next))) {
        socket.emit('error', { code: 'LOBBY_NOT_WAITING', message: 'Lobby settings are locked' });
        return;
      }
      logger.debug({ lobbyId, userId: socket.data.user.id }, 'Football Grid room options updated');
      await emitLobbyState(io, lobbyId);
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
    if (roomOptionsToken({ room_game: lobby.room_game, room_options: next })) {
      const members = (await lobbiesRepo.listMembersWithUser(lobbyId)).map((m) => m.user_id).sort().join(',');
      if (checkedMembers === null || members !== checkedMembers) {
        socket.emit('error', { code: 'LOBBY_SETTINGS_CHANGED', message: 'The room changed. Check it and try again.' });
        await emitLobbyState(io, lobbyId);
        return;
      }
    }
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
