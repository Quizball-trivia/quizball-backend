import { logger } from '../../core/logger.js';
import { auctionStartAiMatchSchema } from '../schemas/auction.schemas.js';
import { auctionRealtimeService } from '../services/auction-realtime.service.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

export function registerAuctionHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('auction:start_ai_match', async (payload) => {
    const parsed = auctionStartAiMatchSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten(), userId: socket.data.user?.id }, 'Invalid auction:start_ai_match payload');
      socket.emit('auction:error', {
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction start payload',
        meta: parsed.error.flatten() as Record<string, unknown>,
      });
      return;
    }

    try {
      await auctionRealtimeService.handleStartAiMatch(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:start_ai_match handler failed');
      socket.emit('auction:error', {
        code: 'auction_content_unavailable',
        message: 'Failed to start auction match',
      });
    }
  });
}
