import { logger } from '../../core/logger.js';
import {
  auctionContentService,
  AuctionContentError,
  AuctionContentErrorCode,
  type AuctionContentLocale,
} from '../../modules/auction/index.js';
import {
  createInitialAuctionMatch,
  startBiddingRound,
  type AuctionEngineContext,
} from '../../modules/auction/auction-engine.js';
import { needsPosition } from '../../modules/auction/auction-rules.js';
import {
  auctionStateStore,
} from '../../modules/auction/auction-state.store.js';
import {
  toPublicAuctionMatchState,
  type PublicAuctionMatchState,
  type PublicAuctionRoundState,
} from '../../modules/auction/auction-match-state.js';
import { scheduleAuctionClueRevealTimer } from './auction-clue-timer.service.js';
import type { FormationName } from '../../modules/auction/auction.types.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  AuctionErrorPayload,
  AuctionMatchStartedPayload,
  AuctionRoundStartedPayload,
} from '../socket.types.js';

export interface AuctionStartAiMatchServiceInput {
  formation?: FormationName;
  locale: AuctionContentLocale;
}

export interface AuctionStartAiMatchOptions {
  context?: AuctionEngineContext;
}

export const auctionRealtimeService = {
  async handleStartAiMatch(
    io: QuizballServer,
    socket: QuizballSocket,
    input: AuctionStartAiMatchServiceInput,
    options: AuctionStartAiMatchOptions = {}
  ): Promise<void> {
    const user = socket.data.user;
    if (!user?.id) {
      emitAuctionError(socket, {
        code: 'AUTHENTICATION_ERROR',
        message: 'Authentication required',
      });
      return;
    }

    try {
      await auctionContentService.assertPublishedAuctionContentAvailable(input.locale);
      const initial = createInitialAuctionMatch({
        humanUserId: user.id,
        humanDisplayName: user.nickname ?? 'Player',
        formation: input.formation,
        locale: input.locale,
        context: options.context,
      });

      const firstCard = await auctionContentService.getRandomPublishedAuctionCard({
        locale: input.locale,
      });
      const needers = initial.seats.filter((seat) => needsPosition(seat, firstCard.positionGroup));
      const withRound = startBiddingRound(
        initial,
        firstCard.positionGroup,
        firstCard,
        needers,
        options.context
      );

      const saved = await auctionStateStore.save(withRound, {
        now: options.context?.now?.(),
      });
      const publicState = toPublicAuctionMatchState(saved);

      socket.data.lobbyId = undefined;
      socket.data.matchId = saved.matchId;
      socket.join(`match:${saved.matchId}`);

      const startedPayload: AuctionMatchStartedPayload = {
        matchId: saved.matchId,
        locale: input.locale,
        state: publicState,
      };
      const roundPayload = buildRoundStartedPayload(publicState);

      io.to(`match:${saved.matchId}`).emit('auction:match_started', startedPayload);
      io.to(`match:${saved.matchId}`).emit('auction:round_started', roundPayload);
      await scheduleAuctionClueRevealTimer(saved, {
        now: options.context?.now?.(),
        context: options.context,
      });

      logger.info(
        {
          matchId: saved.matchId,
          userId: user.id,
          locale: input.locale,
          formation: saved.formation,
          positionGroup: saved.currentRound?.positionGroup,
        },
        'Auction AI match started'
      );
    } catch (error) {
      const payload = toAuctionErrorPayload(error);
      emitAuctionError(socket, payload);
      logger.warn({ error, userId: user.id, code: payload.code }, 'auction:start_ai_match failed');
    }
  },
};

function buildRoundStartedPayload(publicState: PublicAuctionMatchState): AuctionRoundStartedPayload {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable');
  }

  return {
    matchId: publicState.matchId,
    round: publicState.currentRound as PublicAuctionRoundState,
    stateVersion: publicState.version,
  };
}

function emitAuctionError(socket: QuizballSocket, payload: AuctionErrorPayload): void {
  socket.emit('auction:error', payload);
}

function toAuctionErrorPayload(error: unknown): AuctionErrorPayload {
  if (error instanceof AuctionContentError) {
    return {
      code: error.auctionCode,
      message: error.message,
      meta: error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : undefined,
    };
  }

  return {
    code: AuctionContentErrorCode.CONTENT_UNAVAILABLE,
    message: error instanceof Error ? error.message : 'Auction content unavailable',
  };
}
