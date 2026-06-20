import {
  toPublicAuctionMatchState,
  type AuctionMatchState,
  type PublicAuctionMatchState,
  type PublicAuctionRoundState,
} from '../../modules/auction/auction-match-state.js';
import { getEmptySlots, getMaxBid, getMinBid } from '../../modules/auction/auction-rules.js';
import type {
  AuctionBidAcceptedPayload,
  AuctionFoldAcceptedPayload,
  AuctionTurnStartedPayload,
  AuctionTurnTimeoutPayload,
} from '../socket.types.js';

export interface AuctionBidAcceptedInput {
  seatId: string;
  amount: number;
}

export interface AuctionFoldAcceptedInput {
  seatId: string;
}

export interface AuctionTurnTimeoutInput {
  seatId: string;
  action: 'bid' | 'fold';
  amount?: number;
}

export function requirePublicRound(publicState: PublicAuctionMatchState): PublicAuctionRoundState {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable');
  }
  return publicState.currentRound;
}

export function buildTurnStartedPayload(state: AuctionMatchState): AuctionTurnStartedPayload | null {
  const publicState = toPublicAuctionMatchState(state);
  const round = state.currentRound;
  const publicRound = publicState.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !publicRound) return null;

  const player = state.seats.find((seat) => seat.seatId === round.currentTurnSeatId);
  if (!player) return null;

  return {
    matchId: state.matchId,
    roundId: round.roundId,
    currentTurnSeatId: round.currentTurnSeatId,
    minBid: getMinBid(round.startingPrice, round.highestBid),
    maxBid: getMaxBid(player.budget, getEmptySlots(player.team)),
    turnEndsAt: round.turnEndsAt,
    round: publicRound,
    stateVersion: state.version,
  };
}

export function buildBidAcceptedPayload(
  state: AuctionMatchState,
  input: AuctionBidAcceptedInput
): AuctionBidAcceptedPayload {
  const publicState = toPublicAuctionMatchState(state);
  const round = requirePublicRound(publicState);
  return {
    matchId: state.matchId,
    roundId: round.roundId,
    seatId: input.seatId,
    amount: input.amount,
    round,
    stateVersion: state.version,
  };
}

export function buildFoldAcceptedPayload(
  state: AuctionMatchState,
  input: AuctionFoldAcceptedInput
): AuctionFoldAcceptedPayload {
  const publicState = toPublicAuctionMatchState(state);
  const round = requirePublicRound(publicState);
  return {
    matchId: state.matchId,
    roundId: round.roundId,
    seatId: input.seatId,
    round,
    stateVersion: state.version,
  };
}

export function buildTurnTimeoutPayload(
  state: AuctionMatchState,
  input: AuctionTurnTimeoutInput
): AuctionTurnTimeoutPayload {
  const publicState = toPublicAuctionMatchState(state);
  const round = requirePublicRound(publicState);
  return {
    matchId: state.matchId,
    roundId: round.roundId,
    seatId: input.seatId,
    action: input.action,
    amount: input.amount,
    round,
    stateVersion: state.version,
  };
}
