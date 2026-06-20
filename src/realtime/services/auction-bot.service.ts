import { getRandom } from '../../core/rng.js';
import {
  MIN_BID_INCREMENT,
} from '../../modules/auction/auction.constants.js';
import {
  applyBid,
  applyFold,
  type AuctionEngineContext,
} from '../../modules/auction/auction-engine.js';
import {
  toPublicAuctionMatchState,
  type AuctionMatchState,
  type PublicAuctionMatchState,
  type PublicAuctionRoundState,
} from '../../modules/auction/auction-match-state.js';
import { getEmptySlots, getMaxBid, getMinBid, needsPosition } from '../../modules/auction/auction-rules.js';
import {
  auctionStateStore,
  AuctionMatchStateNotFoundError,
} from '../../modules/auction/auction-state.store.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer } from '../socket-server.js';
import type {
  AuctionBidAcceptedPayload,
  AuctionFoldAcceptedPayload,
  AuctionMatchFinishedPayload,
  AuctionRoundRevealedPayload,
  AuctionSquadUpdatedPayload,
  AuctionTurnStartedPayload,
} from '../socket.types.js';

export const AUCTION_BOT_MIN_THINK_MS = 800;
export const AUCTION_BOT_MAX_THINK_MS = 2_800;

export type AuctionBotActionTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_bot_action' }>;

export interface AuctionBotTimerOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionBotActionOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'bot_bid'; state: AuctionMatchState; seatId: string; amount: number }
  | { kind: 'bot_fold'; state: AuctionMatchState; seatId: string };

type BotDecision =
  | { kind: 'bid'; amount: number }
  | { kind: 'fold' }
  | { kind: 'noop'; reason: string };

export function auctionBotActionTimerKey(matchId: string, roundId: string, seatId: string): string {
  return `${matchId}:${roundId}:${seatId}`;
}

export async function scheduleAuctionBotActionTimer(
  state: AuctionMatchState,
  options: AuctionBotTimerOptions = {}
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !round.turnEndsAt) return;

  const player = state.seats.find((seat) => seat.seatId === round.currentTurnSeatId);
  if (!player?.isBot) return;

  const context = resolveBotContext(options);
  const dueAt = getBotActionDueAt(context.now(), new Date(round.turnEndsAt), context.random);

  await scheduleRealtimeTimer(
    'auction_bot_action',
    auctionBotActionTimerKey(state.matchId, round.roundId, round.currentTurnSeatId),
    dueAt,
    {
      kind: 'auction_bot_action',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedTurnSeatId: round.currentTurnSeatId,
      stateVersion: state.version,
      turnEndsAt: round.turnEndsAt,
    }
  );
}

export async function runAuctionBotActionTimer(
  io: QuizballServer,
  payload: AuctionBotActionTimerPayload,
  options: AuctionBotTimerOptions = {}
): Promise<AuctionBotActionOutcome> {
  const outcome = await applyAuctionBotAction(payload, options);

  if (outcome.kind === 'noop') return outcome;

  if (outcome.kind === 'bot_bid') {
    io.to(`match:${outcome.state.matchId}`).emit('auction:bid_accepted', buildBidAcceptedPayload(outcome.state, outcome));
  } else {
    io.to(`match:${outcome.state.matchId}`).emit('auction:fold_accepted', buildFoldAcceptedPayload(outcome.state, outcome));
  }

  await emitPostBotMutationEvents(io, outcome.state, options);
  return outcome;
}

