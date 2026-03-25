import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { trackRankedQueueJoined } from '../../core/analytics/game-events.js';
import { rankedQueueJoinSchema } from '../schemas/ranked.schemas.js';
import { rankedMatchmakingService } from '../services/ranked-matchmaking.service.js';

export function registerRankedHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('ranked:queue_join', async (payload) => {
    logger.info({ userId: socket.data.user.id }, 'Received ranked:queue_join');
    const parsed = rankedQueueJoinSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid ranked:queue_join payload');
      socket.emit('error', {
        code: 'RANKED_QUEUE_INVALID_PAYLOAD',
        message: 'Invalid ranked queue payload',
      });
      return;
    }

    try {
      await rankedMatchmakingService.handleQueueJoin(io, socket, parsed.data);
      trackRankedQueueJoined(socket.data.user.id, 0);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'Error in ranked:queue_join handler');
      socket.emit('error', {
        code: 'RANKED_QUEUE_JOIN_ERROR',
        message: 'Failed to join ranked queue. Please try again.',
      });
    }
  });

  socket.on('ranked:queue_leave', async () => {
    try {
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
