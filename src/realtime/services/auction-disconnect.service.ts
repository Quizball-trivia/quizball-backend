import { logger } from '../../core/logger.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { type AuctionEngineContext } from '../../modules/auction/auction-context.js';
import { advanceTurnOrResolveRound, finishMatch, getTurnMs, stripSeatBidLeadership } from '../../modules/auction/auction-engine.js';
import {
  auctionMatchOrigin,
  findAuctionSeatByUserId,
  toPublicAuctionMatchState,
  type AuctionMatchState,
} from '../../modules/auction/auction-match-state.js';
import {
  auctionCoinsForPlacement,
  auctionPointsForPlacement,
} from './auction-persistence.service.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import {
  canPlayerContinue,
  hasLastPlayerStanding,
} from '../../modules/auction/auction-rules.js';
import {
  scheduleRealtimeTimer,
  cancelRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import type {
  AuctionOpponentDisconnectedPayload,
  AuctionPausedPayload,
  AuctionPlayerForfeitedPayload,
  AuctionResumePayload,
  AuctionRejoinAvailablePayload,
} from '../socket.types.js';
import {
  advanceAuctionMatchFlowAfterMutation,
  scheduleAuctionSoloPickTimeoutTimer,
  type AuctionMatchFinishReason,
} from './auction-match-flow.service.js';
import { scheduleAuctionClueRevealTimer } from './auction-clue-timer.service.js';
import { buildAuctionPausedStatePayload } from './auction-disconnect-state.service.js';
import {
  clearAuctionPause,
  clearAuctionUserDisconnected,
  findAnyDisconnectedHuman,
  getAuctionDisconnectDebounceMs,
  getAuctionDisconnectGraceMs,
  getAuctionDisconnectedUser,
  getAuctionPause,
  hasReplacementAuctionMatchSocket,
  incrementAuctionDisconnectCount,
  markAuctionUserDisconnected,
  MAX_AUCTION_DISCONNECTS,
  pauseAuctionCurrentTurnForDisconnectedSeat,
  setAuctionPause,
  toRemainingAuctionReconnects,
} from './auction-disconnect-state.service.js';
import { emitAndScheduleAuctionTurnStarted, scheduleAuctionTurnTimeoutTimer } from './auction-turn.service.js';
import { resolveRealtimeAuctionContext } from './auction-engine-context.js';

export type AuctionDisconnectGraceTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_disconnect_grace' }>;
export type AuctionDisconnectDebounceTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_disconnect_debounce' }>;
export type AuctionResumeCountdownTimerPayload = Extract<RealtimeTimerPayload, { kind: 'auction_resume_countdown' }>;

// "Get ready" countdown after a player opts to rejoin, before the match
// unpauses (mirrors ranked's MATCH_RESUME_COUNTDOWN_MS).
const AUCTION_RESUME_COUNTDOWN_MS = 5_000;

export function auctionResumeCountdownTimerKey(matchId: string, userId: string): string {
  return `${matchId}:${userId}`;
}

export interface AuctionDisconnectOptions {
  now?: Date;
  context?: AuctionEngineContext;
  bypassPresenceGuard?: boolean;
}

type AuctionDisconnectExpiryOutcome =
  | { kind: 'noop'; reason: string }
  | {
    kind: 'forfeited';
    state: AuctionMatchState;
    userId: string;
    seatId: string;
    reason: 'disconnect_timeout' | 'reconnect_limit';
    finishReason?: AuctionMatchFinishReason;
  };

export function auctionDisconnectGraceTimerKey(matchId: string, userId: string): string {
  return `${matchId}:${userId}`;
}

export function auctionDisconnectDebounceTimerKey(matchId: string, userId: string): string {
  return `${matchId}:${userId}`;
}

export async function handleAuctionSocketDisconnect(
  io: QuizballServer,
  socket: QuizballSocket,
  _options: AuctionDisconnectOptions = {}
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

  await armAuctionDisconnectGrace(io, state, userId, socket.id);
}

export async function armAuctionDisconnectGrace(
  io: QuizballServer,
  state: AuctionMatchState,
  userId: string,
  ignoreSocketId?: string
): Promise<boolean> {
  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot || seat.forfeited || state.phase === 'finished') return false;

  const hasReplacement = await hasReplacementAuctionMatchSocket({
    io,
    matchId: state.matchId,
    userId,
    ignoreSocketId,
  });
  if (hasReplacement) return false;

  const graceMs = getAuctionDisconnectGraceMs();
  const pauseUntil = new Date(Date.now() + graceMs).toISOString();
  const disconnectedAt = new Date(Date.now()).toISOString();
  // Persist the absence and terminal grace timer immediately. Visible effects
  // are delayed until the durable debounce fires, so a process restart cannot
  // lose either the debounce decision or the eventual grace-forfeit.
  await markAuctionUserDisconnected({
    matchId: state.matchId,
    userId,
    seatId: seat.seatId,
    pauseUntil,
    disconnectCount: 0,
  });
  await scheduleAuctionDisconnectGraceTimer(state.matchId, userId, seat.seatId, 0, pauseUntil);
  await scheduleRealtimeTimer(
    'auction_disconnect_debounce',
    auctionDisconnectDebounceTimerKey(state.matchId, userId),
    new Date(Date.now() + getAuctionDisconnectDebounceMs()),
    {
      kind: 'auction_disconnect_debounce',
      matchId: state.matchId,
      userId,
      seatId: seat.seatId,
      disconnectedAt,
    },
  );
  return true;
}

