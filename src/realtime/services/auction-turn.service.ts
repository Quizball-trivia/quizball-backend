import { logger } from '../../core/logger.js';
import { harnessDelayMs, isHarnessFastTimers } from '../../core/harness-timing.js';
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
import {
  buildAuctionPausedStatePayload,
  getAuctionPause,
  pauseAuctionCurrentTurnIfDisconnected,
} from './auction-disconnect-state.service.js';
import { resolveRealtimeAuctionContext } from './auction-engine-context.js';

export type AuctionTurnTimeoutTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_turn_timeout' }>;

// Buzzer grace: network + processing latency means a bid sent before the
// displayed deadline can land just after it. Without a cutoff, timer delivery
// jitter decided how late an action could still win the lock race (and each
// accepted bid rebased turnEndsAt, stretching rounds under lag). 1.5s keeps
// buzzer-beaters honest while making rejection deterministic.
const TURN_ACTION_GRACE_MS = isHarnessFastTimers() ? 100 : 1_500;

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
  }
  // The timeout ended the round itself (priced-out opener folded → unsold):
  // there is no current round to report, only the flow advance to drive.
  | {
    kind: 'round_resolved_timeout';
    state: AuctionMatchState;
    seatId: string;
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
  const paused = await pauseAuctionCurrentTurnIfDisconnected(state);
  if (paused) {
    const round = paused.state.currentRound;
    const seat = round?.currentTurnSeatId
      ? paused.state.seats.find((entry) => entry.seatId === round.currentTurnSeatId)
      : null;
    if (seat?.userId && round?.currentTurnSeatId) {
      const statePayload = buildAuctionPausedStatePayload(paused);
      io.to(`match:${paused.state.matchId}`).emit('auction:paused', {
        matchId: paused.state.matchId,
        seatId: round.currentTurnSeatId,
        userId: seat.userId,
        pauseUntil: paused.pauseUntil,
        graceMs: paused.graceMs,
        remainingReconnects: paused.remainingReconnects,
        reason: 'disconnect',
        state: statePayload.state,
        stateVersion: paused.state.version,
        serverNow: statePayload.serverNow,
      });
      io.to(`match:${paused.state.matchId}`).emit('auction:state', statePayload);
      await scheduleAuctionTurnTimeoutTimer(paused.state, options);
    }
    return;
  }

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
  const pause = await getAuctionPause(payload.matchId);
  if (pause?.seatId === payload.expectedTurnSeatId) {
    const pauseUntilMs = Date.parse(pause.pauseUntil);
    const dueAt = new Date(
      Math.max(Number.isFinite(pauseUntilMs) ? pauseUntilMs : 0, Date.now())
      + harnessDelayMs(2_000, 25)
    );
    await scheduleRealtimeTimer(
      'auction_turn_timeout',
      auctionTurnTimeoutTimerKey(payload.matchId, payload.roundId, payload.expectedTurnSeatId),
      dueAt,
      payload
    );
    return noop('paused');
  }
  const outcome = await applyAuctionTurnTimeout(payload, options);

  if (outcome.kind === 'noop') {
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId, reason: outcome.reason }, 'Auction turn timer ignored');
    return outcome;
  }
  if (outcome.kind !== 'turn_timeout' && outcome.kind !== 'round_resolved_timeout') return outcome;

  if (outcome.kind === 'turn_timeout') {
    io.to(`match:${outcome.state.matchId}`).emit(
      'auction:turn_timeout',
      buildTurnTimeoutPayload(outcome.state, outcome)
    );
  }
  // A round-resolving timeout has no current round to broadcast — the
  // post-mutation flow (next step / finish) is the only thing to drive.
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

  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(input.matchId, (current) => {
    const seat = validateHumanTurnAction(current, userId, kind, context.now());
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
  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(payload.matchId, (current) => {
    const validation = validateTimerPayload(current, payload);
    if (validation) return skipAuctionMatchMutation(noop(validation));

    const round = current.currentRound;
    if (!round?.currentTurnSeatId) return skipAuctionMatchMutation(noop('missing_turn'));

    const seatId = round.currentTurnSeatId;
    const nextState = applyTurnTimeout(current, context);
    // Derive what happened from the RESULTING state: a priced-out opener is
    // folded (and the lot may go unsold) instead of force-bidding the opening
    // price, so "no leader before" no longer implies "opened at startingPrice".
    const foldedThisTurn = Boolean(
      nextState.currentRound
      && nextState.currentRound.foldedSeatIds.length > round.foldedSeatIds.length
    );
    const resolvedRound = !nextState.currentRound || nextState.phase !== 'bidding';

    return saveAuctionMatchMutation(nextState, (saved) => {
      if (resolvedRound) {
        return { kind: 'round_resolved_timeout', state: saved, seatId };
      }
      return {
        kind: 'turn_timeout',
        state: saved,
        seatId,
        action: foldedThisTurn ? 'fold' : 'bid',
        amount: foldedThisTurn ? undefined : round.startingPrice,
      };
    });
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

function validateHumanTurnAction(
  state: AuctionMatchState,
  userId: string,
  action: 'bid' | 'fold',
  now: Date
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
  if (round.turnEndsAt !== null && now.getTime() > Date.parse(round.turnEndsAt) + TURN_ACTION_GRACE_MS) {
    throw new AuctionActionError('auction_turn_expired', 'Turn deadline already passed');
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
