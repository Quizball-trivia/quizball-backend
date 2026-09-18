import { trackAuctionMatchFound, type AuctionAnalyticsOrigin } from '../../core/analytics/game-events.js';
import type { AuctionContentLocale } from '../../modules/auction/index.js';
import type { AuctionPlayer, FormationName } from '../../modules/auction/auction.types.js';
import type { QuizballServer } from '../socket-server.js';
import type { AuctionMatchFoundPayload } from '../socket.types.js';
import type { AuctionMatchHumanPlayer } from './auction-realtime.service.js';

/**
 * The ranked-style pre-match sequence every auction entry shares: lineup
 * (bots pop in at staggered moments) → showdown → countdown. Emitted by the
 * queue, the Redis-less fallback and the guest practice table alike, so the
 * clients never jump from "searching" straight to a live round.
 */
// Lineup holds for this long after the last bot arrival before the showdown.
export const AUCTION_PREMATCH_LINEUP_MS = 2_500;
export const AUCTION_PREMATCH_SHOWDOWN_MS = 3_000;
export const AUCTION_PREMATCH_COUNTDOWN_MS = 5_000;

export function emitAuctionMatchFound(
  io: QuizballServer,
  matchId: string,
  humans: readonly AuctionMatchHumanPlayer[],
  botPlayers: AuctionMatchFoundPayload['botPlayers'],
  locale: AuctionContentLocale,
  formation: FormationName,
  origin: AuctionAnalyticsOrigin = 'queue'
): void {
  const serverNowMs = Date.now();
  // Bots pop into the lineup at staggered, randomized moments — sometimes
  // together, usually seconds apart — instead of materializing as a block.
  // The lineup stage stretches to cover the last arrival.
  const togetherRoll = Math.random();
  let previousDelayMs = 0;
  const staggeredBots = botPlayers.map((bot, index) => {
    const joinDelayMs = index === 0
      ? Math.round(Math.random() * 1_500)
      : togetherRoll < 0.25
        ? previousDelayMs
        : previousDelayMs + Math.round(1_000 + Math.random() * 4_000);
    previousDelayMs = joinDelayMs;
    return { ...bot, joinDelayMs };
  });
  const maxJoinDelayMs = staggeredBots.reduce((max, bot) => Math.max(max, bot.joinDelayMs), 0);
  const lineupEndsAtMs = serverNowMs + maxJoinDelayMs + AUCTION_PREMATCH_LINEUP_MS;
  const showdownEndsAtMs = lineupEndsAtMs + AUCTION_PREMATCH_SHOWDOWN_MS;
  const payload: AuctionMatchFoundPayload = {
    matchId,
    humanUserIds: humans.map((human) => human.userId),
    botCount: staggeredBots.length,
    botPlayers: staggeredBots,
    locale,
    formation,
    serverNow: new Date(serverNowMs).toISOString(),
    lineupEndsAt: new Date(lineupEndsAtMs).toISOString(),
    showdownEndsAt: new Date(showdownEndsAtMs).toISOString(),
    // Single server-chosen instant so all clients finish the countdown in sync.
    countdownEndsAt: new Date(showdownEndsAtMs + AUCTION_PREMATCH_COUNTDOWN_MS).toISOString(),
  };
  const foundAt = new Date(serverNowMs);
  for (const human of humans) {
    io.to(`user:${human.userId}`).emit('auction:match_found', payload);
    trackAuctionMatchFound({
      userId: human.userId,
      matchId,
      humanCount: humans.length,
      botCount: staggeredBots.length,
      locale,
      formation,
      origin,
      occurredAt: foundAt,
    });
  }
}

export function botPlayerSummaries(seats: readonly AuctionPlayer[]): AuctionMatchFoundPayload['botPlayers'] {
  return seats
    .filter((seat) => seat.isBot)
    .map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
    }));
}

