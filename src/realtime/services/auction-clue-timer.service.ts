import { logger } from '../../core/logger.js';
import { harnessDelayMs } from '../../core/harness-timing.js';
import { CLUE_REVEAL_INTERVAL_MS } from '../../modules/auction/auction.constants.js';
import { revealNextClue, startBidding, type AuctionEngineContext } from '../../modules/auction/auction-engine.js';
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
import { emitAndScheduleAuctionTurnStarted } from './auction-turn.service.js';

export type AuctionClueRevealPayload = Extract<RealtimeTimerPayload, { kind: 'auction_clue_reveal' }>;

export interface AuctionClueRevealTimerOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

type AuctionClueTimerOutcome =
  | { kind: 'noop'; reason: string }
  | { kind: 'clue_revealed'; state: AuctionMatchState; clue: string; clueIndex: number }
  | { kind: 'bidding_started'; state: AuctionMatchState; clue: string; clueIndex: number };

export function auctionClueRevealTimerKey(
  matchId: string,
  roundId: string,
  expectedClueIndex: number
): string {
  return `${matchId}:${roundId}:${expectedClueIndex}`;
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
  const outcome = await advanceClueRevealState(payload, options);

  if (outcome.kind === 'noop') {
    logger.debug({ matchId: payload.matchId, roundId: payload.roundId, reason: outcome.reason }, 'Auction clue timer ignored');
    return outcome;
  }

  const publicState = toPublicAuctionMatchState(outcome.state);
  const cluePayload = buildClueRevealedPayload(publicState, outcome.clue, outcome.clueIndex);
  io.to(`match:${outcome.state.matchId}`).emit('auction:clue_revealed', cluePayload);

  if (outcome.kind === 'bidding_started') {
    io.to(`match:${outcome.state.matchId}`).emit('auction:bidding_started', buildBiddingStartedPayload(publicState));
    await emitAndScheduleAuctionTurnStarted(io, outcome.state, options);
    return outcome;
  }

  if (outcome.state.phase !== 'clue_reveal') {
    await advanceAuctionMatchFlowAfterMutation(io, outcome.state, options);
    return outcome;
  }

  await scheduleAuctionClueRevealTimer(outcome.state, options);
  return outcome;
}

async function advanceClueRevealState(
  payload: AuctionClueRevealPayload,
  options: AuctionClueRevealTimerOptions
): Promise<AuctionClueTimerOutcome> {
  const context = resolveTimerContext(options);
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
    const nextState = revealedRound.clueRevealIndex >= clueCount
      ? startBidding(revealed, context)
      : revealed;

    return saveAuctionMatchMutation(nextState, (saved) => ({
      kind: saved.phase === 'bidding' ? 'bidding_started' : 'clue_revealed',
      state: saved,
      clue,
      clueIndex: payload.expectedClueIndex,
    } as AuctionClueTimerOutcome));
  }, {
    now: context.now,
    onMissingState: () => noop('missing_state'),
  });
}

function noop(reason: string): AuctionClueTimerOutcome {
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
  };
}

function buildBiddingStartedPayload(publicState: PublicAuctionMatchState): AuctionBiddingStartedPayload {
  if (!publicState.currentRound) {
    throw new Error('Auction round unavailable for bidding payload');
  }
  const round = publicState.currentRound as PublicAuctionRoundState;
  return {
    matchId: publicState.matchId,
    roundId: round.roundId,
    round,
    currentTurnSeatId: round.currentTurnSeatId,
    turnEndsAt: round.turnEndsAt,
    stateVersion: publicState.version,
  };
}

function resolveTimerContext(options: AuctionClueRevealTimerOptions): Required<Pick<AuctionEngineContext, 'now'>> {
  const now = options.context?.now ?? (() => options.now ?? new Date());
  return { now };
}
