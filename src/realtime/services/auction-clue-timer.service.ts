import { logger } from '../../core/logger.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { resolveAuctionContext } from '../../modules/auction/auction-context.js';
import { CLUE_REVEAL_INTERVAL_MS, CLUE_STUDY_MS } from '../../modules/auction/auction.constants.js';
import { beginClueStudy, revealNextClue, startBidding, type AuctionEngineContext } from '../../modules/auction/auction-engine.js';
import {
  toPublicAuctionMatchState,
  type AuctionMatchState,
  type PublicAuctionMatchState,
  type PublicAuctionRoundState,
} from '../../modules/auction/auction-match-state.js';
import {
  auctionStateStore,
  saveAuctionMatchMutation,
  skipAuctionMatchMutation,
} from '../../modules/auction/auction-state.store.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { QuizballServer } from '../socket-server.js';
import type {
  AuctionBiddingStartedPayload,
  AuctionClueRevealedPayload,
} from '../socket.types.js';
import { advanceAuctionMatchFlowAfterMutation } from './auction-match-flow.service.js';
import { getAuctionPause } from './auction-disconnect-state.service.js';
import { emitAndScheduleAuctionTurnStarted } from './auction-turn.service.js';
import { openAuctionUiReadyGate } from './auction-ui-ready.service.js';

export type AuctionClueRevealPayload = Extract<RealtimeTimerPayload, { kind: 'auction_clue_reveal' }>;
export type AuctionClueStudyPayload = Extract<RealtimeTimerPayload, { kind: 'auction_clue_study' }>;

export interface AuctionClueRevealTimerOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionClueTimerOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'clue_revealed'; state: AuctionMatchState; clue: string; clueIndex: number }
  | { kind: 'study_started'; state: AuctionMatchState; clue: string; clueIndex: number };

type AuctionClueStudyOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'bidding_started'; state: AuctionMatchState };

export function auctionClueRevealTimerKey(
  matchId: string,
  roundId: string,
  expectedClueIndex: number
): string {
  return `${matchId}:${roundId}:${expectedClueIndex}`;
}

export function auctionClueStudyTimerKey(matchId: string, roundId: string): string {
  return `${matchId}:${roundId}`;
}

export async function scheduleAuctionClueRevealTimer(
  state: AuctionMatchState,
  options: AuctionClueRevealTimerOptions = {}
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'clue_reveal' || !round) return;

  const expectedClueIndex = round.clueRevealIndex + 1;
  const clueCount = round.footballer.clues?.length ?? 0;
  if (expectedClueIndex > clueCount) return;

  const nowMs = (options.now ?? options.context?.now?.() ?? new Date()).getTime();
  const dueAt = new Date(nowMs + harnessDelayMs(CLUE_REVEAL_INTERVAL_MS, 50));

  await scheduleRealtimeTimer(
    'auction_clue_reveal',
    auctionClueRevealTimerKey(state.matchId, round.roundId, expectedClueIndex),
    dueAt,
    {
      kind: 'auction_clue_reveal',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedClueIndex,
      stateVersion: state.version,
    }
  );
}

