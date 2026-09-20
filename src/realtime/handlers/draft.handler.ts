import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { draftBanSchema, draftRejoinSchema, draftUiReadySchema } from '../schemas/draft.schemas.js';
import { logger } from '../../core/logger.js';
import { draftRealtimeService } from '../services/draft-realtime.service.js';
import { lobbyRealtimeService } from '../services/lobby-realtime.service.js';

export function registerDraftHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('draft:rejoin', async (payload) => {
    const parsed = draftRejoinSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid draft:rejoin payload');
      socket.emit('error', { code: 'INVALID_PAYLOAD', message: 'Invalid draft rejoin request' });
      return;
    }

    try {
      await lobbyRealtimeService.rejoinActiveDraftLobbyOnConnect(io, socket, {
        resume: true,
        lobbyId: parsed.data?.lobbyId,
      });
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : error,
          userId: socket.data.user?.id,
          lobbyId: parsed.data?.lobbyId,
        },
        'Error handling draft:rejoin'
      );
      socket.emit('error', { code: 'DRAFT_REJOIN_FAILED', message: 'Failed to rejoin draft' });
    }
  });

  socket.on('draft:ban', async (payload) => {
    const parsed = draftBanSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid draft:ban payload');
      socket.emit('error', { code: 'INVALID_PAYLOAD', message: 'Invalid ban request' });
      return;
    }

    try {
      await draftRealtimeService.handleBan(io, socket, parsed.data.categoryId);
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : error,
          userId: socket.data.user?.id,
          categoryId: parsed.data.categoryId,
        },
        'Error handling draft:ban'
      );
      socket.emit('error', { code: 'BAN_FAILED', message: 'Failed to process ban' });
    }
  });

  socket.on('draft:ui_ready', async (payload) => {
    const parsed = draftUiReadySchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid draft:ui_ready payload');
      socket.emit('error', { code: 'INVALID_PAYLOAD', message: 'Invalid draft UI-ready request' });
      return;
    }

    try {
      await draftRealtimeService.handleUiReady(io, socket, {
        lobbyId: parsed.data?.lobbyId,
        turnUserId: parsed.data?.turnUserId,
        banCount: parsed.data?.banCount,
      });
    } catch (error) {
      logger.error(
        {
          err: error instanceof Error ? error.message : error,
          userId: socket.data.user?.id,
          lobbyId: parsed.data?.lobbyId,
        },
        'Error handling draft:ui_ready'
      );
      socket.emit('error', { code: 'DRAFT_UI_READY_FAILED', message: 'Failed to mark draft UI ready' });
    }
  });
}