export async function runAuctionDisconnectDebounceTimer(
  io: QuizballServer,
  payload: AuctionDisconnectDebounceTimerPayload,
  options: AuctionDisconnectOptions = {}
): Promise<void> {
  const disconnected = await getAuctionDisconnectedUser(payload.matchId, payload.userId);
  if (!disconnected || disconnected.seatId !== payload.seatId || disconnected.disconnectCount !== 0) return;

  const hasReplacement = await hasReplacementAuctionMatchSocket({
    io, matchId: payload.matchId, userId: payload.userId,
  });
  if (hasReplacement) {
    await clearAuctionUserDisconnected(payload.matchId, payload.userId);
    await cancelRealtimeTimer('auction_disconnect_grace', auctionDisconnectGraceTimerKey(payload.matchId, payload.userId));
    return;
  }

  const state = await auctionStateStore.load(payload.matchId).catch(() => null);
  if (!state || state.phase === 'finished') return;
  const seat = findAuctionSeatByUserId(state, payload.userId);
  if (!seat || seat.isBot || seat.forfeited) return;

  const disconnectCount = await incrementAuctionDisconnectCount(payload.matchId, payload.userId);
  const pauseUntil = disconnected.pauseUntil;
  const graceMs = getAuctionDisconnectGraceMs();
  await markAuctionUserDisconnected({ ...disconnected, disconnectCount });
  // Replace the provisional payload with the counted disconnect. The deadline
  // remains anchored to the original socket loss, not the end of debounce.
  await scheduleAuctionDisconnectGraceTimer(payload.matchId, payload.userId, payload.seatId, disconnectCount, pauseUntil);

  const reason = disconnectCount > MAX_AUCTION_DISCONNECTS ? 'reconnect_limit' : 'disconnect';
  const remainingReconnects = toRemainingAuctionReconnects(disconnectCount);
  const opponentPayload = buildOpponentDisconnectedPayload({
    matchId: payload.matchId,
    userId: payload.userId,
    seatId: seat.seatId,
    pauseUntil,
    graceMs,
    remainingReconnects,
    reason,
  });
  io.to(`match:${payload.matchId}`).emit('auction:opponent_disconnected', opponentPayload);

  if (disconnectCount > MAX_AUCTION_DISCONNECTS) {
    await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: payload.matchId,
      userId: payload.userId,
      seatId: seat.seatId,
      disconnectCount,
    }, options, 'reconnect_limit');
    return;
  }

  const pauseRow = {
    matchId: payload.matchId,
    userId: payload.userId,
    seatId: seat.seatId,
    pauseUntil,
    disconnectCount,
  };
  const paused = await pauseAuctionCurrentTurnForDisconnectedSeat(state, pauseRow);
  if (paused) {
    emitAuctionPaused(io, paused.state, {
      userId: payload.userId,
      seatId: seat.seatId,
      pauseUntil: paused.pauseUntil,
      graceMs: paused.graceMs,
      remainingReconnects: paused.remainingReconnects,
      reason,
    });
    io.to(`match:${payload.matchId}`).emit('auction:state', buildAuctionPausedStatePayload(paused));
    await scheduleAuctionTurnTimeoutTimer(paused.state, options);
  } else if (shouldPauseAuctionPhaseForSeat(state, seat.seatId)) {
    // Phase-agnostic pause (ISSUE 1): clue_reveal / reveal / this player's own
    // solo pick also pause for the grace window. The phase timers defer while
    // the pause row exists (clue + solo-pick handlers check it) and resume
    // re-arms them; bidding-not-their-turn keeps playing until the turn order
    // reaches the disconnected seat (pauseAuctionCurrentTurnIfDisconnected).
    // Do NOT overwrite a pause row that still belongs to a DIFFERENT
    // still-disconnected player — the row re-points when its owner resolves.
    const existingPause = await getAuctionPause(payload.matchId);
    const existingOwnerStillGone = existingPause && existingPause.userId !== payload.userId
      ? await getAuctionDisconnectedUser(payload.matchId, existingPause.userId)
      : null;
    if (!existingOwnerStillGone) {
      await setAuctionPause(pauseRow);
    }
    emitAuctionPaused(io, state, {
      userId: payload.userId,
      seatId: seat.seatId,
      pauseUntil,
      graceMs,
      remainingReconnects,
      reason,
    });
  }

  logger.info(
    { matchId: payload.matchId, userId: payload.userId, seatId: seat.seatId, disconnectCount, remainingReconnects },
    'Auction human disconnected; grace armed'
  );
}

