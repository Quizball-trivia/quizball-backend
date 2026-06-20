import { logger } from '../../core/logger.js';
import { harnessDelayMs, isHarnessFastTimers } from '../../core/harness-timing.js';
import { resolveAuctionContext } from '../../modules/auction/auction-context.js';
import {
  applyBid,
  applyFold,
  applyTurnTimeout,
  type AuctionEngineContext,
} from '../../modules/auction/auction-engine.js';
import {
  findAuctionSeatByUserId,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import { needsPosition } from '../../modules/auction/auction-rules.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  AuctionBidPayload,
  AuctionFoldPayload,
  AuctionSoloPickSelectPayload,
} from '../socket.types.js';
import {
  advanceAuctionMatchFlowAfterMutation,
  handleAuctionSoloPickSelectionForUser,
} from './auction-match-flow.service.js';
import { scheduleAuctionBotActionTimer } from './auction-bot.service.js';
import {
  AuctionActionError,
  authenticationRequiredError,
  emitAuctionError,
  toAuctionErrorPayload,
} from './auction-action-errors.js';
import {
  buildBidAcceptedPayload,
  buildFoldAcceptedPayload,
  buildTurnStartedPayload,
  buildTurnTimeoutPayload,
} from './auction-realtime-payloads.js';

export type AuctionTurnTimeoutTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_turn_timeout' }>;

export interface AuctionTurnTimerOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionTurnActionOutcome =
  | { kind: 'noop'; reason: string }
  | {
    kind: 'bid_accepted';
    state: AuctionMatchState;
    seatId: string;
    amount: number;
  }
  | {
    kind: 'fold_accepted';
    state: AuctionMatchState;
    seatId: string;
  }
  | {
    kind: 'turn_timeout';
    state: AuctionMatchState;
    seatId: string;
    action: 'bid' | 'fold';
    amount?: number;
  };

export function auctionTurnTimeoutTimerKey(matchId: string, roundId: string, seatId: string): string {
  return `${matchId}:${roundId}:${seatId}`;
}

export async function scheduleAuctionTurnTimeoutTimer(
  state: AuctionMatchState,
  options: AuctionTurnTimerOptions = {}
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId || !round.turnEndsAt) return;
  const dueAt = isHarnessFastTimers()
    ? getHarnessDueAt(new Date(round.turnEndsAt), options)
    : new Date(round.turnEndsAt);

  await scheduleRealtimeTimer(
    'auction_turn_timeout',
    auctionTurnTimeoutTimerKey(state.matchId, round.roundId, round.currentTurnSeatId),
    dueAt,
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

export async function emitAndScheduleAuctionTurnStarted(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionTurnTimerOptions = {}
): Promise<void> {
  const payload = buildTurnStartedPayload(state);
  if (!payload) return;

  io.to(`match:${state.matchId}`).emit('auction:turn_started', payload);
  await scheduleAuctionTurnTimeoutTimer(state, options);
  await scheduleAuctionBotActionTimer(state, options);
}

export async function runAuctionTurnTimeoutTimer(
  io: QuizballServer,
  payload: AuctionTurnTimeoutTimerPayload,
  options: AuctionTurnTimerOptions = {}
): Promise<AuctionTurnActionOutcome> {
  const outcome = await applyAuctionTurnTimeout(payload, options);

  if (outcome.kind === 'noop') {
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId, reason: outcome.reason }, 'Auction turn timer ignored');
    return outcome;
  }
  if (outcome.kind !== 'turn_timeout') return outcome;

  io.to(`match:${outcome.state.matchId}`).emit(
    'auction:turn_timeout',
    buildTurnTimeoutPayload(outcome.state, outcome)
  );
  await emitPostTurnMutationEvents(io, outcome.state, options);
  return outcome;
}

export async function handleAuctionBid(
  io: QuizballServer,
  socket: QuizballSocket,
  input: AuctionBidPayload,
  options: AuctionTurnTimerOptions = {}
): Promise<AuctionTurnActionOutcome | null> {
  try {
    const outcome = await applyAuctionHumanAction('bid', socket, input, options);
    if (outcome.kind !== 'bid_accepted') return outcome;

    io.to(`match:${outcome.state.matchId}`).emit('auction:bid_accepted', buildBidAcceptedPayload(outcome.state, outcome));
    await emitPostTurnMutationEvents(io, outcome.state, options);
    return outcome;
  } catch (error) {
    emitAuctionError(socket, toAuctionErrorPayload(error));
    return null;
  }
}

export async function handleAuctionFold(
  io: QuizballServer,
  socket: QuizballSocket,
  input: AuctionFoldPayload,
  options: AuctionTurnTimerOptions = {}
): Promise<AuctionTurnActionOutcome | null> {
  try {
    const outcome = await applyAuctionHumanAction('fold', socket, input, options);
    if (outcome.kind !== 'fold_accepted') return outcome;

    io.to(`match:${outcome.state.matchId}`).emit('auction:fold_accepted', buildFoldAcceptedPayload(outcome.state, outcome));
    await emitPostTurnMutationEvents(io, outcome.state, options);
    return outcome;
  } catch (error) {
    emitAuctionError(socket, toAuctionErrorPayload(error));
    return null;
  }
}

