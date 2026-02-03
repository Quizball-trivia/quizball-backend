import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { matchAnswerSchema } from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';
import { matchRealtimeService } from '../services/match-realtime.service.js';

export function registerMatchHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('match:answer', async (payload) => {
    const parsed = matchAnswerSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:answer payload');
      return;
    }

    await matchRealtimeService.handleAnswer(io, socket, parsed.data);
  });
}
