import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { rankedQueueJoinSchema } from '../schemas/ranked.schemas.js';
import { rankedMatchmakingService } from '../services/ranked-matchmaking.service.js';

export function registerRankedHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('ranked:queue_join', async (payload) => {
    const parsed = rankedQueueJoinSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid ranked:queue_join payload');
      socket.emit('error', {
        code: 'RANKED_QUEUE_INVALID_PAYLOAD',
        message: 'Invalid ranked queue payload',
      });
      return;
    }

    await rankedMatchmakingService.handleQueueJoin(io, socket, parsed.data);
  });

  socket.on('ranked:queue_leave', async () => {
    await rankedMatchmakingService.handleQueueLeave(socket);
  });
}
