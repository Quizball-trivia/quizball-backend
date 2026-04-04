import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import {
  lobbyCreateSchema,
  lobbyJoinByCodeSchema,
  lobbyReadySchema,
  lobbyStartSchema,
  lobbyUpdateSettingsSchema,
} from '../schemas/lobby.schemas.js';
import { logger } from '../../core/logger.js';
import { trackLobbyCreated, trackLobbyJoined } from '../../core/analytics/game-events.js';
import { lobbyRealtimeService } from '../services/lobby-realtime.service.js';

export function registerLobbyHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('lobby:create', async (payload) => {
    const parsed = lobbyCreateSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:create payload');
      return;
    }

    try {
      await lobbyRealtimeService.createLobby(io, socket, parsed.data);
      if (socket.data.lobbyId) {
        trackLobbyCreated(socket.data.user.id, socket.data.lobbyId, 'friendly');
      }
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:create');
      socket.emit('error', { code: 'LOBBY_CREATE_ERROR', message: 'Failed to create lobby' });
    }
  });

  socket.on('lobby:join_by_code', async (payload) => {
    const parsed = lobbyJoinByCodeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:join_by_code payload');
      return;
    }

    try {
      await lobbyRealtimeService.joinByCode(io, socket, parsed.data.inviteCode);
      if (socket.data.lobbyId) {
        trackLobbyJoined(socket.data.user.id, socket.data.lobbyId, parsed.data.inviteCode);
      }
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:join_by_code');
      socket.emit('error', { code: 'LOBBY_JOIN_ERROR', message: 'Failed to join lobby' });
    }
  });

  socket.on('lobby:ready', async (payload) => {
    const parsed = lobbyReadySchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:ready payload');
      return;
    }

    try {
      await lobbyRealtimeService.setReady(io, socket, parsed.data.ready);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:ready');
      socket.emit('error', { code: 'LOBBY_READY_ERROR', message: 'Failed to update ready state' });
    }
  });

  socket.on('lobby:update_settings', async (payload) => {
    const parsed = lobbyUpdateSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:update_settings payload');
      return;
    }

    try {
      await lobbyRealtimeService.updateSettings(io, socket, parsed.data);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:update_settings');
      socket.emit('error', { code: 'LOBBY_SETTINGS_ERROR', message: 'Failed to update settings' });
    }
  });

  socket.on('lobby:start', async (payload) => {
    const parsed = lobbyStartSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:start payload');
      return;
    }

    try {
      await lobbyRealtimeService.startFriendlyMatch(io, socket, parsed.data.lobbyId);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:start');
      socket.emit('error', { code: 'LOBBY_START_ERROR', message: 'Failed to start match' });
    }
  });

  socket.on('lobby:leave', async () => {
    try {
      await lobbyRealtimeService.leaveLobby(io, socket);
    } catch (error) {
      logger.error({ err: error, userId: socket.data.user?.id }, 'Error handling lobby:leave');
      socket.emit('error', { code: 'LOBBY_LEAVE_ERROR', message: 'Failed to leave lobby' });
    }
  });
}
