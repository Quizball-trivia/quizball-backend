import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { lobbyCreateSchema, lobbyJoinByCodeSchema, lobbyReadySchema } from '../schemas/lobby.schemas.js';
import { logger } from '../../core/logger.js';
import { lobbyRealtimeService } from '../services/lobby-realtime.service.js';

export function registerLobbyHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('lobby:create', async (payload) => {
    const parsed = lobbyCreateSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:create payload');
      return;
    }

    await lobbyRealtimeService.createLobby(io, socket, parsed.data.mode);
  });

  socket.on('lobby:join_by_code', async (payload) => {
    const parsed = lobbyJoinByCodeSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:join_by_code payload');
      return;
    }

    await lobbyRealtimeService.joinByCode(io, socket, parsed.data.inviteCode);
  });

  socket.on('lobby:ready', async (payload) => {
    const parsed = lobbyReadySchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid lobby:ready payload');
      return;
    }

    await lobbyRealtimeService.setReady(io, socket, parsed.data.ready);
  });

  socket.on('lobby:leave', async () => {
    await lobbyRealtimeService.leaveLobby(io, socket);
  });
}