export function decideAuctionBotAction(
  state: AuctionMatchState,
  seatId: string,
  random: () => number = getRandom
): BotDecision {
  const round = state.currentRound;
  const player = state.seats.find((seat) => seat.seatId === seatId);
  if (state.phase !== 'bidding' || !round || !player?.isBot) return { kind: 'noop', reason: 'not_bot_turn' };
  if (round.currentTurnSeatId !== seatId) return { kind: 'noop', reason: 'turn_mismatch' };
  if (player.isEliminated || !needsPosition(player, round.positionGroup)) return { kind: 'noop', reason: 'bot_cannot_bid' };
  if (round.foldedSeatIds.includes(seatId)) return { kind: 'noop', reason: 'bot_already_folded' };
  if (round.highestBidderSeatId === seatId) return { kind: 'noop', reason: 'bot_is_high_bidder' };

  const emptySlots = getEmptySlots(player.team);
  const minBid = getMinBid(round.startingPrice, round.highestBid);
  const maxBid = getMaxBid(player.budget, emptySlots);
  if (maxBid < minBid) {
    return round.highestBidderSeatId ? { kind: 'fold' } : { kind: 'noop', reason: 'bot_cannot_open' };
  }

  const willingness = Math.floor(round.footballer.trueValue * (0.75 + random() * 0.55));
  if (round.highestBidderSeatId && minBid > willingness) {
    return { kind: 'fold' };
  }

  const cap = round.highestBidderSeatId ? Math.min(maxBid, willingness) : maxBid;
  let amount = minBid;
  if (random() >= 0.8) {
    amount += MIN_BID_INCREMENT * (1 + Math.floor(random() * 3));
  }
  amount = Math.min(amount, cap);
  if (amount < minBid) {
    return round.highestBidderSeatId ? { kind: 'fold' } : { kind: 'noop', reason: 'bot_bid_below_min' };
  }

  return { kind: 'bid', amount };
}

async function applyAuctionBotAction(
  payload: AuctionBotActionTimerPayload,
  options: AuctionBotTimerOptions
): Promise<AuctionBotActionOutcome> {
  return auctionStateStore.withLock(payload.matchId, async () => {
    const current = await auctionStateStore.load(payload.matchId);
    if (!current) return noop('missing_state');

    const validation = validateBotPayload(current, payload);
    if (validation) return noop(validation);

    const context = resolveBotContext(options);
    const decision = decideAuctionBotAction(current, payload.expectedTurnSeatId, context.random);
    if (decision.kind === 'noop') return noop(decision.reason);

    const nextState = decision.kind === 'bid'
      ? applyBid(current, payload.expectedTurnSeatId, decision.amount, context)
      : applyFold(current, payload.expectedTurnSeatId, context);
    const saved = await auctionStateStore.save({
      ...nextState,
      version: current.version + 1,
    }, {
      expectedVersion: current.version,
      now: context.now(),
    });

    const outcome: AuctionBotActionOutcome = decision.kind === 'bid'
      ? { kind: 'bot_bid', state: saved, seatId: payload.expectedTurnSeatId, amount: decision.amount }
      : { kind: 'bot_fold', state: saved, seatId: payload.expectedTurnSeatId };
    return outcome;
  }).catch((error) => {
    if (error instanceof AuctionMatchStateNotFoundError) return noop('missing_state');
    throw error;
  });
}

async function emitPostBotMutationEvents(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionBotTimerOptions
): Promise<void> {
  if (state.phase === 'bidding' && state.currentRound?.currentTurnSeatId) {
    await emitAndScheduleBotTurnStarted(io, state, options);
    return;
  }

  if (state.phase === 'reveal' && state.currentRound) {
    const publicState = toPublicAuctionMatchState(state);
    io.to(`match:${state.matchId}`).emit('auction:round_revealed', buildRoundRevealedPayload(publicState));
    if (state.currentRound.winnerSeatId) {
      const player = publicState.seats.find((seat) => seat.seatId === state.currentRound?.winnerSeatId);
      if (player) {
        io.to(`match:${state.matchId}`).emit('auction:squad_updated', {
          matchId: state.matchId,
          seatId: player.seatId,
          player,
          stateVersion: state.version,
        } satisfies AuctionSquadUpdatedPayload);
      }
    }
    return;
  }

  if (state.phase === 'finished' && state.rankings) {
    const publicState = toPublicAuctionMatchState(state);
    io.to(`match:${state.matchId}`).emit('auction:match_finished', {
      matchId: state.matchId,
      rankings: state.rankings,
      winnerSeatId: state.rankings[0]?.seatId ?? null,
      state: publicState,
      stateVersion: state.version,
    } satisfies AuctionMatchFinishedPayload);
  }
}