/**
 * Reconnecting player who was disconnected mid-match opts back in: cancel the
 * grace-forfeit timer and start a server-authoritative "get ready" resume
 * countdown. The match actually unpauses when the countdown timer fires
 * (runAuctionResumeCountdownTimer) — mirroring ranked's resume countdown rather
 * than resuming instantly. Returns false if the user wasn't actually paused.
 */
export async function resumeAuctionUserIfDisconnected(
  io: QuizballServer,
  socket: QuizballSocket,
  state: AuctionMatchState
): Promise<boolean> {
  const userId = socket.data.user?.id;
  if (!userId) return false;

  return resumeAuctionUserByIdIfDisconnected(io, userId, state);
}

async function resumeAuctionUserByIdIfDisconnected(
  io: QuizballServer,
  userId: string,
  state: AuctionMatchState
): Promise<boolean> {
  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) return false;

  const disconnected = await getAuctionDisconnectedUser(state.matchId, userId);
  if (!disconnected) return false;

  if (disconnected.disconnectCount === 0) {
    // Socket replacement landed inside the invisible debounce. No match state
    // was paused and this does not consume a reconnect allowance.
    await clearAuctionUserDisconnected(state.matchId, userId);
    await Promise.all([
      cancelRealtimeTimer('auction_disconnect_debounce', auctionDisconnectDebounceTimerKey(state.matchId, userId)),
      cancelRealtimeTimer('auction_disconnect_grace', auctionDisconnectGraceTimerKey(state.matchId, userId)),
    ]);
    return true;
  }

  // Arm the resume countdown FIRST, then clear the disconnect marker + grace
  // timer. Ordered this way, a crash mid-sequence leaves either the grace
  // intact (before) or the countdown armed (after) — there is no window where
  // the match is paused with neither timer to resolve it.
  const countdownMs = harnessDelayMs(AUCTION_RESUME_COUNTDOWN_MS, 150);
  const countdownEndsAt = new Date(Date.now() + countdownMs).toISOString();
  await scheduleRealtimeTimer(
    'auction_resume_countdown',
    auctionResumeCountdownTimerKey(state.matchId, userId),
    new Date(countdownEndsAt),
    { kind: 'auction_resume_countdown', matchId: state.matchId, userId },
  );
  await clearAuctionUserDisconnected(state.matchId, userId);
  await cancelRealtimeTimer('auction_disconnect_grace', auctionDisconnectGraceTimerKey(state.matchId, userId));
  io.to(`match:${state.matchId}`).emit('auction:resume_countdown', {
    matchId: state.matchId,
    countdownEndsAt,
    serverNow: new Date().toISOString(),
  });
  logger.info(
    { matchId: state.matchId, userId, seatId: seat.seatId, countdownMs },
    'Auction user reconnected during grace; resume countdown started'
  );
  return true;
}

/**
 * Resume countdown elapsed → actually unpause: clear the pause, push the fresh
 * state to everyone (auction:resume), and re-arm the turn timer. Idempotent — a
 * stale/duplicate timer with no pause is a no-op.
 */
