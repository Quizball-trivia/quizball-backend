import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { devSkipToSchema } from '../schemas/dev.schemas.js';
import { devRealtimeService } from '../services/dev-realtime.service.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

export function registerDevHandlers(io: QuizballServer, socket: QuizballSocket): void {
  if (config.NODE_ENV === 'prod') return;

  socket.on('dev:quick_match', async () => {
    try {
      await devRealtimeService.handleQuickMatch(io, socket);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'dev:quick_match failed');
      socket.emit('error', { code: 'DEV_ERROR', message: 'Quick match failed' });
    }
  });

  socket.on('dev:skip_to', async (payload) => {
    const parsed = devSkipToSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid dev:skip_to payload');
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid dev:skip_to payload', meta: parsed.error.flatten() as Record<string, unknown> });
      return;
    }

    try {
      await devRealtimeService.handleSkipTo(io, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'dev:skip_to failed');
      socket.emit('error', { code: 'DEV_ERROR', message: 'Skip failed' });
    }
  });
}