async function emitAndScheduleBotTurnStarted(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionBotTimerOptions
): Promise<void> {
  const payload = buildTurnStartedPayload(state);
  if (!payload) return;

  io.to(`match:${state.matchId}`).emit('auction:turn_started', payload);
  await scheduleAuctionTurnTimeoutTimerForBotService(state);
  await scheduleAuctionBotActionTimer(state, options);
}

async function scheduleAuctionTurnTimeoutTimerForBotService(state: AuctionMatchState): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !round.turnEndsAt) return;

  await scheduleRealtimeTimer(
    'auction_turn_timeout',
    `${state.matchId}:${round.roundId}:${round.currentTurnSeatId}`,
    new Date(round.turnEndsAt),
    {
      kind: 'auction_turn_timeout',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedTurnSeatId: round.currentTurnSeatId,
      stateVersion: state.version,
      turnEndsAt: round.turnEndsAt,
    }
  );
}

function validateBotPayload(state: AuctionMatchState, payload: AuctionBotActionTimerPayload): string | null {
  const round = state.currentRound;
  if (state.version !== payload.stateVersion) return 'version_mismatch';
  if (state.phase !== 'bidding') return 'phase_mismatch';
  if (!round) return 'missing_round';
  if (round.roundId !== payload.roundId) return 'round_mismatch';
  if (round.currentTurnSeatId !== payload.expectedTurnSeatId) return 'turn_mismatch';
  if (round.turnEndsAt !== payload.turnEndsAt) return 'turn_deadline_mismatch';
  const player = state.seats.find((seat) => seat.seatId === payload.expectedTurnSeatId);
  if (!player?.isBot) return 'not_bot_turn';
  return null;
}

function buildTurnStartedPayload(state: AuctionMatchState): AuctionTurnStartedPayload | null {
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

function buildBidAcceptedPayload(
  state: AuctionMatchState,
  outcome: Extract<AuctionBotActionOutcome, { kind: 'bot_bid' }>
): AuctionBidAcceptedPayload {
  const publicState = toPublicAuctionMatchState(state);
  const round = requirePublicRound(publicState);
  return {
    matchId: state.matchId,
    roundId: round.roundId,
    seatId: outcome.seatId,
    amount: outcome.amount,
    round,
    stateVersion: state.version,
  };
}

function buildFoldAcceptedPayload(
  state: AuctionMatchState,
  outcome: Extract<AuctionBotActionOutcome, { kind: 'bot_fold' }>
): AuctionFoldAcceptedPayload {
  const publicState = toPublicAuctionMatchState(state);
  const round = requirePublicRound(publicState);
  return {
    matchId: state.matchId,
    roundId: round.roundId,
    seatId: outcome.seatId,
    round,
    stateVersion: state.version,
  };
}

function buildRoundRevealedPayload(publicState: PublicAuctionMatchState): AuctionRoundRevealedPayload {
  const round = requirePublicRound(publicState);
  return {
    matchId: publicState.matchId,
    roundId: round.roundId,
    winnerSeatId: round.winnerSeatId,
    winningBid: round.winningBid,
    round,
    stateVersion: publicState.version,
  };
}

function requirePublicRound(publicState: PublicAuctionMatchState): PublicAuctionRoundState {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable');
  }
  return publicState.currentRound;
}

function getBotActionDueAt(now: Date, turnEndsAt: Date, random: () => number): Date {
  const delayMs = AUCTION_BOT_MIN_THINK_MS
    + Math.floor(random() * (AUCTION_BOT_MAX_THINK_MS - AUCTION_BOT_MIN_THINK_MS + 1));
  const dueAtMs = Math.min(now.getTime() + delayMs, turnEndsAt.getTime());
  return new Date(dueAtMs);
}

function resolveBotContext(options: AuctionBotTimerOptions): Required<Pick<AuctionEngineContext, 'now' | 'random'>> {
  return {
    now: options.context?.now ?? (() => options.now ?? new Date()),
    random: options.context?.random ?? getRandom,
  };
}

function noop(reason: string): AuctionBotActionOutcome {
  return { kind: 'noop', reason };
}
