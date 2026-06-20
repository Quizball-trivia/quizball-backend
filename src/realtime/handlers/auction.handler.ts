import { logger } from '../../core/logger.js';
import {
  auctionBidSchema,
  auctionFoldSchema,
  auctionSearchStartSchema,
  auctionSoloPickSelectSchema,
  auctionStartAiMatchSchema,
} from '../schemas/auction.schemas.js';
import { auctionMatchmakingService } from '../services/auction-matchmaking.service.js';
import { auctionRealtimeService } from '../services/auction-realtime.service.js';
import {
  handleAuctionBid,
  handleAuctionFold,
  handleAuctionSoloPickSelect,
} from '../services/auction-turn.service.js';
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

  socket.on('auction:bid', async (payload) => {
    const parsed = auctionBidSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten(), userId: socket.data.user?.id }, 'Invalid auction:bid payload');
      socket.emit('auction:error', {
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction bid payload',
        meta: parsed.error.flatten() as Record<string, unknown>,
      });
      return;
    }

    try {
      await handleAuctionBid(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:bid handler failed');
      socket.emit('auction:error', {
        code: 'auction_action_failed',
        message: 'Failed to submit auction bid',
      });
    }
  });

  socket.on('auction:fold', async (payload) => {
    const parsed = auctionFoldSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten(), userId: socket.data.user?.id }, 'Invalid auction:fold payload');
      socket.emit('auction:error', {
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction fold payload',
        meta: parsed.error.flatten() as Record<string, unknown>,
      });
      return;
    }

    try {
      await handleAuctionFold(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:fold handler failed');
      socket.emit('auction:error', {
        code: 'auction_action_failed',
        message: 'Failed to submit auction fold',
      });
    }
  });

  socket.on('auction:solo_pick_select', async (payload) => {
    const parsed = auctionSoloPickSelectSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten(), userId: socket.data.user?.id }, 'Invalid auction:solo_pick_select payload');
      socket.emit('auction:error', {
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction solo pick payload',
        meta: parsed.error.flatten() as Record<string, unknown>,
      });
      return;
    }

    try {
      await handleAuctionSoloPickSelect(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:solo_pick_select handler failed');
      socket.emit('auction:error', {
        code: 'auction_action_failed',
        message: 'Failed to submit auction solo pick',
      });
    }
  });

  socket.on('auction:search_start', async (payload) => {
    const parsed = auctionSearchStartSchema.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.flatten(), userId: socket.data.user?.id }, 'Invalid auction:search_start payload');
      socket.emit('auction:error', {
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction search payload',
        meta: parsed.error.flatten() as Record<string, unknown>,
      });
      return;
    }

    try {
      await auctionMatchmakingService.handleSearchStart(io, socket, parsed.data);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:search_start handler failed');
      socket.emit('auction:error', {
        code: 'auction_search_failed',
        message: 'Failed to start auction search',
      });
    }
  });

  socket.on('auction:search_cancel', async () => {
    try {
      await auctionMatchmakingService.handleSearchCancel(io, socket);
    } catch (error) {
      logger.error({ error, userId: socket.data.user?.id }, 'auction:search_cancel handler failed');
      socket.emit('auction:error', {
        code: 'auction_search_cancel_failed',
        message: 'Failed to cancel auction search',
      });
    }
  });
}
