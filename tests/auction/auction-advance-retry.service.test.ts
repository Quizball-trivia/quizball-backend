import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const stateStoreMock = vi.hoisted(() => ({
  load: vi.fn(),
}));
const matchFlowMock = vi.hoisted(() => ({
  advanceAuctionMatchFlowFromRevealGate: vi.fn(),
}));
const clueTimerMock = vi.hoisted(() => ({
  scheduleAuctionClueRevealTimer: vi.fn(),
}));
const turnTimerMock = vi.hoisted(() => ({
  runAuctionTurnTimeoutTimer: vi.fn(),
  scheduleAuctionTurnTimeoutTimer: vi.fn(),
}));
const botTimerMock = vi.hoisted(() => ({
  scheduleAuctionBotActionTimer: vi.fn(),
}));

vi.mock('../../src/modules/auction/auction-state.store.js', () => ({
  auctionStateStore: stateStoreMock,
}));
vi.mock('../../src/realtime/services/auction-match-flow.service.js', () => ({
  advanceAuctionMatchFlowFromRevealGate: matchFlowMock.advanceAuctionMatchFlowFromRevealGate,
}));
vi.mock('../../src/realtime/services/auction-clue-timer.service.js', () => ({
  scheduleAuctionClueRevealTimer: clueTimerMock.scheduleAuctionClueRevealTimer,
}));
vi.mock('../../src/realtime/services/auction-turn.service.js', () => ({
  runAuctionTurnTimeoutTimer: turnTimerMock.runAuctionTurnTimeoutTimer,
  scheduleAuctionTurnTimeoutTimer: turnTimerMock.scheduleAuctionTurnTimeoutTimer,
}));
vi.mock('../../src/realtime/services/auction-bot.service.js', () => ({
  scheduleAuctionBotActionTimer: botTimerMock.scheduleAuctionBotActionTimer,
}));

function state(phase: AuctionMatchState['phase']): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 9,
    phase,
    currentRound: phase === 'finished'
      ? null
      : {
        roundId: 'round-1',
        currentTurnSeatId: null,
      },
  } as AuctionMatchState;
}

const io = {} as QuizballServer;
const revealPayload = {
  kind: 'auction_advance_retry' as const,
  matchId: 'match-1',
  phaseHint: 'reveal' as const,
};

describe('auction advance retry service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when the match already advanced beyond the hinted phase', async () => {
    stateStoreMock.load.mockResolvedValue(state('clue_reveal'));
    const { runAuctionAdvanceRetryTimer } =
      await import('../../src/realtime/services/auction-advance-retry.service.js');

    await runAuctionAdvanceRetryTimer(io, revealPayload);

    expect(matchFlowMock.advanceAuctionMatchFlowFromRevealGate).not.toHaveBeenCalled();
    expect(clueTimerMock.scheduleAuctionClueRevealTimer).not.toHaveBeenCalled();
    expect(turnTimerMock.runAuctionTurnTimeoutTimer).not.toHaveBeenCalled();
  });

  it('drives a match that is still stuck at reveal', async () => {
    const revealState = state('reveal');
    stateStoreMock.load.mockResolvedValue(revealState);
    const { runAuctionAdvanceRetryTimer } =
      await import('../../src/realtime/services/auction-advance-retry.service.js');

    await runAuctionAdvanceRetryTimer(io, revealPayload);

    expect(matchFlowMock.advanceAuctionMatchFlowFromRevealGate).toHaveBeenCalledWith(
      io,
      revealState,
      {},
    );
  });
});
