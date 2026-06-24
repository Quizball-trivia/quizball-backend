import { logger } from '../../core/logger.js';
import { resolveAuctionContext, type AuctionEngineContext } from '../../modules/auction/auction-context.js';
import { advanceTurnOrResolveRound, finishMatch } from '../../modules/auction/auction-engine.js';
import {
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import { canPlayerContinue } from '../../modules/auction/auction-rules.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  AuctionOpponentDisconnectedPayload,
  AuctionPausedPayload,
  AuctionPlayerForfeitedPayload,
  AuctionResumePayload,
} from '../socket.types.js';
import { advanceAuctionMatchFlowAfterMutation } from './auction-match-flow.service.js';
import { buildAuctionPausedStatePayload } from './auction-disconnect-state.service.js';
import {
  clearAuctionPause,
  clearAuctionUserDisconnected,
  getAuctionDisconnectGraceMs,
  getAuctionDisconnectedUser,
  getAuctionPause,
  hasReplacementAuctionMatchSocket,
  incrementAuctionDisconnectCount,
  markAuctionUserDisconnected,
  MAX_AUCTION_DISCONNECTS,
  pauseAuctionCurrentTurnForDisconnectedSeat,
  toRemainingAuctionReconnects,
} from './auction-disconnect-state.service.js';
import { emitAndScheduleAuctionTurnStarted, scheduleAuctionTurnTimeoutTimer } from './auction-turn.service.js';

export type AuctionDisconnectGraceTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_disconnect_grace' }>;

export interface AuctionDisconnectOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionDisconnectExpiryOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'forfeited'; state: AuctionMatchState; userId: string; seatId: string; reason: 'disconnect_timeout' | 'reconnect_limit' };

export function auctionDisconnectGraceTimerKey(matchId: string, userId: string): string {
  return `${matchId}:${userId}`;
}

export async function handleAuctionSocketDisconnect(
  io: QuizballServer,
  socket: QuizballSocket,
  options: AuctionDisconnectOptions = {}
): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  const boundMatchId = socket.data.matchId;
  const matchId = boundMatchId ?? await auctionStateStore.getActiveMatchIdForUser(userId);
  if (!matchId) return;

  const state = await auctionStateStore.load(matchId);
  if (!state || state.phase === 'finished') return;

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) return;

  const hasReplacement = await hasReplacementAuctionMatchSocket({
    io,
    matchId,
    userId,
    ignoreSocketId: socket.id,
  });
  if (hasReplacement) return;

  const disconnectCount = await incrementAuctionDisconnectCount(matchId, userId);
  const graceMs = getAuctionDisconnectGraceMs();
  const pauseUntil = new Date(Date.now() + graceMs).toISOString();
  await markAuctionUserDisconnected({
    matchId,
    userId,
    seatId: seat.seatId,
    pauseUntil,
    disconnectCount,
  });

  const reason = disconnectCount > MAX_AUCTION_DISCONNECTS ? 'reconnect_limit' : 'disconnect';
  const remainingReconnects = toRemainingAuctionReconnects(disconnectCount);
  const opponentPayload = buildOpponentDisconnectedPayload({
    matchId,
    userId,
    seatId: seat.seatId,
    pauseUntil,
    graceMs,
    remainingReconnects,
    reason,
  });
  io.to(`match:${matchId}`).emit('auction:opponent_disconnected', opponentPayload);

  if (disconnectCount > MAX_AUCTION_DISCONNECTS) {
    await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId,
      userId,
      seatId: seat.seatId,
      disconnectCount,
    }, options, 'reconnect_limit');
    return;
  }

  await scheduleAuctionDisconnectGraceTimer(matchId, userId, seat.seatId, disconnectCount, pauseUntil);

  const paused = await pauseAuctionCurrentTurnForDisconnectedSeat(state, {
    matchId,
    userId,
    seatId: seat.seatId,
    pauseUntil,
    disconnectCount,
  });
  if (paused) {
    emitAuctionPaused(io, paused.state, {
      userId,
      seatId: seat.seatId,
      pauseUntil: paused.pauseUntil,
      graceMs: paused.graceMs,
      remainingReconnects: paused.remainingReconnects,
      reason,
    });
    io.to(`match:${matchId}`).emit('auction:state', buildAuctionPausedStatePayload(paused));
    await scheduleAuctionTurnTimeoutTimer(paused.state, options);
  }

  logger.info(
    { matchId, userId, seatId: seat.seatId, disconnectCount, remainingReconnects },
    'Auction human disconnected; grace armed'
  );
}

