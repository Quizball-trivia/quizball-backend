import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

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
      currentTurnSeatId: 'seat-human',
      foldedSeatIds: [],
      turnEndsAt: '2026-06-20T10:00:30.000Z',
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

function createSocket(userId = 'user-1') {
  return {
    data: { user: { id: userId }, matchId: 'match-1' },
    emit: vi.fn(),
  } as unknown as QuizballSocket & {
    emit: Mock;
    data: { user?: { id: string }; matchId?: string };
  };
}

describe('auction turn service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStoreMock.withLock.mockImplementation(async (_matchId: string, fn: () => Promise<unknown>) => fn());
    stateStoreMock.save.mockImplementation(async (state: unknown) => state);
    stateStoreMock.clearIndexes.mockResolvedValue(undefined);
    contentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(null);
  });

  it('schedules turn timeouts through the durable realtime scheduler', async () => {
    const {
      auctionTurnTimeoutTimerKey,
      scheduleAuctionTurnTimeoutTimer,
    } = await import('../../src/realtime/services/auction-turn.service.js');

    await scheduleAuctionTurnTimeoutTimer(biddingState());

    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      auctionTurnTimeoutTimerKey('match-1', 'round-1', 'seat-human'),
      new Date('2026-06-20T10:00:30.000Z'),
      {
        kind: 'auction_turn_timeout',
        matchId: 'match-1',
        roundId: 'round-1',
        expectedTurnSeatId: 'seat-human',
        stateVersion: 3,
        turnEndsAt: '2026-06-20T10:00:30.000Z',
      }
    );
  });

  it('accepts a human bid, emits hidden bid payload, starts the next turn, and schedules timeout', async () => {
    const { io, roomEmit } = createIo();
    const socket = createSocket();
    const { handleAuctionBid } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState());

    const outcome = await handleAuctionBid(io, socket, {
      matchId: 'match-1',
      amount: 30_000_000,
    }, { context: timerContext });

    expect(outcome?.kind).toBe('bid_accepted');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.version).toBe(4);
    expect(saved.currentRound?.highestBidderSeatId).toBe('seat-human');
    expect(saved.currentRound?.highestBid).toBe(30_000_000);
    expect(saved.currentRound?.currentTurnSeatId).toBe('seat-bot-a');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:bid_accepted',
      expect.objectContaining({
        matchId: 'match-1',
        roundId: 'round-1',
        seatId: 'seat-human',
        amount: 30_000_000,
        stateVersion: 4,
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:turn_started',
      expect.objectContaining({
        currentTurnSeatId: 'seat-bot-a',
        minBid: 35_000_000,
        stateVersion: 4,
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      'match-1:round-1:seat-bot-a',
      new Date('2026-06-20T10:00:10.000Z'),
      expect.objectContaining({ expectedTurnSeatId: 'seat-bot-a', stateVersion: 4 })
    );

    const payloadText = JSON.stringify(roomEmit.mock.calls);
    expect(payloadText).not.toContain('Erling Haaland');
    expect(payloadText).not.toContain('Manchester City');
    expect(payloadText).not.toContain('180000000');
  });

  it('rejects invalid human bids without saving', async () => {
    const { io } = createIo();
    const socket = createSocket();
    const { handleAuctionBid } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState());

    await handleAuctionBid(io, socket, {
      matchId: 'match-1',
      amount: 29_999_999,
    }, { context: timerContext });

    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'auction_invalid_action',
      message: 'Invalid auction bid',
    });
  });

  it('rejects opener fold without saving', async () => {
    const { io } = createIo();
    const socket = createSocket();
    const { handleAuctionFold } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState());

    await handleAuctionFold(io, socket, { matchId: 'match-1' }, { context: timerContext });

    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'auction_opening_bidder_cannot_fold',
      message: 'Opening bidder cannot fold',
      meta: undefined,
    });
  });

  it('accepts a human fold and reveals the round only after resolution', async () => {
    const { io, roomEmit } = createIo();
    const socket = createSocket();
    const { handleAuctionFold } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({
      currentRound: {
        ...biddingState().currentRound!,
        bids: [{ seatId: 'seat-bot-a', amount: 30_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-bot-a',
        highestBid: 30_000_000,
        currentTurnSeatId: 'seat-human',
        foldedSeatIds: ['seat-bot-b'],
        turnEndsAt: '2026-06-20T10:00:10.000Z',
      },
    }));

    const outcome = await handleAuctionFold(io, socket, { matchId: 'match-1' }, { context: timerContext });

    expect(outcome?.kind).toBe('fold_accepted');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.phase).toBe('reveal');
    expect(saved.currentRound?.revealed).toBe(true);
    expect(saved.currentRound?.winnerSeatId).toBe('seat-bot-a');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:fold_accepted',
      expect.objectContaining({ seatId: 'seat-human', stateVersion: 4 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_revealed',
      expect.objectContaining({ winnerSeatId: 'seat-bot-a', winningBid: 30_000_000 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:squad_updated',
      expect.objectContaining({ seatId: 'seat-bot-a', stateVersion: 4 })
    );

    const payloadText = JSON.stringify(roomEmit.mock.calls);
    expect(payloadText).toContain('Erling Haaland');
    expect(payloadText).toContain('180000000');
  });

  it('auto-bids for opener timeout and schedules the next turn', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionTurnTimeoutTimer } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState());

    const outcome = await runAuctionTurnTimeoutTimer(io, {
      kind: 'auction_turn_timeout',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-human',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:30.000Z',
    }, { context: timerContext });

    expect(outcome.kind).toBe('turn_timeout');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:turn_timeout',
      expect.objectContaining({
        seatId: 'seat-human',
        action: 'bid',
        amount: 30_000_000,
        stateVersion: 4,
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:turn_started',
      expect.objectContaining({ currentTurnSeatId: 'seat-bot-a', stateVersion: 4 })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      'match-1:round-1:seat-bot-a',
      new Date('2026-06-20T10:00:10.000Z'),
      expect.objectContaining({ expectedTurnSeatId: 'seat-bot-a', stateVersion: 4 })
    );
  });

  it('ignores stale turn timeout timers without saving or emitting', async () => {
    const { io, roomEmit } = createIo();
    const { runAuctionTurnTimeoutTimer } = await import('../../src/realtime/services/auction-turn.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({ version: 4 }));

    const outcome = await runAuctionTurnTimeoutTimer(io, {
      kind: 'auction_turn_timeout',
      matchId: 'match-1',
      roundId: 'round-1',
      expectedTurnSeatId: 'seat-human',
      stateVersion: 3,
      turnEndsAt: '2026-06-20T10:00:30.000Z',
    }, { context: timerContext });

    expect(outcome).toEqual({ kind: 'noop', reason: 'version_mismatch' });
    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
  });

  it('does not double-apply duplicate human bids', async () => {
    const { io } = createIo();
    const socket = createSocket();
    const { handleAuctionBid } = await import('../../src/realtime/services/auction-turn.service.js');
    let persisted = biddingState();
    stateStoreMock.load.mockImplementation(async () => persisted);
    stateStoreMock.save.mockImplementation(async (state: AuctionMatchState) => {
      persisted = state;
      return state;
    });

    await handleAuctionBid(io, socket, { matchId: 'match-1', amount: 30_000_000 }, { context: timerContext });
    await handleAuctionBid(io, socket, { matchId: 'match-1', amount: 30_000_000 }, { context: timerContext });

    expect(stateStoreMock.save).toHaveBeenCalledTimes(1);
    expect(persisted.currentRound?.bids).toHaveLength(1);
    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'auction_not_current_turn',
      message: 'Not this seat turn',
      meta: undefined,
    });
  });
});
