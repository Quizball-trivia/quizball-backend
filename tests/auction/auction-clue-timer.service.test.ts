import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer } from '../../src/modules/auction/auction.types.js';

const stateStoreMock = vi.hoisted(() => ({
  withLock: vi.fn(async (_matchId: string, fn: () => Promise<unknown>) => fn()),
  load: vi.fn(),
  save: vi.fn(async (state: unknown) => state),
}));

const schedulerMock = vi.hoisted(() => ({
  scheduleRealtimeTimer: vi.fn(),
}));

vi.mock('../../src/modules/auction/auction-state.store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/auction-state.store.js')>();
  return {
    ...actual,
    auctionStateStore: stateStoreMock,
  };
});

vi.mock('../../src/realtime/realtime-timer-scheduler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/realtime-timer-scheduler.js')>();
  return {
    ...actual,
    scheduleRealtimeTimer: schedulerMock.scheduleRealtimeTimer,
  };
});

const footballer = {
  id: 'footballer-1',
  clueCardId: '11111111-1111-1111-1111-111111111111',
  name: 'Erling Haaland',
  positionGroup: 'FWD',
  trueValue: 180_000_000,
  startingPrice: 30_000_000,
  clues: [
    'Scored heavily in his first Premier League campaign.',
    'Won the Champions League with a Manchester club.',
    'Represents Norway at international level.',
  ],
  imageUrl: 'https://img.example/haaland.jpg',
  currentClub: 'Manchester City',
  nationality: 'Norway',
} satisfies AuctionFootballer;

const timerContext = {
  now: () => new Date('2026-06-20T10:00:00.000Z'),
};

function seat(seatId: string, userId: string | null, isBot = false): AuctionPlayer {
  return {
    seatId,
    userId,
    displayName: isBot ? `Bot ${seatId}` : `User ${seatId}`,
    isBot,
    budget: 1_000_000_000,
    team: createEmptyTeam('4-3-3'),
    isEliminated: false,
  };
}

function matchState(overrides: Partial<AuctionMatchState> = {}): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 0,
    phase: 'clue_reveal',
    formation: '4-3-3',
    seats: [
      seat('seat-human', 'user-1'),
      seat('seat-bot-a', null, true),
      seat('seat-bot-b', null, true),
    ],
    currentRound: {
      roundId: 'round-1',
      roundIndex: 1,
      positionGroup: 'FWD',
      footballer,
      clueRevealIndex: 0,
      bids: [],
      highestBidderSeatId: null,
      highestBid: 0,
      startingPrice: footballer.startingPrice,
      winnerSeatId: null,
      winningBid: 0,
      revealed: false,
      turnOrder: ['seat-human', 'seat-bot-a', 'seat-bot-b'],
      currentTurnSeatId: null,
      foldedSeatIds: [],
      turnEndsAt: null,
      startedAt: '2026-06-20T10:00:00.000Z',
      updatedAt: '2026-06-20T10:00:00.000Z',
    },
    completedRounds: [],
    soloPick: null,
    usedClueCardIds: [footballer.clueCardId],
    rankings: null,
    createdAt: '2026-06-20T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

function createIo() {
  const roomEmit = vi.fn();
  const to = vi.fn(() => ({ emit: roomEmit }));
  return {
    io: { to } as never,
    to,
    roomEmit,
  };
}