export async function handleAuctionSoloPickSelect(
  io: QuizballServer,
  socket: QuizballSocket,
  input: AuctionSoloPickSelectPayload,
  options: AuctionTurnTimerOptions = {}
): Promise<AuctionMatchState | null> {
  try {
    const userId = socket.data.user?.id;
    if (!userId) {
      throw authenticationRequiredError();
    }
    if (socket.data.matchId && socket.data.matchId !== input.matchId) {
      throw new AuctionActionError('auction_match_mismatch', 'Socket is not joined to this auction match');
    }
    return await handleAuctionSoloPickSelectionForUser(
      io,
      input.matchId,
      userId,
      input.option,
      options
    );
  } catch (error) {
    emitAuctionError(socket, toAuctionErrorPayload(error));
    return null;
  }
}

async function applyAuctionHumanAction(
  kind: 'bid' | 'fold',
  socket: QuizballSocket,
  input: AuctionBidPayload | AuctionFoldPayload,
  options: AuctionTurnTimerOptions
): Promise<AuctionTurnActionOutcome> {
  const userId = socket.data.user?.id;
  if (!userId) {
    throw authenticationRequiredError();
  }
  if (socket.data.matchId && socket.data.matchId !== input.matchId) {
    throw new AuctionActionError('auction_match_mismatch', 'Socket is not joined to this auction match');
  }

  const context = resolveAuctionContext(options);
  return auctionStateStore.mutate(input.matchId, (current) => {
    const seat = validateHumanTurnAction(current, userId, kind);
    const nextState = kind === 'bid'
      ? applyBid(current, seat.seatId, (input as AuctionBidPayload).amount, context)
      : applyFold(current, seat.seatId, context);

    return saveAuctionMatchMutation(nextState, (saved) => (
      kind === 'bid'
        ? { kind: 'bid_accepted', state: saved, seatId: seat.seatId, amount: (input as AuctionBidPayload).amount }
        : { kind: 'fold_accepted', state: saved, seatId: seat.seatId }
    ));
  }, {
    now: context.now,
    onMissingState: () => {
      throw new AuctionActionError('auction_match_not_found', 'Auction match not found');
    },
  });
}

async function applyAuctionTurnTimeout(
  payload: AuctionTurnTimeoutTimerPayload,
  options: AuctionTurnTimerOptions
): Promise<AuctionTurnActionOutcome> {
  const context = resolveAuctionContext(options);
  return auctionStateStore.mutate(payload.matchId, (current) => {
    const validation = validateTimerPayload(current, payload);
    if (validation) return skipAuctionMatchMutation(noop(validation));

    const round = current.currentRound;
    if (!round?.currentTurnSeatId) return skipAuctionMatchMutation(noop('missing_turn'));

    const seatId = round.currentTurnSeatId;
    const action = round.highestBidderSeatId ? 'fold' : 'bid';
    const amount = action === 'bid' ? round.startingPrice : undefined;
    const nextState = applyTurnTimeout(current, context);

    return saveAuctionMatchMutation(nextState, (saved) => ({
      kind: 'turn_timeout',
      state: saved,
      seatId,
      action,
      amount,
    }));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

function validateHumanTurnAction(
  state: AuctionMatchState,
  userId: string,
  action: 'bid' | 'fold'
) {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round) {
    throw new AuctionActionError('auction_no_active_bidding', 'No active auction bidding turn');
  }

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat) {
    throw new AuctionActionError('auction_user_not_in_match', 'User is not seated in this auction match');
  }
  if (seat.isBot) {
    throw new AuctionActionError('auction_bot_action_forbidden', 'Bot seats cannot submit human actions');
  }
  if (round.currentTurnSeatId !== seat.seatId) {
    throw new AuctionActionError('auction_not_current_turn', 'Not this seat turn');
  }
  if (seat.isEliminated || !needsPosition(seat, round.positionGroup)) {
    throw new AuctionActionError('auction_seat_cannot_bid', 'Seat cannot bid this round');
  }
  if (round.foldedSeatIds.includes(seat.seatId)) {
    throw new AuctionActionError('auction_seat_already_folded', 'Seat already folded');
  }
  if (round.highestBidderSeatId === seat.seatId) {
    throw new AuctionActionError('auction_high_bidder_self_bid', 'Current high bidder cannot bid against themselves');
  }
  if (action === 'fold' && !round.highestBidderSeatId) {
    throw new AuctionActionError('auction_opening_bidder_cannot_fold', 'Opening bidder cannot fold');
  }
  return seat;
}

function validateTimerPayload(
  state: AuctionMatchState,
  payload: AuctionTurnTimeoutTimerPayload
): string | null {
  const round = state.currentRound;
  if (state.version !== payload.stateVersion) return 'version_mismatch';
  if (state.phase !== 'bidding') return 'phase_mismatch';
  if (!round) return 'missing_round';
  if (round.roundId !== payload.roundId) return 'round_mismatch';
  if (round.currentTurnSeatId !== payload.expectedTurnSeatId) return 'turn_mismatch';
  if (round.turnEndsAt !== payload.turnEndsAt) return 'turn_deadline_mismatch';
  return null;
}

async function emitPostTurnMutationEvents(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionTurnTimerOptions
): Promise<void> {
  if (state.phase === 'bidding' && state.currentRound?.currentTurnSeatId) {
    await emitAndScheduleAuctionTurnStarted(io, state, options);
    return;
  }

  await advanceAuctionMatchFlowAfterMutation(io, state, options);
}

function noop(reason: string): AuctionTurnActionOutcome {
  return { kind: 'noop', reason };
}

function getHarnessDueAt(turnEndsAt: Date, options: AuctionTurnTimerOptions): Date {
  const nowMs = (options.now ?? options.context?.now?.() ?? new Date()).getTime();
  const turnEndsAtMs = turnEndsAt.getTime();
  return new Date(nowMs + harnessDelayMs(Math.max(0, turnEndsAtMs - nowMs), 75));
}