export async function runAuctionResumeCountdownTimer(
  io: QuizballServer,
  payload: AuctionResumeCountdownTimerPayload,
  options: AuctionDisconnectOptions = {}
): Promise<void> {
  const { matchId, userId } = payload;
  const state = await auctionStateStore.load(matchId).catch(() => null);
  if (!state || state.phase === 'finished') return;

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) return;

  // If the player disconnected AGAIN during the countdown, don't resume — the
  // new grace timer owns the match now.
  const reDisconnected = await getAuctionDisconnectedUser(matchId, userId);
  if (reDisconnected) return;

  const pause = await getAuctionPause(matchId);
  if (pause?.userId === userId) {
    await clearAuctionPause(matchId);
    // Keep the match paused for any OTHER human still in their grace window.
    const otherDisconnected = await findAnyDisconnectedHuman(state, userId);
    if (otherDisconnected) {
      await setAuctionPause(otherDisconnected);
    }
  }

  // If the resumed player's turn was parked at the pause backstop, give them a
  // fresh turn window from NOW (the backstop deadline is far in the future and
  // the original one is long gone).
  const rebased = await rebaseAuctionTurnDeadlineAfterResume(matchId, seat.seatId, options);
  const freshState = rebased ?? (await auctionStateStore.load(matchId) ?? state);
  const payloadOut: AuctionResumePayload = {
    matchId: freshState.matchId,
    seatId: seat.seatId,
    userId,
    reason: 'reconnected',
    state: toPublicAuctionMatchState(freshState),
    stateVersion: freshState.version,
    serverNow: new Date().toISOString(),
  };
  // Only broadcast the resume when no one else's pause is still active — a
  // room-wide auction:resume clears every client's pause overlay, which would
  // wrongly unpause the UI while another player is still in grace. In that
  // case the resumed player alone gets the fresh state.
  const remainingPause = await getAuctionPause(matchId);
  if (!remainingPause || remainingPause.userId === userId) {
    io.to(`match:${matchId}`).emit('auction:resume', payloadOut);
  } else {
    io.to(`user:${userId}`).emit('auction:resume', payloadOut);
  }

  // Phase-aware timer re-arm (the pause deferred these while it was live).
  if (freshState.phase === 'bidding') {
    await scheduleAuctionTurnTimeoutTimer(freshState, options);
  } else if (freshState.phase === 'clue_reveal') {
    await scheduleAuctionClueRevealTimer(freshState, options);
  } else if (freshState.phase === 'solo_pick') {
    await scheduleAuctionSoloPickTimeoutTimer(freshState, { fromNow: true });
  } else if (freshState.phase === 'reveal') {
    // Re-open the reveal gate (its advance was deferred during the pause).
    await advanceAuctionMatchFlowAfterMutation(io, freshState, options);
  }
  logger.info({ matchId, userId, seatId: seat.seatId }, 'Auction resume countdown complete; match unpaused');
}

/**
 * After a resume, re-base the current turn's deadline to a fresh window when it
 * belongs to the resumed seat (it was parked at the far-future pause backstop).
 * Returns the updated state, or null when there was nothing to re-base.
 */
async function rebaseAuctionTurnDeadlineAfterResume(
  matchId: string,
  seatId: string,
  options: AuctionDisconnectOptions
): Promise<AuctionMatchState | null> {
  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(matchId, (current) => {
    const round = current.currentRound;
    if (current.phase !== 'bidding' || round?.currentTurnSeatId !== seatId || !round) {
      return skipAuctionMatchMutation(null);
    }
    return saveAuctionMatchMutation({
      ...current,
      currentRound: {
        ...round,
        turnEndsAt: new Date(context.now().getTime() + getTurnMs(round, context)).toISOString(),
        updatedAt: context.nowIso(),
      },
    }, (next) => next);
  }, {
    now: context.now,
    onMissingState: () => null,
  });
}

/**
 * Client opted to rejoin (auction:rejoin) after a rejoin_available prompt:
 * re-attach the socket to the match room, push the current state, and start the
 * resume countdown. Returns false if the match is gone / the user isn't seated.
 */
