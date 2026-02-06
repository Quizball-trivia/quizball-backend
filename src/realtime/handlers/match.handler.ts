import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { matchAnswerSchema, matchRejoinSchema } from '../schemas/match.schemas.js';
import { logger } from '../../core/logger.js';
import { matchRealtimeService } from '../services/match-realtime.service.js';

export function registerMatchHandlers(io: QuizballServer, socket: QuizballSocket): void {
  socket.on('match:answer', async (payload) => {
    const parsed = matchAnswerSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:answer payload');
      return;
    }

    try {
      await matchRealtimeService.handleAnswer(io, socket, parsed.data);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId,
          qIndex: parsed.data.qIndex,
        },
        'Error handling match:answer'
      );
      socket.emit('error', {
        code: 'MATCH_ANSWER_ERROR',
        message: 'Failed to process answer',
      });
    }
  });

  socket.on('match:leave', async () => {
    try {
      await matchRealtimeService.handleMatchLeave(io, socket);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: socket.data.matchId,
        },
        'Error handling match:leave'
      );
      socket.emit('error', {
        code: 'MATCH_LEAVE_ERROR',
        message: 'Failed to leave match',
      });
    }
  });

  socket.on('match:rejoin', async (payload) => {
    const parsed = matchRejoinSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:rejoin payload');
      socket.emit('error', {
        code: 'INVALID_PAYLOAD',
        message: 'Invalid rejoin request',
      });
      return;
    }

    try {
      await matchRealtimeService.handleMatchRejoin(io, socket, parsed.data.matchId ?? null);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId ?? socket.data.matchId,
        },
        'Error handling match:rejoin'
      );
      socket.emit('error', {
        code: 'MATCH_REJOIN_ERROR',
        message: 'Failed to rejoin match',
      });
    }
  });
}
