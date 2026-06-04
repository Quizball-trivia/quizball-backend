import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { devSkipToSchema, devMatchIdSchema, devQuickMatchSchema } from '../schemas/dev.schemas.js';
import { devRealtimeService } from '../services/dev-realtime.service.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';

export function registerDevHandlers(io: QuizballServer, socket: QuizballSocket): void {
  if (config.NODE_ENV === 'prod') return;

  socket.on('dev:quick_match', async (payload) => {
    // Payload is optional for back-compat: `dev:quick_match` with no args still
    // starts a normal quick match; `{ skipTo }` boots straight into that phase.
    // But a payload that IS present and malformed is a caller bug — reject it
    // explicitly rather than silently falling back to a plain quick match.
    const parsed = devQuickMatchSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid dev:quick_match payload');
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid dev:quick_match payload', meta: parsed.error.flatten() as Record<string, unknown> });
      return;
    }
    const skipTo = parsed.data.skipTo;
    try {
      await devRealtimeService.handleQuickMatch(io, socket, { skipTo });
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

  socket.on('dev:pause_match', async (payload) => {
    const parsed = devMatchIdSchema.safeParse(payload);
    if (!parsed.success) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid dev:pause_match payload' });
      return;
    }
    try {
      await devRealtimeService.handlePauseMatch(parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'dev:pause_match failed');
      socket.emit('error', { code: 'DEV_ERROR', message: 'Pause failed' });
    }
  });

  socket.on('dev:resume_match', async (payload) => {
    const parsed = devMatchIdSchema.safeParse(payload);
    if (!parsed.success) {
      socket.emit('error', { code: 'VALIDATION_ERROR', message: 'Invalid dev:resume_match payload' });
      return;
    }
    try {
      await devRealtimeService.handleResumeMatch(io, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user.id }, 'dev:resume_match failed');
      socket.emit('error', { code: 'DEV_ERROR', message: 'Resume failed' });
    }
  });
}