export async function runAuctionClueRevealTimer(
  io: QuizballServer,
  payload: AuctionClueRevealPayload,
  options: AuctionClueRevealTimerOptions = {}
): Promise<AuctionClueTimerOutcome> {
  // Paused match (a player is in their disconnect grace window): defer instead
  // of revealing — clues must not advance past an absent player. Re-check just
  // after the grace instant; resume/forfeit re-arm with fresh payloads, so this
  // deferred copy simply no-ops (version_mismatch) if the match moved on.
  const pause = await getAuctionPause(payload.matchId);
  if (pause) {
    const pauseUntilMs = Date.parse(pause.pauseUntil);
    const dueAt = new Date(Math.max(Number.isFinite(pauseUntilMs) ? pauseUntilMs : 0, Date.now()) + 2_000);
    await scheduleRealtimeTimer(
      'auction_clue_reveal',
      auctionClueRevealTimerKey(payload.matchId, payload.roundId, payload.expectedClueIndex),
      dueAt,
      payload
    );
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId }, 'Auction clue timer deferred (match paused)');
    return { kind: 'noop', reason: 'paused' };
  }

  const outcome = await advanceClueRevealState(payload, options);

  if (outcome.kind === 'noop') {
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId, reason: outcome.reason }, 'Auction clue timer ignored');
    return outcome;
  }

  const publicState = toPublicAuctionMatchState(outcome.state);
  const cluePayload = buildClueRevealedPayload(publicState, outcome.clue, outcome.clueIndex);
  io.to(`match:${outcome.state.matchId}`).emit('auction:clue_revealed', cluePayload);

  // Last clue: hold on the full board for the study window instead of opening
  // turns immediately. `biddingStartsAt` rides along on the clue payload above,
  // so the client renders the countdown off the same event.
  if (outcome.kind === 'study_started') {
    await scheduleAuctionClueStudyTimer(outcome.state, options);
    return outcome;
  }

  if (outcome.state.phase !== 'clue_reveal') {
    await advanceAuctionMatchFlowAfterMutation(io, outcome.state, options);
    return outcome;
  }

  await scheduleAuctionClueRevealTimer(outcome.state, options);
  return outcome;
}

export async function scheduleAuctionClueStudyTimer(
  state: AuctionMatchState,
  options: AuctionClueRevealTimerOptions = {}
): Promise<void> {
  const round = state.currentRound;
  if (state.phase !== 'clue_reveal' || !round) return;

  const nowMs = (options.now ?? options.context?.now?.() ?? new Date()).getTime();
  const studyEndsMs = round.biddingStartsAt ? Date.parse(round.biddingStartsAt) : NaN;
  const dueAt = new Date(
    Number.isFinite(studyEndsMs)
      ? Math.max(studyEndsMs, nowMs)
      : nowMs + harnessDelayMs(CLUE_STUDY_MS, 50)
  );

  await scheduleRealtimeTimer(
    'auction_clue_study',
    auctionClueStudyTimerKey(state.matchId, round.roundId),
    dueAt,
    {
      kind: 'auction_clue_study',
      matchId: state.matchId,
      roundId: round.roundId,
      stateVersion: state.version,
    }
  );
}

/** Fires when the post-clue study window closes: opens bidding on the lot. */
export async function runAuctionClueStudyTimer(
  io: QuizballServer,
  payload: AuctionClueStudyPayload,
  options: AuctionClueRevealTimerOptions = {}
): Promise<AuctionClueStudyOutcome> {
  // Same pause contract as the clue timer: never open bidding while a player
  // sits in their disconnect grace window.
  const pause = await getAuctionPause(payload.matchId);
  if (pause) {
    const pauseUntilMs = Date.parse(pause.pauseUntil);
    const dueAt = new Date(Math.max(Number.isFinite(pauseUntilMs) ? pauseUntilMs : 0, Date.now()) + 2_000);
    await scheduleRealtimeTimer(
      'auction_clue_study',
      auctionClueStudyTimerKey(payload.matchId, payload.roundId),
      dueAt,
      payload
    );
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId }, 'Auction study timer deferred (match paused)');
    return { kind: 'noop', reason: 'paused' };
  }

  const context = resolveAuctionContext(options);
  const outcome = await auctionStateStore.mutate<AuctionClueStudyOutcome>(payload.matchId, (current) => {
    const round = current.currentRound;
    if (current.version !== payload.stateVersion) return skipAuctionMatchMutation(noop('version_mismatch'));
    if (current.phase !== 'clue_reveal') return skipAuctionMatchMutation(noop('phase_mismatch'));
    if (!round) return skipAuctionMatchMutation(noop('missing_round'));
    if (round.roundId !== payload.roundId) return skipAuctionMatchMutation(noop('round_mismatch'));

    return saveAuctionMatchMutation(startBidding(current, context), (saved) => ({
      kind: 'bidding_started',
      state: saved,
    } as AuctionClueStudyOutcome));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });

  if (outcome.kind === 'noop') {
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId, reason: outcome.reason }, 'Auction study timer ignored');
    return outcome;
  }

  // startBidding falls through to resolveUnsoldRound when nobody can open.
  if (outcome.state.phase !== 'bidding') {
    await advanceAuctionMatchFlowAfterMutation(io, outcome.state, options);
    return outcome;
  }

  const publicState = toPublicAuctionMatchState(outcome.state);
  io.to(`match:${outcome.state.matchId}`).emit('auction:bidding_started', buildBiddingStartedPayload(publicState));
  openAuctionUiReadyGate({
    io,
    state: outcome.state,
    phase: 'bidding',
    dispatch: () => {
      void emitAndScheduleAuctionTurnStarted(io, outcome.state, options);
    },
  });
  return outcome;
}

