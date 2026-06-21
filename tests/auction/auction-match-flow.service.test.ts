import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import {
  createInitialAuctionMatch,
  resolveRoundWin,
  startSoloPick,
  type AuctionEngineContext,
} from '../../src/modules/auction/auction-engine.js';
import { createEmptyTeam, needsPosition } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer, PositionGroup } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import { installAuctionStateStoreMutationMock } from './auction-state-store-mock.js';

const contentServiceMock = vi.hoisted(() => ({
  getRandomPublishedAuctionCard: vi.fn(),
}));

const stateStoreMock = vi.hoisted(() => ({
  withLock: vi.fn(async (_matchId: string, fn: () => Promise<unknown>) => fn()),
  mutate: vi.fn(),
  load: vi.fn(),
  save: vi.fn(async (state: unknown) => state),
  clearIndexes: vi.fn(),
}));

const schedulerMock = vi.hoisted(() => ({
  scheduleRealtimeTimer: vi.fn(),
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

const context: AuctionEngineContext = {
  now: () => new Date('2026-06-20T10:00:00.000Z'),
  random: () => 0,
  createId: (kind) => `${kind}-${++idCounter}`,
};

let idCounter = 0;
let persisted: AuctionMatchState | null = null;

function createIo() {
  const roomEmit = vi.fn();
  const to = vi.fn(() => ({ emit: roomEmit }));
  return {
    io: { to } as unknown as QuizballServer,
    roomEmit,
  };
}

function card(id: string, positionGroup: PositionGroup, trueValue = 100_000_000): AuctionFootballer {
  return {
    id,
    clueCardId: `${id}-clue`,
    name: `Player ${id}`,
    positionGroup,
    trueValue,
    startingPrice: 10_000_000,
    clues: [`${id} clue 1`, `${id} clue 2`, `${id} clue 3`],
    imageUrl: `https://img.example/${id}.jpg`,
    currentClub: 'QuizBall FC',
    nationality: 'Georgia',
  };
}

function completeTeamPlayer(seatId: string, totalValue: number, isBot = false): AuctionPlayer {
  const team = createEmptyTeam('4-3-3');
  const values = Array.from({ length: 11 }, (_, index) => (
    index === 0 ? totalValue - 10 : 1
  ));
  return {
    seatId,
    userId: isBot ? null : `${seatId}-user`,
    displayName: seatId,
    isBot,
    budget: 1_000_000_000,
    team: {
      ...team,
      slots: {
        GK: [card(`${seatId}-gk`, 'GK', values[0])],
        DEF: [1, 2, 3, 4].map((index) => card(`${seatId}-def-${index}`, 'DEF', values[index])),
        MID: [5, 6, 7].map((index) => card(`${seatId}-mid-${index}`, 'MID', values[index])),
        FWD: [8, 9, 10].map((index) => card(`${seatId}-fwd-${index}`, 'FWD', values[index])),
      },
    },
    isEliminated: false,
  };
}

function fixturePool(): Record<PositionGroup, AuctionFootballer[]> {
  return {
    GK: Array.from({ length: 6 }, (_, index) => card(`gk-${index}`, 'GK', 20_000_000 + index)),
    DEF: Array.from({ length: 15 }, (_, index) => card(`def-${index}`, 'DEF', 30_000_000 + index)),
    MID: Array.from({ length: 15 }, (_, index) => card(`mid-${index}`, 'MID', 40_000_000 + index)),
    FWD: Array.from({ length: 12 }, (_, index) => card(`fwd-${index}`, 'FWD', 50_000_000 + index)),
  };
}

function mockContentFromPool(pool: Record<PositionGroup, AuctionFootballer[]>): void {
  contentServiceMock.getRandomPublishedAuctionCard.mockImplementation((options: {
    positionGroup: PositionGroup;
    excludeClueCardIds?: string[];
  }) => {
    const excluded = new Set(options.excludeClueCardIds ?? []);
    return pool[options.positionGroup].find((item) => !excluded.has(item.clueCardId ?? '')) ?? null;
  });
}

function startInitialState(): AuctionMatchState {
  return createInitialAuctionMatch({
    matchId: 'match-1',
    humanUserId: 'user-1',
    humanDisplayName: 'Human',
    formation: '4-3-3',
    locale: 'en',
    context,
  });
}

function resolveCurrentRoundForFirstNeeder(state: AuctionMatchState): AuctionMatchState {
  if (!state.currentRound) throw new Error('expected current round');
  const winner = state.seats.find((seat) => needsPosition(seat, state.currentRound!.positionGroup));
  if (!winner) throw new Error('expected winner');
  const bidding: AuctionMatchState = {
    ...state,
    phase: 'bidding',
    currentRound: {
      ...state.currentRound,
      clueRevealIndex: state.currentRound.footballer.clues?.length ?? 3,
      currentTurnSeatId: winner.seatId,
      highestBidderSeatId: winner.seatId,
      highestBid: state.currentRound.startingPrice,
      bids: [{
        seatId: winner.seatId,
        amount: state.currentRound.startingPrice,
        placedAt: '2026-06-20T10:00:00.000Z',
      }],
    },
  };
  return {
    ...resolveRoundWin(bidding, context),
    version: state.version + 1,
  };
}

describe('auction match flow service', () => {
  beforeEach(() => {
    idCounter = 0;
    persisted = null;
    vi.clearAllMocks();
    stateStoreMock.withLock.mockImplementation(async (_matchId: string, fn: () => Promise<unknown>) => fn());
    stateStoreMock.load.mockImplementation(async () => persisted);
    installAuctionStateStoreMutationMock(stateStoreMock);
    stateStoreMock.save.mockImplementation(async (state: AuctionMatchState) => {
      persisted = state;
      return state;
    });
    stateStoreMock.clearIndexes.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for reveal ui-ready before starting the next published-content round', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { acknowledgeAuctionUiReady } = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const { io, roomEmit } = createIo();
    const pool = fixturePool();
    mockContentFromPool(pool);

    const state = startInitialState();
    persisted = {
      ...state,
      phase: 'reveal',
      version: 1,
      currentRound: {
        roundId: 'round-current',
        roundIndex: 1,
        positionGroup: 'FWD',
        footballer: card('current', 'FWD', 60_000_000),
        clueRevealIndex: 3,
        bids: [{ seatId: 'seat-human', amount: 10_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-human',
        highestBid: 10_000_000,
        startingPrice: 10_000_000,
        winnerSeatId: 'seat-human',
        winningBid: 10_000_000,
        revealed: true,
        turnOrder: ['seat-human'],
        currentTurnSeatId: null,
        foldedSeatIds: [],
        turnEndsAt: null,
        startedAt: '2026-06-20T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    };

    const next = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    expect(next.phase).toBe('reveal');
    expect(next.version).toBe(1);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_revealed',
      expect.objectContaining({ winnerSeatId: 'seat-human', stateVersion: 1 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:waiting_for_ready',
      expect.objectContaining({
        matchId: 'match-1',
        phase: 'reveal',
        roundId: 'round-current',
        stateVersion: 1,
        totalCount: 1,
        waitingUserIds: ['user-1'],
      })
    );
    expect(roomEmit).not.toHaveBeenCalledWith(
      'auction:round_started',
      expect.anything()
    );

    acknowledgeAuctionUiReady(io, 'user-1', {
      matchId: 'match-1',
      phase: 'reveal',
      roundId: 'round-current',
      stateVersion: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persisted?.phase).toBe('clue_reveal');
    expect(persisted?.version).toBe(2);
    expect(persisted?.completedRounds).toHaveLength(1);
    expect(persisted?.currentRound?.footballer.positionGroup).toBeDefined();
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_started',
      expect.objectContaining({ matchId: 'match-1', stateVersion: 2 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:waiting_for_ready',
      expect.objectContaining({
        matchId: 'match-1',
        phase: 'round',
        stateVersion: 2,
        totalCount: 1,
        waitingUserIds: ['user-1'],
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();

    acknowledgeAuctionUiReady(io, 'user-1', {
      matchId: 'match-1',
      phase: 'round',
      roundId: persisted!.currentRound!.roundId,
      stateVersion: 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_clue_reveal',
      expect.any(String),
      new Date('2026-06-20T10:00:02.500Z'),
      expect.objectContaining({ kind: 'auction_clue_reveal', stateVersion: 2 })
    );
    expect(contentServiceMock.getRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'en', excludeClueCardIds: expect.any(Array) })
    );
  });

  it('does not stall a bots-only reveal gate', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    mockContentFromPool(fixturePool());

    const state = startInitialState();
    persisted = {
      ...state,
      seats: state.seats.map((seat) => ({
        ...seat,
        userId: null,
        isBot: true,
      })),
      phase: 'reveal',
      version: 1,
      currentRound: {
        roundId: 'round-current',
        roundIndex: 1,
        positionGroup: 'FWD',
        footballer: card('current', 'FWD', 60_000_000),
        clueRevealIndex: 3,
        bids: [{ seatId: 'bot-seat-1', amount: 10_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'bot-seat-1',
        highestBid: 10_000_000,
        startingPrice: 10_000_000,
        winnerSeatId: 'bot-seat-1',
        winningBid: 10_000_000,
        revealed: true,
        turnOrder: ['bot-seat-1'],
        currentTurnSeatId: null,
        foldedSeatIds: [],
        turnEndsAt: null,
        startedAt: '2026-06-20T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    };

    const next = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });
    expect(next.phase).toBe('reveal');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(persisted?.phase).toBe('clue_reveal');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_revealed',
      expect.objectContaining({ winnerSeatId: 'bot-seat-1', stateVersion: 1 })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_started',
      expect.objectContaining({ matchId: 'match-1', stateVersion: 2 })
    );
  });

  it('advances reveal on the force-ready fallback when a human never acks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));

    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    mockContentFromPool(fixturePool());

    const state = startInitialState();
    persisted = {
      ...state,
      phase: 'reveal',
      version: 1,
      currentRound: {
        roundId: 'round-current',
        roundIndex: 1,
        positionGroup: 'FWD',
        footballer: card('current', 'FWD', 60_000_000),
        clueRevealIndex: 3,
        bids: [{ seatId: 'seat-human', amount: 10_000_000, placedAt: '2026-06-20T10:00:00.000Z' }],
        highestBidderSeatId: 'seat-human',
        highestBid: 10_000_000,
        startingPrice: 10_000_000,
        winnerSeatId: 'seat-human',
        winningBid: 10_000_000,
        revealed: true,
        turnOrder: ['seat-human'],
        currentTurnSeatId: null,
        foldedSeatIds: [],
        turnEndsAt: null,
        startedAt: '2026-06-20T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    };

    await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    expect(roomEmit).toHaveBeenCalledWith(
      'auction:waiting_for_ready',
      expect.objectContaining({
        phase: 'reveal',
        forceStartsAt: '2026-06-20T10:00:06.000Z',
      })
    );
    expect(persisted?.phase).toBe('reveal');

    await vi.advanceTimersByTimeAsync(6_000);

    expect(persisted?.phase).toBe('clue_reveal');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_started',
      expect.objectContaining({ matchId: 'match-1', stateVersion: 2 })
    );
  });

  it('can drive an AI auction match to a final ranking with enough fixture cards', async () => {
    const {
      advanceAuctionMatchFlowAfterMutation,
      handleAuctionSoloPickSelection,
    } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { acknowledgeAuctionUiReady } = await import('../../src/realtime/services/auction-ui-ready.service.js');
    const { io, roomEmit } = createIo();
    mockContentFromPool(fixturePool());
    persisted = startInitialState();

    for (let step = 0; step < 80 && persisted.phase !== 'finished'; step++) {
      if (persisted.phase === 'created') {
        persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });
        continue;
      }

      if (persisted.phase === 'clue_reveal') {
        acknowledgeAuctionUiReady(io, 'user-1', {
          matchId: persisted.matchId,
          phase: 'round',
          roundId: persisted.currentRound!.roundId,
          stateVersion: persisted.version,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        persisted = resolveCurrentRoundForFirstNeeder(persisted);
        persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });
        continue;
      }

      if (persisted.phase === 'reveal' && persisted.currentRound) {
        acknowledgeAuctionUiReady(io, 'user-1', {
          matchId: persisted.matchId,
          phase: 'reveal',
          roundId: persisted.currentRound.roundId,
          stateVersion: persisted.version,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }

      if (persisted.phase === 'solo_pick' && persisted.soloPick) {
        persisted = await handleAuctionSoloPickSelection(
          io,
          persisted,
          persisted.soloPick.playerSeatId,
          'A',
          { context }
        );
      }
    }

    expect(persisted.phase).toBe('finished');
    expect(persisted.rankings).toHaveLength(3);
    expect(persisted.rankings?.every((rank) => rank.isComplete)).toBe(true);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_finished',
      expect.objectContaining({
        matchId: 'match-1',
        rankings: expect.any(Array),
        winnerSeatId: expect.any(String),
      })
    );
    expect(stateStoreMock.clearIndexes).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', phase: 'finished' })
    );
  });

  it('returns the latest persisted state after a bot solo-pick auto-selection', async () => {
    const { emitAuctionStepStarted } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(null);
    const initial = startInitialState();
    persisted = startSoloPick(
      initial,
      'bot-seat-1',
      'FWD',
      card('solo-option-a', 'FWD', 40_000_000),
      card('solo-option-b', 'FWD', 45_000_000),
      context
    );
    const soloPickVersion = persisted.version;

    const latest = await emitAuctionStepStarted(io, persisted, { context });

    expect(latest.phase).toBe('finished');
    expect(latest.version).toBe(soloPickVersion + 2);
    expect(latest.seats.find((seat) => seat.seatId === 'bot-seat-1')?.team.slots.FWD).toEqual([
      expect.objectContaining({ id: 'solo-option-b' }),
    ]);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:solo_pick_started',
      expect.objectContaining({ matchId: 'match-1', stateVersion: soloPickVersion })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:solo_pick_selected',
      expect.objectContaining({ matchId: 'match-1', seatId: 'bot-seat-1', option: 'B' })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_finished',
      expect.objectContaining({ matchId: 'match-1', stateVersion: latest.version })
    );
  });

  it('ranks complete teams above incomplete teams in the final event payload', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(null);
    persisted = {
      ...startInitialState(),
      phase: 'created',
      seats: [
        {
          ...startInitialState().seats[0],
          seatId: 'incomplete',
          team: {
            ...createEmptyTeam('4-3-3'),
            slots: { ...createEmptyTeam('4-3-3').slots, FWD: [card('goat', 'FWD', 500_000_000)] },
          },
        },
        completeTeamPlayer('complete-low', 100_000_000),
        completeTeamPlayer('complete-high', 200_000_000, true),
      ],
    };

    persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    expect(persisted.phase).toBe('finished');
    expect(persisted.rankings?.map((rank) => rank.seatId)).toEqual([
      'complete-high',
      'complete-low',
      'incomplete',
    ]);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_finished',
      expect.objectContaining({
        rankings: expect.arrayContaining([
          expect.objectContaining({ seatId: 'complete-high', rank: 1 }),
        ]),
      })
    );
  });
});
