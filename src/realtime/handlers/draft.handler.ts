import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { draftBanSchema } from '../schemas/draft.schemas.js';
import { logger } from '../../core/logger.js';
import { draftRealtimeService } from '../services/draft-realtime.service.js';

export function registerDraftHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('draft:ban', async (payload) => {
    const parsed = draftBanSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid draft:ban payload');
      return;
    }

    await draftRealtimeService.handleBan(io, socket, parsed.data.categoryId);
  });
}
