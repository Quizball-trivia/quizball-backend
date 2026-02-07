import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { warmupTapSchema, warmupDroppedSchema } from '../schemas/warmup.schemas.js';
import { logger } from '../../core/logger.js';
import { warmupRealtimeService } from '../services/warmup-realtime.service.js';

export function registerWarmupHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('warmup:tap', async (payload) => {
    const parsed = warmupTapSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid warmup:tap payload');
      return;
    }
    try {
      await warmupRealtimeService.handleTap(io, socket, parsed.data);
    } catch (error) {
      logger.error(
        { error, event: 'warmup:tap', payload: parsed.data },
        'Error handling warmup:tap event'
      );
      socket.emit('error', {
        code: 'WARMUP_TAP_ERROR',
        message: 'Failed to process tap event',
      });
    }
  });

  socket.on('warmup:dropped', async (payload) => {
    const parsed = warmupDroppedSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid warmup:dropped payload');
      return;
    }
    try {
      await warmupRealtimeService.handleDropped(io, socket, parsed.data);
    } catch (error) {
      logger.error(
        { error, event: 'warmup:dropped', payload: parsed.data },
        'Error handling warmup:dropped event'
      );
      socket.emit('error', {
        code: 'WARMUP_DROPPED_ERROR',
        message: 'Failed to process dropped event',
      });
    }
  });

  socket.on('warmup:restart', async () => {
    try {
      await warmupRealtimeService.handleRestart(io, socket);
    } catch (error) {
      logger.error(
        { error, event: 'warmup:restart' },
        'Error handling warmup:restart event'
      );
      socket.emit('error', {
        code: 'WARMUP_RESTART_ERROR',
        message: 'Failed to restart warmup game',
      });
    }
  });

  socket.on('warmup:get_scores', async () => {
    try {
      await warmupRealtimeService.handleGetScores(io, socket);
    } catch (error) {
      logger.error(
        { error, event: 'warmup:get_scores' },
        'Error handling warmup:get_scores event'
      );
      socket.emit('error', {
        code: 'WARMUP_GET_SCORES_ERROR',
        message: 'Failed to retrieve scores',
      });
    }
  });
}
