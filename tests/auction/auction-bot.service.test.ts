import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

const stateStoreMock = vi.hoisted(() => ({
  withLock: vi.fn(async (_matchId: string, fn: () => Promise<unknown>) => fn()),
  load: vi.fn(),
  save: vi.fn(async (state: unknown) => state),
  clearIndexes: vi.fn(),
}));

const schedulerMock = vi.hoisted(() => ({
  scheduleRealtimeTimer: vi.fn(),
}));

const contentServiceMock = vi.hoisted(() => ({
  getRandomPublishedAuctionCard: vi.fn(),
}));

vi.mock('../../src/modules/auction/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/index.js')>();
  return {
    ...actual,
    auctionContentService: contentServiceMock,
  };
});

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
  random: () => 0,
};

function randomSequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function seat(seatId: string, userId: string | null, isBot = false, budget = 1_000_000_000): AuctionPlayer {
  return {
    seatId,
    userId,
    displayName: isBot ? `Bot ${seatId}` : `User ${seatId}`,
    isBot,
    budget,
    team: createEmptyTeam('4-3-3'),
    isEliminated: false,
  };
}

function biddingState(overrides: Partial<AuctionMatchState> = {}): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 3,
    phase: 'bidding',
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
      clueRevealIndex: 3,
      bids: [],
      highestBidderSeatId: null,
      highestBid: 0,
      startingPrice: footballer.startingPrice,
      winnerSeatId: null,
      winningBid: 0,
      revealed: false,
      turnOrder: ['seat-human', 'seat-bot-a', 'seat-bot-b'],
      currentTurnSeatId: 'seat-bot-a',
      foldedSeatIds: [],
      turnEndsAt: '2026-06-20T10:00:10.000Z',
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
    io: { to } as unknown as QuizballServer,
    to,
    roomEmit,
  };
}

describe('auction bot service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStoreMock.withLock.mockImplementation(async (_matchId: string, fn: () => Promise<unknown>) => fn());
    stateStoreMock.save.mockImplementation(async (state: unknown) => state);
    stateStoreMock.clearIndexes.mockResolvedValue(undefined);
    contentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(null);
  });

  it('schedules bot actions with deterministic think delay', async () => {
    const {
      auctionBotActionTimerKey,
      scheduleAuctionBotActionTimer,
    } = await import('../../src/realtime/services/auction-bot.service.js');

    await scheduleAuctionBotActionTimer(biddingState(), { context: timerContext });

    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_bot_action',
      auctionBotActionTimerKey('match-1', 'round-1', 'seat-bot-a'),
      new Date('2026-06-20T10:00:00.800Z'),
      {
        kind: 'auction_bot_action',
        matchId: 'match-1',
        roundId: 'round-1',
        expectedTurnSeatId: 'seat-bot-a',
        stateVersion: 3,
        turnEndsAt: '2026-06-20T10:00:10.000Z',
      }
    );
  });

  it('bot opener bids if it can afford the starting price', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionBotActionTimer } = await import('../../src/realtime/services/auction-bot.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState());

    const outcome = await runAuctionBotActionTimer(io, {
      kind: 'auction_bot_action',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-bot-a',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:10.000Z',
    }, { context: timerContext });

    expect(outcome.kind).toBe('bot_bid');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.version).toBe(4);
    expect(saved.currentRound?.highestBidderSeatId).toBe('seat-bot-a');
    expect(saved.currentRound?.highestBid).toBe(30_000_000);
    expect(saved.currentRound?.currentTurnSeatId).toBe('seat-bot-b');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:bid_accepted',
      expect.objectContaining({ seatId: 'seat-bot-a', amount: 30_000_000, stateVersion: 4 })
    );

    const payloadText = JSON.stringify(roomEmit.mock.calls);
    expect(payloadText).not.toContain('Erling Haaland');
    expect(payloadText).not.toContain('Manchester City');
    expect(payloadText).not.toContain('180000000');
  });

  it('bot folds when the minimum bid is above willingness', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionBotActionTimer } = await import('../../src/realtime/services/auction-bot.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({
      currentRound: {
        ...biddingState().currentRound!,
        footballer: { ...footballer, trueValue: 100_000_000 },
        bids: [{ seatId: 'seat-human', amount: 100_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-human',
        highestBid: 100_000_000,
      },
    }));

    const outcome = await runAuctionBotActionTimer(io, {
      kind: 'auction_bot_action',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-bot-a',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:10.000Z',
    }, { context: timerContext });

    expect(outcome.kind).toBe('bot_fold');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.currentRound?.foldedSeatIds).toContain('seat-bot-a');
    expect(saved.currentRound?.currentTurnSeatId).toBe('seat-bot-b');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:fold_accepted',
      expect.objectContaining({ seatId: 'seat-bot-a', stateVersion: 4 })
    );
  });

  it('bot bid never exceeds max bid', async () => {
    const { io } = createIo();
    const { runAuctionBotActionTimer } = await import('../../src/realtime/services/auction-bot.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({
      seats: [
        seat('seat-human', 'user-1'),
        seat('seat-bot-a', null, true, 300_000_000),
        seat('seat-bot-b', null, true),
      ],
      currentRound: {
        ...biddingState().currentRound!,
        bids: [{ seatId: 'seat-human', amount: 90_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-human',
        highestBid: 90_000_000,
      },
    }));

    await runAuctionBotActionTimer(io, {
      kind: 'auction_bot_action',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-bot-a',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:10.000Z',
    }, {
      context: {
        now: timerContext.now,
        random: randomSequence([0.999, 0.9, 0.9]),
      },
    });

    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.currentRound?.highestBid).toBe(100_000_000);
    expect(saved.currentRound?.highestBidderSeatId).toBe('seat-bot-a');
  });

  it('ignores stale bot action timers without saving or emitting', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionBotActionTimer } = await import('../../src/realtime/services/auction-bot.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({ version: 4 }));

    const outcome = await runAuctionBotActionTimer(io, {
      kind: 'auction_bot_action',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-bot-a',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:10.000Z',
    }, { context: timerContext });

    expect(outcome).toEqual({ kind: 'noop', reason: 'version_mismatch' });
    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
  });

  it('bot fold can resolve a round won by the human', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionBotActionTimer } = await import('../../src/realtime/services/auction-bot.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({
      currentRound: {
        ...biddingState().currentRound!,
        footballer: { ...footballer, trueValue: 100_000_000 },
        bids: [{ seatId: 'seat-human', amount: 100_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-human',
        highestBid: 100_000_000,
        foldedSeatIds: ['seat-bot-b'],
      },
    }));

    const outcome = await runAuctionBotActionTimer(io, {
      kind: 'auction_bot_action',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-bot-a',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:10.000Z',
    }, { context: timerContext });

    expect(outcome.kind).toBe('bot_fold');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.phase).toBe('reveal');
    expect(saved.currentRound?.winnerSeatId).toBe('seat-human');
    expect(saved.seats.find((player) => player.seatId === 'seat-human')?.team.slots.FWD).toHaveLength(1);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_revealed',
      expect.objectContaining({ winnerSeatId: 'seat-human', winningBid: 100_000_000 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:squad_updated',
      expect.objectContaining({ seatId: 'seat-human', stateVersion: 4 })
    );
  });
});
