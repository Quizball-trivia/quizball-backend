import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { rankedQueueJoinSchema } from '../schemas/ranked.schemas.js';
import { rankedMatchmakingService } from '../services/ranked-matchmaking.service.js';
import { rankedDebug, rankedDebugUser } from '../ranked-debug.js';

export function registerRankedHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('ranked:queue_join', async (payload) => {
    logger.debug({ userId: socket.data.user.id }, 'Received ranked:queue_join');
    rankedDebug('queue_join_received', {
      user: rankedDebugUser(socket.data.user.id),
      socket: socket.id,
      connected: socket.connected,
      searchMode:
        payload && typeof payload === 'object' && 'searchMode' in payload
          ? String((payload as { searchMode?: unknown }).searchMode ?? 'none')
          : 'none',
    });
    const parsed = rankedQueueJoinSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid ranked:queue_join payload');
      rankedDebug('queue_join_invalid_payload', {
        user: rankedDebugUser(socket.data.user.id),
        socket: socket.id,
      });
      socket.emit('error', {
        code: 'RANKED_QUEUE_INVALID_PAYLOAD',
        message: 'Invalid ranked queue payload',
      });
      return;
    }

    try {
      await rankedMatchmakingService.handleQueueJoin(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'Error in ranked:queue_join handler');
      rankedDebug('queue_join_handler_error', {
        user: rankedDebugUser(socket.data.user.id),
        socket: socket.id,
      });
      socket.emit('error', {
        code: 'RANKED_QUEUE_JOIN_ERROR',
        message: 'Failed to join ranked queue. Please try again.',
      });
    }
  });

  socket.on('ranked:queue_leave', async () => {
    try {
      rankedDebug('queue_leave_received', {
        user: rankedDebugUser(socket.data.user.id),
        socket: socket.id,
        connected: socket.connected,
      });
      await rankedMatchmakingService.handleQueueLeave(io, socket);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'Error in ranked:queue_leave handler');
      socket.emit('error', {
        code: 'RANKED_QUEUE_LEAVE_ERROR',
        message: 'Failed to leave ranked queue. Please try again.',
      });
    }
  });
}