export async function resumeAuctionUserIfDisconnected(
  io: QuizballServer,
  socket: QuizballSocket,
  state: AuctionMatchState
): Promise<boolean> {
  const userId = socket.data.user?.id;
  if (!userId) return false;

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) return false;

  const disconnected = await getAuctionDisconnectedUser(state.matchId, userId);
  if (!disconnected) return false;

  await clearAuctionUserDisconnected(state.matchId, userId);
  const pause = await getAuctionPause(state.matchId);
  if (pause?.userId === userId) {
    await clearAuctionPause(state.matchId);
  }

  const freshState = await auctionStateStore.load(state.matchId) ?? state;
  const payload: AuctionResumePayload = {
    matchId: freshState.matchId,
    seatId: seat.seatId,
    userId,
    reason: 'reconnected',
    state: toPublicAuctionMatchState(freshState),
    stateVersion: freshState.version,
    serverNow: new Date().toISOString(),
  };
  io.to(`match:${state.matchId}`).emit('auction:resume', payload);
  socket.emit('auction:state', {
    matchId: freshState.matchId,
    state: payload.state,
    stateVersion: freshState.version,
    serverNow: payload.serverNow,
  });
  logger.info({ matchId: state.matchId, userId, seatId: seat.seatId }, 'Auction user reconnected during grace');
  return true;
}

export async function emitPausedAuctionTurnIfNeeded(
  io: QuizballServer,
  state: AuctionMatchState,
  options: AuctionDisconnectOptions = {}
): Promise<boolean> {
  const round = state.currentRound;
  if (state.phase !== 'bidding' || !round?.currentTurnSeatId) return false;
  const pause = await getAuctionPause(state.matchId);
  const disconnected = pause?.seatId === round.currentTurnSeatId
    ? pause
    : null;
  if (!disconnected) return false;

  const paused = await pauseAuctionCurrentTurnForDisconnectedSeat(state, disconnected);
  const pausedState = paused?.state ?? state;
  const pauseUntil = paused?.pauseUntil ?? disconnected.pauseUntil;
  const pauseUntilMs = Date.parse(pauseUntil);
  const graceMs = Number.isFinite(pauseUntilMs) ? Math.max(0, pauseUntilMs - Date.now()) : getAuctionDisconnectGraceMs();
  emitAuctionPaused(io, pausedState, {
    userId: disconnected.userId,
    seatId: disconnected.seatId,
    pauseUntil,
    graceMs,
    remainingReconnects: toRemainingAuctionReconnects(disconnected.disconnectCount),
    reason: 'disconnect',
  });
  if (paused) {
    io.to(`match:${state.matchId}`).emit('auction:state', buildAuctionPausedStatePayload(paused));
    await scheduleAuctionTurnTimeoutTimer(paused.state, options);
  }
  return true;
}

export async function runAuctionDisconnectGraceTimer(
  io: QuizballServer,
  payload: AuctionDisconnectGraceTimerPayload,
  options: AuctionDisconnectOptions = {},
  reason: 'disconnect_timeout' | 'reconnect_limit' = 'disconnect_timeout'
): Promise<AuctionDisconnectExpiryOutcome> {
  const disconnected = await getAuctionDisconnectedUser(payload.matchId, payload.userId);
  if (!disconnected) return noop('already_reconnected');
  if (disconnected.seatId !== payload.seatId) return noop('seat_mismatch');
  if (disconnected.disconnectCount !== payload.disconnectCount && reason !== 'reconnect_limit') {
    return noop('disconnect_count_mismatch');
  }

  const outcome = await forfeitAuctionSeatForDisconnect(payload.matchId, payload.userId, payload.seatId, reason, options);
  if (outcome.kind === 'noop') return outcome;

  await Promise.all([
    clearAuctionUserDisconnected(payload.matchId, payload.userId),
    clearAuctionPause(payload.matchId),
  ]);

  const forfeitPayload = buildPlayerForfeitedPayload(outcome.state, {
    userId: payload.userId,
    seatId: payload.seatId,
    reason,
  });
  io.to(`match:${payload.matchId}`).emit('auction:player_forfeited', forfeitPayload);

  if (outcome.state.phase === 'bidding' && outcome.state.currentRound?.currentTurnSeatId) {
    await emitAndScheduleAuctionTurnStarted(io, outcome.state, options);
  } else {
    await advanceAuctionMatchFlowAfterMutation(io, outcome.state, options);
  }

  logger.info(
    { matchId: payload.matchId, userId: payload.userId, seatId: payload.seatId, reason },
    'Auction disconnect grace expired; seat forfeited'
  );
  return outcome;
}

/**
 * Explicit, immediate forfeit (the "Leave / Forfeit" modal) — unlike a network
 * disconnect, there is no grace wait. The leaving seat is resolved right away
 * (the same path the grace timer uses): the match CONTINUES for the others, or
 * finishes if no one can continue. The leaver's socket is detached from the
 * match so they aren't blocked from searching again.
 */
