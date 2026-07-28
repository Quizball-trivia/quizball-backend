import { logger } from '../../core/logger.js';
import type { AuctionMatchState } from '../../modules/auction/auction-match-state.js';
import { auctionStateStore } from '../../modules/auction/auction-state.store.js';
import type { QuizballServer } from '../socket-server.js';
import type { AuctionUiReadyPhase } from '../socket.types.js';
import { scheduleAuctionBotActionTimer } from './auction-bot.service.js';
import { scheduleAuctionClueRevealTimer } from './auction-clue-timer.service.js';
import type { AuctionAdvanceRetryTimerPayload } from './auction-advance-retry-timer.js';
import { advanceAuctionMatchFlowFromRevealGate } from './auction-match-flow.service.js';
import {
  runAuctionTurnTimeoutTimer,
  scheduleAuctionTurnTimeoutTimer,
} from './auction-turn.service.js';

/**
 * Reloaded-state recovery for a released UI gate whose dispatch failed.
 * The phase hint scopes the retry to the gate that scheduled it: if another
 * actor already advanced the match, this is deliberately a no-op.
 */
export async function redriveAuctionAdvanceForState(
  io: QuizballServer,
  state: AuctionMatchState,
  phaseHint: AuctionUiReadyPhase,
): Promise<boolean> {
  if (state.phase === 'finished') return false;

  if (phaseHint === 'reveal') {
    if (state.phase !== 'reveal' || !state.currentRound) return false;
    await advanceAuctionMatchFlowFromRevealGate(io, state, {});
    return true;
  }

  if (phaseHint === 'round') {
    if (state.phase !== 'clue_reveal' || !state.currentRound) return false;
    await scheduleAuctionClueRevealTimer(state);
    return true;
  }

  if (state.phase !== 'bidding' || !state.currentRound?.currentTurnSeatId) {
    return false;
  }

  const round = state.currentRound;
  const currentTurnSeatId = round.currentTurnSeatId;
  if (!currentTurnSeatId) return false;
  const deadlineMs = round.turnEndsAt ? Date.parse(round.turnEndsAt) : Number.NaN;
  if (Number.isFinite(deadlineMs) && deadlineMs <= Date.now()) {
    await runAuctionTurnTimeoutTimer(io, {
      kind: 'auction_turn_timeout',
      matchId: state.matchId,
      roundId: round.roundId,
      expectedTurnSeatId: currentTurnSeatId,
      stateVersion: state.version,
      turnEndsAt: round.turnEndsAt,
    });
  } else {
    await scheduleAuctionTurnTimeoutTimer(state);
    await scheduleAuctionBotActionTimer(state);
  }
  return true;
}

export async function runAuctionAdvanceRetryTimer(
  io: QuizballServer,
  payload: AuctionAdvanceRetryTimerPayload,
): Promise<void> {
  const state = await auctionStateStore.load(payload.matchId);
  if (!state) return;

  const redriven = await redriveAuctionAdvanceForState(io, state, payload.phaseHint);
  if (!redriven) {
    logger.debug(
      {
        matchId: payload.matchId,
        phaseHint: payload.phaseHint,
        currentPhase: state.phase,
        stateVersion: state.version,
      },
      'Auction advance retry ignored after match moved on',
    );
  }
}