export async function handleAuctionRejoin(
  io: QuizballServer,
  socket: QuizballSocket,
  matchId: string,
): Promise<boolean> {
  const userId = socket.data.user?.id;
  if (!userId) return false;

  const state = await auctionStateStore.load(matchId).catch(() => null);
  if (!state) return false;

  const seat = findAuctionSeatByUserId(state, userId);
  if (!seat || seat.isBot) return false;

  // The match ended while this client was away (backgrounded tab missed the
  // finish broadcast). Replay the finished snapshot so the player lands on the
  // results screen — mirrors ranked — instead of a generic "can't rejoin".
  // Deliberately BEFORE the forfeited check: a forfeited player returning to a
  // finished match still deserves their results (rank + zero rewards); only
  // rejoining live play is blocked for them below.
  if (state.phase === 'finished') {
    if (!state.rankings) return false;
    emitAuctionMatchFinishedReplay(socket, state);
    return true;
  }

  // A forfeited seat can't come back — their grace already expired.
  if (seat.forfeited) return false;

  socket.data.lobbyId = undefined;
  socket.data.matchId = matchId;
  socket.join(`match:${matchId}`);
  socket.emit('auction:state', {
    matchId: state.matchId,
    state: toPublicAuctionMatchState(state),
    stateVersion: state.version,
    serverNow: new Date().toISOString(),
  });

  // Start the resume countdown if still within grace; if not paused anymore
  // (e.g. opponent's pause), the socket is simply back in sync.
  await resumeAuctionUserIfDisconnected(io, socket, state);
  return true;
}

/**
 * Replay a finished match to a socket that missed the live finish broadcast.
 * Rewards are recomputed deterministically from placements — the same formulas
 * persistence used when it paid out — so the replayed results screen shows the
 * coins/AP that were actually granted. Forfeiters earned nothing and show 0.
 */
function emitAuctionMatchFinishedReplay(socket: QuizballSocket, state: AuctionMatchState): void {
  const rankings = state.rankings ?? [];
  const publicState = toPublicAuctionMatchState(state);
  const awardsAuctionPoints = auctionMatchOrigin(state) === 'queue';
  const coinsByUserId: Record<string, number> = {};
  const apByUserId: Record<string, number> | undefined = awardsAuctionPoints ? {} : undefined;
  for (const ranking of rankings) {
    if (ranking.isBot || !ranking.userId) continue;
    const rankedSeat = state.seats.find((s) => s.seatId === ranking.seatId);
    const earned = rankedSeat && !rankedSeat.forfeited;
    coinsByUserId[ranking.userId] = earned ? auctionCoinsForPlacement(ranking.rank) : 0;
    if (apByUserId) apByUserId[ranking.userId] = earned ? auctionPointsForPlacement(ranking.rank) : 0;
  }
  socket.emit('auction:state', {
    matchId: state.matchId,
    state: publicState,
    stateVersion: state.version,
    serverNow: new Date().toISOString(),
  });
  socket.emit('auction:match_finished', {
    matchId: state.matchId,
    rankings,
    winnerSeatId: rankings[0]?.seatId ?? null,
    state: publicState,
    stateVersion: state.version,
    coinsByUserId,
    apByUserId,
  });
}

/**
 * Build the "rejoin available" payload for a reconnecting player who is still
 * within their grace window — the client shows a rejoin prompt and must emit
 * auction:rejoin to come back (mirrors ranked's match:rejoin_available).
 */
export function buildAuctionRejoinAvailable(
  disconnected: { seatId: string; pauseUntil: string; disconnectCount: number },
): AuctionRejoinAvailablePayload {
  const pauseUntilMs = Date.parse(disconnected.pauseUntil);
  const graceMs = Number.isFinite(pauseUntilMs)
    ? Math.max(0, pauseUntilMs - Date.now())
    : getAuctionDisconnectGraceMs();
  return {
    matchId: '',
    seatId: disconnected.seatId,
    graceMs,
    remainingReconnects: toRemainingAuctionReconnects(disconnected.disconnectCount),
    serverNow: new Date().toISOString(),
  };
}

/**
 * Should this phase pause while `seatId`'s player is disconnected? Bidding is
 * handled separately (pauses only when/once it's their turn); everything else
 * active pauses so the match can't advance past a player in their grace window.
 */