describe('auction clue reveal timers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStoreMock.withLock.mockImplementation(async (_matchId: string, fn: () => Promise<unknown>) => fn());
    stateStoreMock.save.mockImplementation(async (state: unknown) => state);
  });

  it('schedules the next clue reveal through the durable realtime scheduler', async () => {
    const {
      auctionClueRevealTimerKey,
      scheduleAuctionClueRevealTimer,
    } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    const state = matchState();

    await scheduleAuctionClueRevealTimer(state, { now: new Date('2026-06-20T10:00:00.000Z') });

    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_clue_reveal',
      auctionClueRevealTimerKey('match-1', 'round-1', 1),
      new Date('2026-06-20T10:00:02.500Z'),
      {
        kind: 'auction_clue_reveal',
        matchId: 'match-1',
        roundId: 'round-1',
        expectedClueIndex: 1,
        stateVersion: 0,
      }
    );
  });

  it('reveals clue 1, emits a hidden clue payload, and schedules clue 2', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionClueRevealTimer } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    stateStoreMock.load.mockResolvedValue(matchState());

    const outcome = await runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedClueIndex: 1,
      stateVersion: 0,
    }, { context: timerContext });

    expect(outcome.kind).toBe('clue_revealed');
    expect(stateStoreMock.save).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        currentRound: expect.objectContaining({ clueRevealIndex: 1 }),
      }),
      { expectedVersion: 0, now: new Date('2026-06-20T10:00:00.000Z') }
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:clue_revealed',
      expect.objectContaining({
        matchId: 'match-1',
        roundId: 'round-1',
        clueIndex: 1,
        clue: footballer.clues[0],
        stateVersion: 1,
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_clue_reveal',
      'match-1:round-1:2',
      new Date('2026-06-20T10:00:02.500Z'),
      expect.objectContaining({ expectedClueIndex: 2, stateVersion: 1 })
    );

    const payloadText = JSON.stringify(roomEmit.mock.calls);
    expect(payloadText).not.toContain('Erling Haaland');
    expect(payloadText).not.toContain('Manchester City');
    expect(payloadText).not.toContain('180000000');
  });

  it('reveals clue 3, starts bidding, and does not schedule another clue timer', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionClueRevealTimer } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    stateStoreMock.load.mockResolvedValue(matchState({
      version: 2,
      currentRound: {
        ...matchState().currentRound!,
        clueRevealIndex: 2,
      },
    }));

    const outcome = await runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedClueIndex: 3,
      stateVersion: 2,
    }, { context: timerContext });

    expect(outcome.kind).toBe('bidding_started');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.phase).toBe('bidding');
    expect(saved.currentRound?.clueRevealIndex).toBe(3);
    expect(saved.currentRound?.currentTurnSeatId).toBe('seat-human');
    expect(saved.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:30.000Z');
    expect(roomEmit).toHaveBeenCalledWith('auction:clue_revealed', expect.objectContaining({ clueIndex: 3 }));
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:bidding_started',
      expect.objectContaining({
        matchId: 'match-1',
        roundId: 'round-1',
        currentTurnSeatId: 'seat-human',
        turnEndsAt: '2026-06-20T10:00:30.000Z',
        stateVersion: 3,
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:turn_started',
      expect.objectContaining({
        matchId: 'match-1',
        roundId: 'round-1',
        currentTurnSeatId: 'seat-human',
        stateVersion: 3,
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      'match-1:round-1:seat-human',
      new Date('2026-06-20T10:00:30.000Z'),
      expect.objectContaining({
        kind: 'auction_turn_timeout',
        expectedTurnSeatId: 'seat-human',
        stateVersion: 3,
      })
    );

    const payloadText = JSON.stringify(roomEmit.mock.calls);
    expect(payloadText).not.toContain('Erling Haaland');
    expect(payloadText).not.toContain('Manchester City');
    expect(payloadText).not.toContain('180000000');
  });

  it('ignores stale version timers without saving, emitting, or scheduling', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionClueRevealTimer } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    stateStoreMock.load.mockResolvedValue(matchState({ version: 1 }));

    const outcome = await runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedClueIndex: 1,
      stateVersion: 0,
    }, { context: timerContext });

    expect(outcome).toEqual({ kind: 'noop', reason: 'version_mismatch' });
    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
  });

  it('ignores duplicate clue timers idempotently', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionClueRevealTimer } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    stateStoreMock.load.mockResolvedValue(matchState({
      currentRound: {
        ...matchState().currentRound!,
        clueRevealIndex: 1,
      },
    }));

    const outcome = await runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedClueIndex: 1,
      stateVersion: 0,
    }, { context: timerContext });

    expect(outcome).toEqual({ kind: 'noop', reason: 'duplicate_clue_timer' });
    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('ignores stale round timers and missing state', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionClueRevealTimer } = await import('../../src/realtime/services/auction-clue-timer.service.js');
    stateStoreMock.load.mockResolvedValueOnce(matchState());

    await expect(runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'old-round',
      expectedClueIndex: 1,
      stateVersion: 0,
    }, { context: timerContext })).resolves.toEqual({ kind: 'noop', reason: 'round_mismatch' });

    stateStoreMock.load.mockResolvedValueOnce(null);
    await expect(runAuctionClueRevealTimer(io, {
      kind: 'auction_clue_reveal',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedClueIndex: 1,
      stateVersion: 0,
    }, { context: timerContext })).resolves.toEqual({ kind: 'noop', reason: 'missing_state' });

    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
  });
});
