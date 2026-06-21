import { logger } from '../../core/logger.js';
import { ErrorCode } from '../../core/errors.js';
import {
  auctionContentService,
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
} from '../../modules/auction/auction-match-state.js';
import { scheduleAuctionClueRevealTimer } from './auction-clue-timer.service.js';
import { requirePublicRound } from './auction-realtime-payloads.js';
import type { FormationName } from '../../modules/auction/auction.types.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  AuctionMatchStartedPayload,
  AuctionRoundStartedPayload,
} from '../socket.types.js';
import {
  emitAuctionError,
  toAuctionErrorPayload,
} from './auction-action-errors.js';

export interface AuctionStartAiMatchServiceInput {
  formation?: FormationName;
  locale: AuctionContentLocale;
}

export interface AuctionStartAiMatchOptions {
  context?: AuctionEngineContext;
}

export interface AuctionMatchHumanPlayer {
  userId: string;
  displayName: string;
}

export interface StartAuctionMatchForHumansInput {
  humanPlayers: readonly AuctionMatchHumanPlayer[];
  formation?: FormationName;
  locale: AuctionContentLocale;
  sourceSocket?: QuizballSocket;
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
        code: ErrorCode.AUTHENTICATION_ERROR,
        message: 'Authentication required',
      });
      return;
    }

    try {
      const saved = await startAuctionMatchForHumans(io, {
        humanPlayers: [{
          userId: user.id,
          displayName: user.nickname ?? 'Player',
        }],
        formation: input.formation,
        locale: input.locale,
        sourceSocket: socket,
      }, options);

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
      const payload = toAuctionErrorPayload(error, {
        fallbackCode: ErrorCode.AUCTION_CONTENT_UNAVAILABLE,
        fallbackMessage: 'Auction content unavailable',
      });
      emitAuctionError(socket, payload);
      logger.warn({ error, userId: user.id, code: payload.code }, 'auction:start_ai_match failed');
    }
  },
};

export async function startAuctionMatchForHumans(
  io: QuizballServer,
  input: StartAuctionMatchForHumansInput,
  options: AuctionStartAiMatchOptions = {}
) {
  if (input.humanPlayers.length < 1 || input.humanPlayers.length > 3) {
    throw new Error('Auction match requires 1 to 3 human players');
  }

  await auctionContentService.assertPublishedAuctionContentAvailable(input.locale);
  const primary = input.humanPlayers[0];
  const initial = createInitialAuctionMatch({
    humanUserId: primary.userId,
    humanDisplayName: primary.displayName,
    humanPlayers: input.humanPlayers,
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

  for (const player of input.humanPlayers) {
    await attachUserSocketsToAuctionMatch(io, player.userId, saved.matchId, input.sourceSocket);
  }

  const startedPayload: AuctionMatchStartedPayload = {
    matchId: saved.matchId,
    locale: input.locale,
    state: publicState,
    serverNow: new Date().toISOString(),
  };
  const roundPayload = buildRoundStartedPayload(publicState);

  io.to(`match:${saved.matchId}`).emit('auction:match_started', startedPayload);
  io.to(`match:${saved.matchId}`).emit('auction:round_started', roundPayload);
  await scheduleAuctionClueRevealTimer(saved, {
    now: options.context?.now?.(),
    context: options.context,
  });

  return saved;
}

async function attachUserSocketsToAuctionMatch(
  io: QuizballServer,
  userId: string,
  matchId: string,
  sourceSocket?: QuizballSocket
): Promise<void> {
  if (sourceSocket?.data.user?.id === userId) {
    sourceSocket.data.lobbyId = undefined;
    sourceSocket.data.matchId = matchId;
    sourceSocket.join(`match:${matchId}`);
    return;
  }

  await io.in(`user:${userId}`).socketsJoin(`match:${matchId}`);
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  sockets.forEach((socket) => {
    socket.data.lobbyId = undefined;
    socket.data.matchId = matchId;
  });
}

function buildRoundStartedPayload(publicState: PublicAuctionMatchState): AuctionRoundStartedPayload {
  const round = requirePublicRound(publicState);

  return {
    matchId: publicState.matchId,
    round,
    stateVersion: publicState.version,
    serverNow: new Date().toISOString(),
  };
}