function shouldPauseAuctionPhaseForSeat(state: AuctionMatchState, seatId: string): boolean {
  if (state.phase === 'clue_reveal' || state.phase === 'reveal') return true;
  if (state.phase === 'solo_pick') return state.soloPick?.playerSeatId === seatId;
  return false;
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

  if (!options.bypassPresenceGuard) {
    const hasReplacement = await hasReplacementAuctionMatchSocket({
      io,
      matchId: payload.matchId,
      userId: payload.userId,
    });
    if (hasReplacement) {
      const state = await auctionStateStore.load(payload.matchId).catch(() => null);
      if (state && state.phase !== 'finished') {
        await resumeAuctionUserByIdIfDisconnected(io, payload.userId, state);
      }
      return noop('replacement_socket_present');
    }
  }

  const outcome = await forfeitAuctionSeatForDisconnect(payload.matchId, payload.userId, payload.seatId, reason, options);
  if (outcome.kind === 'noop') return outcome;

  await clearAuctionUserDisconnected(payload.matchId, payload.userId);
  // The pause row is shared per match: only clear it if it belongs to THIS
  // forfeiter, then re-point it at any other human still in their grace window
  // so the match stays paused for them (2-3 real-player overlap).
  const pause = await getAuctionPause(payload.matchId);
  if (!pause || pause.userId === payload.userId) {
    await clearAuctionPause(payload.matchId);
    const otherDisconnected = await findAnyDisconnectedHuman(outcome.state, payload.userId);
    if (otherDisconnected) {
      await setAuctionPause(otherDisconnected);
    }
  }
  // The forfeiter is out of this match for good — free them to search again.
  await auctionStateStore.clearUserMatchIndex(payload.userId, payload.matchId).catch(() => {});

  const forfeitPayload = buildPlayerForfeitedPayload(outcome.state, {
    userId: payload.userId,
    seatId: payload.seatId,
    reason,
  });
  io.to(`match:${payload.matchId}`).emit('auction:player_forfeited', forfeitPayload);

  if (outcome.state.phase === 'bidding' && outcome.state.currentRound?.currentTurnSeatId) {
    await emitAndScheduleAuctionTurnStarted(io, outcome.state, options);
  } else {
    await advanceAuctionMatchFlowAfterMutation(io, outcome.state, {
      ...options,
      finishReason: outcome.finishReason
        ?? (outcome.state.phase === 'finished' ? 'forfeit' : undefined),
    });
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
    { ...options, bypassPresenceGuard: true },
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
  const context = resolveRealtimeAuctionContext(options);
  return auctionStateStore.mutate(matchId, (current) => {
    const seat = findAuctionSeatByUserId(current, userId);
    if (!seat || seat.seatId !== seatId || seat.isBot) return skipAuctionMatchMutation(noop('seat_missing'));
    if (seat.isEliminated || current.phase === 'finished') return skipAuctionMatchMutation(noop('already_terminal'));

    let next: AuctionMatchState = {
      ...current,
      seats: current.seats.map((entry) => (
        // `forfeited` distinguishes a quit/drop-out from honest budget
        // elimination: forfeiters rank below everyone and earn no coins.
        entry.seatId === seatId ? { ...entry, isEliminated: true, forfeited: true } : entry
      )),
    };

    if (next.phase === 'bidding' && next.currentRound) {
      const forfeitedCurrentTurn = next.currentRound.currentTurnSeatId === seatId;
      next = stripSeatBidLeadership({
        ...next,
        currentRound: {
          ...next.currentRound,
          foldedSeatIds: [...new Set([...next.currentRound.foldedSeatIds, seatId])],
          updatedAt: context.nowIso(),
        },
      }, seatId);
      if (forfeitedCurrentTurn) {
        next = advanceTurnOrResolveRound(next, context);
      }
    } else if (next.phase === 'solo_pick' && next.soloPick?.playerSeatId === seatId) {
      next = {
        ...next,
        phase: 'created',
        soloPick: null,
        currentRound: null,
        updatedAt: context.nowIso(),
      };
    }

    const lastPlayerStanding = hasLastPlayerStanding(next.seats);
    const hasLiveHuman = next.seats.some((entry) => (
      !entry.isBot && Boolean(entry.userId) && !entry.forfeited && !entry.isEliminated
    ));
    if (lastPlayerStanding || !hasLiveHuman || !next.seats.some(canPlayerContinue)) {
      next = finishMatch(next, context);
    }

    return saveAuctionMatchMutation(next, (saved) => ({
      kind: 'forfeited',
      state: saved,
      userId,
      seatId,
      reason,
      finishReason: lastPlayerStanding ? 'last_player_standing' : undefined,
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
