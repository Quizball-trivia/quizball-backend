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

    await lobbyRealtimeService.createLobby(io, socket, parsed.data);
    if (socket.data.lobbyId) {
      trackLobbyCreated(socket.data.user.id, socket.data.lobbyId, 'friendly');
    }
  });

  socket.on('lobby:join_by_code', async (payload) => {
    const parsed = lobbyJoinByCodeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:join_by_code payload');
      return;
    }

    await lobbyRealtimeService.joinByCode(io, socket, parsed.data.inviteCode);
    if (socket.data.lobbyId) {
      trackLobbyJoined(socket.data.user.id, socket.data.lobbyId, parsed.data.inviteCode);
    }
  });

  socket.on('lobby:ready', async (payload) => {
    const parsed = lobbyReadySchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:ready payload');
      return;
    }

    await lobbyRealtimeService.setReady(io, socket, parsed.data.ready);
  });

  socket.on('lobby:update_settings', async (payload) => {
    const parsed = lobbyUpdateSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:update_settings payload');
      return;
    }

    await lobbyRealtimeService.updateSettings(io, socket, parsed.data);
  });

  socket.on('lobby:start', async (payload) => {
    const parsed = lobbyStartSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:start payload');
      return;
    }

    await lobbyRealtimeService.startFriendlyMatch(io, socket, parsed.data.lobbyId);
  });

  socket.on('lobby:leave', async () => {
    await lobbyRealtimeService.leaveLobby(io, socket);
  });
}
