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
import { openAuctionUiReadyGate } from './auction-ui-ready.service.js';
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
import {
  generateRankedAiAvatarUrl,
  generateRankedAiUsernameAvoiding,
  getAiNicknamePool,
} from '../ai-ranked.constants.js';
import { usersRepo } from '../../modules/users/users.repo.js';
import { AUCTION_SEAT_COUNT } from '../../modules/auction/auction.constants.js';

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
  avatarCustomization?: unknown | null;
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
  const botCount = Math.max(0, AUCTION_SEAT_COUNT - input.humanPlayers.length);
  const bots = await generateAuctionBotProfiles(botCount);
  // Resolve each human's real avatar so opponents render their actual avatar
  // (best-effort: a failed lookup just leaves it null → client falls back).
  const humanPlayers = await resolveHumanAvatars(input.humanPlayers);
  const initial = createInitialAuctionMatch({
    humanUserId: primary.userId,
    humanDisplayName: primary.displayName,
    humanPlayers,
    bots,
    // Formation is chosen by the SERVER (random, same for all seats) — ignore any
    // client-supplied formation so every player in the match gets the same one.
    formation: undefined,
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
  openAuctionUiReadyGate({
    io,
    state: saved,
    phase: 'round',
    dispatch: () => {
      void scheduleAuctionClueRevealTimer(saved, {
        now: options.context?.now?.(),
        context: options.context,
      });
    },
  });

  return saved;
}

/**
 * Pick distinct AI bidder profiles for the empty seats — same name pool as
 * ranked bots, so auction opponents look like real people (e.g. "lukaberidze")
 * instead of "Bot 1"/"Bot 2". Avoids names already taken by real users and
 * keeps the bots in one match distinct from each other.
 */
async function generateAuctionBotProfiles(
  count: number
): Promise<{ displayName: string; avatarUrl: string }[]> {
  if (count <= 0) return [];
  let takenLower: Set<string>;
  try {
    takenLower = await usersRepo.findTakenLowerNicknames([...getAiNicknamePool()]);
  } catch (error) {
    // Name-collision avoidance is best-effort; never block a match on it, but
    // surface the failure so a persistently broken lookup is visible.
    logger.warn({ error }, 'Auction bot nickname-collision lookup failed; using pool without avoidance');
    takenLower = new Set<string>();
  }
  const used = new Set(takenLower);
  return Array.from({ length: count }, () => {
    const displayName = generateRankedAiUsernameAvoiding(used);
    used.add(displayName.toLowerCase());
    return { displayName, avatarUrl: generateRankedAiAvatarUrl(96) };
  });
}

/**
 * Fill in each human's real avatar (avatar_customization) from the DB so the
 * other players see their actual avatar — not a random one. Best-effort: a
 * lookup failure leaves avatarCustomization null and the client falls back.
 * Skips users that already carry an avatar.
 */
async function resolveHumanAvatars(
  players: readonly AuctionMatchHumanPlayer[]
): Promise<AuctionMatchHumanPlayer[]> {
  return Promise.all(
    players.map(async (player) => {
      if (player.avatarCustomization != null) return player;
      try {
        const user = await usersRepo.getById(player.userId);
        return { ...player, avatarCustomization: user?.avatar_customization ?? null };
      } catch (error) {
        logger.warn({ error, userId: player.userId }, 'Auction: failed to load human avatar');
        return player;
      }
    })
  );
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

/**
 * Re-attach a user's (reloaded) socket to an auction match they're already in
 * and push the current state so the client re-syncs — instead of starting a new
 * match. Used by matchmaking when a fresh socket (post-reload, no socket.data.
 * matchId) re-runs search while the user is still seated in a live match.
 * Returns false if the match isn't loadable / already finished.
 */
export async function rejoinAuctionMatch(
  io: QuizballServer,
  socket: QuizballSocket,
  matchId: string,
): Promise<boolean> {
  const state = await auctionStateStore.load(matchId).catch(() => null);
  if (!state || state.phase === 'finished') return false;

  const userId = socket.data.user?.id;
  if (userId) {
    await attachUserSocketsToAuctionMatch(io, userId, matchId, socket);
  } else {
    socket.data.lobbyId = undefined;
    socket.data.matchId = matchId;
    socket.join(`match:${matchId}`);
  }

  socket.emit('auction:state', {
    matchId: state.matchId,
    state: toPublicAuctionMatchState(state),
    stateVersion: state.version,
    serverNow: new Date().toISOString(),
  });
  logger.info({ matchId, userId }, 'Auction rejoin: re-attached socket and resent state');
  return true;
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
