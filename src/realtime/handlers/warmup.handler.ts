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
    await warmupRealtimeService.handleTap(io, socket, parsed.data);
  });

  socket.on('warmup:dropped', async (payload) => {
    const parsed = warmupDroppedSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid warmup:dropped payload');
      return;
    }
    await warmupRealtimeService.handleDropped(io, socket, parsed.data);
  });

  socket.on('warmup:restart', async () => {
    await warmupRealtimeService.handleRestart(io, socket);
  });

  socket.on('warmup:get_scores', async () => {
    await warmupRealtimeService.handleGetScores(io, socket);
  });
}
