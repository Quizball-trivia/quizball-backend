import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import {
  matchAnswerSchema,
  matchTacticSelectSchema,
  matchFinalResultsAckSchema,
  matchForfeitSchema,
  matchLeaveSchema,
  matchRejoinSchema,
} from '../schemas/match.schemas.js';
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

  socket.on('match:tactic_select', async (payload) => {
    const parsed = matchTacticSelectSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:tactic_select payload');
      return;
    }

    try {
      await matchRealtimeService.handleTacticSelect(io, socket, parsed.data);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId,
          tactic: parsed.data.tactic,
        },
        'Error handling match:tactic_select'
      );
      socket.emit('error', {
        code: 'MATCH_TACTIC_ERROR',
        message: 'Failed to apply tactic selection',
      });
    }
  });

  socket.on('match:leave', async (payload) => {
    const parsed = matchLeaveSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:leave payload');
      socket.emit('error', {
        code: 'INVALID_PAYLOAD',
        message: 'Invalid leave request',
      });
      return;
    }

    try {
      await matchRealtimeService.handleMatchLeave(io, socket, parsed.data.matchId ?? null);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId ?? socket.data.matchId,
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

  socket.on('match:forfeit', async (payload) => {
    const parsed = matchForfeitSchema.safeParse(payload ?? {});
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:forfeit payload');
      socket.emit('error', {
        code: 'INVALID_PAYLOAD',
        message: 'Invalid forfeit request',
      });
      return;
    }

    try {
      await matchRealtimeService.handleMatchForfeit(io, socket, parsed.data.matchId ?? null);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId ?? socket.data.matchId,
        },
        'Error handling match:forfeit'
      );
      socket.emit('error', {
        code: 'MATCH_FORFEIT_ERROR',
        message: 'Failed to forfeit match',
      });
    }
  });

  socket.on('match:final_results_ack', async (payload) => {
    const parsed = matchFinalResultsAckSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten() }, 'Invalid match:final_results_ack payload');
      return;
    }

    try {
      await matchRealtimeService.handleFinalResultsAck(socket, parsed.data);
    } catch (error) {
      logger.error(
        {
          err: error,
          userId: socket.data.user?.id,
          matchId: parsed.data.matchId,
          resultVersion: parsed.data.resultVersion,
        },
        'Error handling match:final_results_ack'
      );
      socket.emit('error', {
        code: 'MATCH_FINAL_RESULTS_ACK_ERROR',
        message: 'Failed to acknowledge match final results',
        meta: {
          matchId: parsed.data.matchId,
          resultVersion: parsed.data.resultVersion,
        },
      });
    }
  });
}