export async function handleAuctionForfeit(
  io: QuizballServer,
  socket: QuizballSocket,
  options: AuctionDisconnectOptions = {}
): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  const matchId = socket.data.matchId ?? (await auctionStateStore.getActiveMatchIdForUser(userId));
  if (!matchId) return;

  const state = await auctionStateStore.load(matchId);
  if (!state || state.phase === 'finished') {
    // Nothing live to forfeit — just detach so the next search isn't blocked.
    await detachAuctionForfeiter(socket, userId, matchId);
    return;
  }

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) {
    await detachAuctionForfeiter(socket, userId, matchId);
    return;
  }

  // Resolve the seat immediately, reusing the grace-expiry path (skips the wait).
  await markAuctionUserDisconnected({
    matchId,
    userId,
    seatId: seat.seatId,
    pauseUntil: new Date(Date.now()).toISOString(),
    disconnectCount: await incrementAuctionDisconnectCount(matchId, userId),
  });
  await runAuctionDisconnectGraceTimer(
    io,
    { kind: 'auction_disconnect_grace', matchId, userId, seatId: seat.seatId, disconnectCount: 0 },
    options,
    'reconnect_limit'
  );

  await detachAuctionForfeiter(socket, userId, matchId);
}

/** Detach a forfeiting socket from the match so search isn't blocked. */
async function detachAuctionForfeiter(
  socket: QuizballSocket,
  userId: string,
  matchId: string
): Promise<void> {
  socket.leave(`match:${matchId}`);
  socket.data.matchId = undefined;
  await auctionStateStore.clearUserMatchIndex(userId, matchId).catch(() => {});
}

async function scheduleAuctionDisconnectGraceTimer(
  matchId: string,
  userId: string,
  seatId: string,
  disconnectCount: number,
  pauseUntil: string
): Promise<void> {
  await scheduleRealtimeTimer(
    'auction_disconnect_grace',
    auctionDisconnectGraceTimerKey(matchId, userId),
    new Date(pauseUntil),
    {
      kind: 'auction_disconnect_grace',
      matchId,
      userId,
      seatId,
      disconnectCount,
    }
  );
}

async function forfeitAuctionSeatForDisconnect(
  matchId: string,
  userId: string,
  seatId: string,
  reason: 'disconnect_timeout' | 'reconnect_limit',
  options: AuctionDisconnectOptions
): Promise<AuctionDisconnectExpiryOutcome> {
  const context = resolveAuctionContext(options);
  return auctionStateStore.mutate(matchId, (current) => {
    const seat = findAuctionSeatByUserId(current, userId);
    if (!seat || seat.seatId !== seatId || seat.isBot) return skipAuctionMatchMutation(noop('seat_missing'));
    if (seat.isEliminated || current.phase === 'finished') return skipAuctionMatchMutation(noop('already_terminal'));

    let next: AuctionMatchState = {
      ...current,
      seats: current.seats.map((entry) => (
        entry.seatId === seatId ? { ...entry, isEliminated: true } : entry
      )),
    };

    if (next.phase === 'bidding' && next.currentRound) {
      next = advanceTurnOrResolveRound({
        ...next,
        currentRound: {
          ...next.currentRound,
          foldedSeatIds: [...new Set([...next.currentRound.foldedSeatIds, seatId])],
          updatedAt: context.nowIso(),
        },
      }, context);
    } else if (next.phase === 'solo_pick' && next.soloPick?.playerSeatId === seatId) {
      next = {
        ...next,
        phase: 'created',
        soloPick: null,
        currentRound: null,
        updatedAt: context.nowIso(),
      };
    }

    if (!next.seats.some(canPlayerContinue)) {
      next = finishMatch(next, context);
    }

    return saveAuctionMatchMutation(next, (saved) => ({
      kind: 'forfeited',
      state: saved,
      userId,
      seatId,
      reason,
    }));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

function emitAuctionPaused(
  io: QuizballServer,
  state: AuctionMatchState,
  input: Omit<AuctionPausedPayload, 'matchId' | 'state' | 'stateVersion' | 'serverNow'>
): void {
  io.to(`match:${state.matchId}`).emit('auction:paused', {
    matchId: state.matchId,
    ...input,
    state: toPublicAuctionMatchState(state),
    stateVersion: state.version,
    serverNow: new Date().toISOString(),
  });
}

function buildOpponentDisconnectedPayload(input: AuctionOpponentDisconnectedPayload): AuctionOpponentDisconnectedPayload {
  return {
    ...input,
    serverNow: new Date().toISOString(),
  };
}

function buildPlayerForfeitedPayload(
  state: AuctionMatchState,
  input: Omit<AuctionPlayerForfeitedPayload, 'matchId' | 'state' | 'stateVersion' | 'serverNow'>
): AuctionPlayerForfeitedPayload {
  return {
    matchId: state.matchId,
    ...input,
    state: toPublicAuctionMatchState(state),
    stateVersion: state.version,
    serverNow: new Date().toISOString(),
  };
}

function noop(reason: string): AuctionDisconnectExpiryOutcome {
  return { kind: 'noop', reason };
}