async function advanceClueRevealState(
  payload: AuctionClueRevealPayload,
  options: AuctionClueRevealTimerOptions
): Promise<AuctionClueTimerOutcome> {
  const context = resolveAuctionContext(options);
  return auctionStateStore.mutate(payload.matchId, (current) => {
    const validation = validateTimerPayload(current, payload);
    if (validation) return skipAuctionMatchMutation(noop(validation));

    const round = current.currentRound;
    if (!round) return skipAuctionMatchMutation(noop('missing_round'));

    const clue = round.footballer.clues?.[payload.expectedClueIndex - 1];
    if (!clue) return skipAuctionMatchMutation(noop('missing_clue'));

    const revealed = revealNextClue(current, context);
    const revealedRound = revealed.currentRound;
    if (!revealedRound) return skipAuctionMatchMutation(noop('missing_revealed_round'));

    const clueCount = revealedRound.footballer.clues?.length ?? 0;
    const allCluesOut = revealedRound.clueRevealIndex >= clueCount;
    const nextState = allCluesOut ? beginClueStudy(revealed, context) : revealed;

    return saveAuctionMatchMutation(nextState, (saved) => ({
      kind: allCluesOut ? 'study_started' : 'clue_revealed',
      state: saved,
      clue,
      clueIndex: payload.expectedClueIndex,
    } as AuctionClueTimerOutcome));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

/** Narrow return type on purpose: assignable to both timer outcome unions. */
function noop(reason: string): { kind: 'noop'; reason: string } {
  return { kind: 'noop', reason };
}

function validateTimerPayload(
  state: AuctionMatchState,
  payload: AuctionClueRevealPayload
): string | null {
  const round = state.currentRound;
  if (state.version !== payload.stateVersion) return 'version_mismatch';
  if (state.phase !== 'clue_reveal') return 'phase_mismatch';
  if (!round) return 'missing_round';
  if (round.roundId !== payload.roundId) return 'round_mismatch';
  if (round.clueRevealIndex >= payload.expectedClueIndex) return 'duplicate_clue_timer';
  if (round.clueRevealIndex !== payload.expectedClueIndex - 1) return 'clue_index_mismatch';
  return null;
}

function buildClueRevealedPayload(
  publicState: PublicAuctionMatchState,
  clue: string,
  clueIndex: number
): AuctionClueRevealedPayload {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable for clue reveal payload');
  }

  return {
    matchId: publicState.matchId,
    roundId: publicState.currentRound.roundId,
    clueIndex,
    clue,
    round: publicState.currentRound,
    stateVersion: publicState.version,
    serverNow: new Date().toISOString(),
  };
}

function buildBiddingStartedPayload(publicState: PublicAuctionMatchState): AuctionBiddingStartedPayload {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable for bidding payload');
  }
  const round = hidePendingTurn(publicState.currentRound as PublicAuctionRoundState);
  return {
    matchId: publicState.matchId,
    roundId: round.roundId,
    round,
    currentTurnSeatId: round.currentTurnSeatId,
    turnEndsAt: round.turnEndsAt,
    stateVersion: publicState.version,
    serverNow: new Date().toISOString(),
  };
}

function hidePendingTurn(round: PublicAuctionRoundState): PublicAuctionRoundState {
  return {
    ...round,
    currentTurnSeatId: null,
    turnEndsAt: null,
  };
}
