import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import {
  createInitialAuctionMatch,
  resolveRoundWin,
  startSoloPick,
  type AuctionEngineContext,
} from '../../src/modules/auction/auction-engine.js';
import { AuctionContentUnavailableError } from '../../src/modules/auction/auction.errors.js';
import { createEmptyTeam, needsPosition } from '../../src/modules/auction/auction-rules.js';
import { AUCTION_SQUAD_SIZE, STARTING_BUDGET } from '../../src/modules/auction/auction.constants.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer, PositionGroup } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import { logger } from '../../src/core/logger.js';
import { installAuctionStateStoreMutationMock } from './auction-state-store-mock.js';

const contentServiceMock = vi.hoisted(() => ({
  getRandomPublishedAuctionCard: vi.fn(),
    getSeasonSnapshots: vi.fn(async () => []),
  findRandomPublishedAuctionCard: vi.fn(),
  // Cross-match no-repeat pick used by the round flow. Delegates to
  // findRandomPublishedAuctionCard so existing per-test card scripting (and its
  // rejection cases) keeps driving the flow unchanged.
  findRandomPublishedAuctionCardExcludingSeen: vi.fn(
    (options: unknown) => contentServiceMock.findRandomPublishedAuctionCard(options)
  ),
  getRecentlySeenFootballPlayerIds: vi.fn(async () => [] as string[]),
  recordSeenClueCards: vi.fn(async () => {}),
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
const persistenceMock = vi.hoisted(() => ({
  persistFinishedAuctionMatch: vi.fn(async () => ({})),
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

// Persisting a finished match writes to Postgres — out of scope for this
// in-memory flow test (and there's no DB in the unit env). Stub it out.
vi.mock('../../src/realtime/services/auction-persistence.service.js', () => ({
  // Returns the per-user coin map; {} = no rewards in this in-memory test.
  persistFinishedAuctionMatch: persistenceMock.persistFinishedAuctionMatch,
}));

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
  const team = createEmptyTeam('2-2-2');
  // 7-a-side: seat 0 carries the remainder so the squad's true value sums to
  // exactly totalValue (the other AUCTION_SQUAD_SIZE-1 seats are worth 1 each).
  const values = Array.from({ length: AUCTION_SQUAD_SIZE }, (_, index) => (
    index === 0 ? totalValue - (AUCTION_SQUAD_SIZE - 1) : 1
  ));
  return {
    seatId,
    userId: isBot ? null : `${seatId}-user`,
    displayName: seatId,
    isBot,
    budget: STARTING_BUDGET,
    team: {
      ...team,
      slots: {
        GK: [card(`${seatId}-gk`, 'GK', values[0])],
        DEF: [1, 2].map((index) => card(`${seatId}-def-${index}`, 'DEF', values[index])),
        MID: [3, 4].map((index) => card(`${seatId}-mid-${index}`, 'MID', values[index])),
        FWD: [5, 6].map((index) => card(`${seatId}-fwd-${index}`, 'FWD', values[index])),
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
  contentServiceMock.findRandomPublishedAuctionCard.mockImplementation((options: {
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
    formation: '2-2-2',
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
    contentServiceMock.getRecentlySeenFootballPlayerIds.mockResolvedValue([]);
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

    await acknowledgeAuctionUiReady(io, 'user-1', {
      matchId: 'match-1',
      phase: 'reveal',
      roundId: 'round-current',
      stateVersion: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));

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
    const laterRoundReady = roomEmit.mock.calls
      .filter(([event, payload]) => event === 'auction:waiting_for_ready' && payload.phase === 'round')
      .at(-1)?.[1] as { forceStartsAt: string; serverNow: string };
    expect(Date.parse(laterRoundReady.forceStartsAt) - Date.parse(laterRoundReady.serverNow)).toBeLessThanOrEqual(8_000);
    expect(Date.parse(laterRoundReady.forceStartsAt) - Date.parse(laterRoundReady.serverNow)).toBeGreaterThanOrEqual(7_900);
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();

    await acknowledgeAuctionUiReady(io, 'user-1', {
      matchId: 'match-1',
      phase: 'round',
      roundId: persisted!.currentRound!.roundId,
      stateVersion: 2,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_clue_reveal',
      expect.any(String),
      new Date('2026-06-20T10:00:03.000Z'),
      expect.objectContaining({ kind: 'auction_clue_reveal', stateVersion: 2 })
    );
    expect(contentServiceMock.findRandomPublishedAuctionCard).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'en', excludeClueCardIds: expect.any(Array) })
    );
  });

  it('short-circuits bots-only round advancement through finish and persistence', async () => {
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
    expect(next.phase).toBe('finished');
    expect(persistenceMock.persistFinishedAuctionMatch).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'finished' })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_finished', expect.objectContaining({ matchId: 'match-1' })
    );
  });

  it('excludes each human participant cross-match history from the round card pick', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io } = createIo();
    mockContentFromPool(fixturePool());
    contentServiceMock.getRecentlySeenFootballPlayerIds.mockResolvedValue([
      'seen-player-1',
      'seen-player-2',
    ]);

    persisted = { ...startInitialState(), version: 1 };
    await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    // Bots are never tracked — only the seated human's id is looked up.
    expect(contentServiceMock.getRecentlySeenFootballPlayerIds).toHaveBeenCalledWith(['user-1']);
    expect(contentServiceMock.findRandomPublishedAuctionCardExcludingSeen).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeRecentlySeenFootballPlayerIds: ['seen-player-1', 'seen-player-2'],
      })
    );
  });

  it('records the started round card as seen for humans only', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io } = createIo();
    mockContentFromPool(fixturePool());

    persisted = { ...startInitialState(), version: 1 };
    const next = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    const startedClueCardId = next.currentRound?.footballer.clueCardId;
    expect(startedClueCardId).toBeTruthy();
    expect(contentServiceMock.recordSeenClueCards).toHaveBeenCalledWith(['user-1'], [startedClueCardId]);
  });

  it('starts the round anyway when the history lookup fails', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io } = createIo();
    mockContentFromPool(fixturePool());
    contentServiceMock.getRecentlySeenFootballPlayerIds.mockRejectedValue(
      new Error('history query failed')
    );

    persisted = { ...startInitialState(), version: 1 };
    const next = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    // Best-effort: history is a freshness optimization, never a round blocker.
    expect(next.phase).toBe('clue_reveal');
    expect(next.currentRound).toBeTruthy();
    expect(contentServiceMock.findRandomPublishedAuctionCardExcludingSeen).toHaveBeenCalledWith(
      expect.objectContaining({ excludeRecentlySeenFootballPlayerIds: undefined })
    );
  });

  it('starts the round anyway when recording seen cards fails', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io } = createIo();
    mockContentFromPool(fixturePool());
    contentServiceMock.recordSeenClueCards.mockRejectedValue(new Error('history write failed'));

    persisted = { ...startInitialState(), version: 1 };
    const next = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    expect(next.phase).toBe('clue_reveal');
    expect(next.currentRound).toBeTruthy();
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
    for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
    await vi.runOnlyPendingTimersAsync();
    for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();

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
        await acknowledgeAuctionUiReady(io, 'user-1', {
          matchId: persisted.matchId,
          phase: 'round',
          roundId: persisted.currentRound!.roundId,
          stateVersion: persisted.version,
        });
        await new Promise((resolve) => setImmediate(resolve));
        persisted = resolveCurrentRoundForFirstNeeder(persisted);
        persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });
        continue;
      }

      if (persisted.phase === 'reveal' && persisted.currentRound) {
        await acknowledgeAuctionUiReady(io, 'user-1', {
          matchId: persisted.matchId,
          phase: 'reveal',
          roundId: persisted.currentRound.roundId,
          stateVersion: persisted.version,
        });
        await new Promise((resolve) => setImmediate(resolve));
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
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);
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

  it('arms a durable deadline for a human solo pick and auto-selects the default on expiry', async () => {
    const { emitAuctionStepStarted, runAuctionSoloPickTimeoutTimer } =
      await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);
    persisted = startSoloPick(
      startInitialState(),
      'seat-human',
      'FWD',
      card('solo-option-a', 'FWD', 40_000_000),
      card('solo-option-b', 'FWD', 45_000_000),
      context
    );
    const startedAt = persisted.soloPick!.startedAt;

    // Human pick: no instant auto-select, but the durable deadline is armed.
    await emitAuctionStepStarted(io, persisted, { context });
    expect(roomEmit).not.toHaveBeenCalledWith('auction:solo_pick_selected', expect.anything());
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_solo_pick_timeout',
      'match-1',
      expect.any(Date),
      expect.objectContaining({
        kind: 'auction_solo_pick_timeout',
        matchId: 'match-1',
        seatId: 'seat-human',
        startedAt,
      })
    );

    // Deadline elapses with no selection → default option applied (bot default).
    await runAuctionSoloPickTimeoutTimer(io, {
      kind: 'auction_solo_pick_timeout',
      matchId: 'match-1',
      seatId: 'seat-human',
      startedAt,
    }, { context });

    expect(roomEmit).toHaveBeenCalledWith(
      'auction:solo_pick_selected',
      expect.objectContaining({ matchId: 'match-1', seatId: 'seat-human', option: 'B' })
    );
  });

  it('serializes a human solo-pick selection racing the timeout auto-selection', async () => {
    const {
      handleAuctionSoloPickSelection,
      handleAuctionSoloPickSelectionForUser,
    } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);
    persisted = startSoloPick(
      startInitialState(),
      'seat-human',
      'FWD',
      card('solo-option-a', 'FWD', 40_000_000),
      card('solo-option-b', 'FWD', 45_000_000),
      context
    );
    const staleState = persisted;
    let mutationTail = Promise.resolve();
    stateStoreMock.mutate.mockImplementation(async (
      _matchId: string,
      mutator: (current: AuctionMatchState) => unknown,
      options: { now?: Date | (() => Date) } = {}
    ) => {
      const previous = mutationTail;
      let release!: () => void;
      mutationTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const current = structuredClone(persisted!);
        const mutation = await mutator(current) as AuctionMatchState | {
          kind: 'save';
          state: AuctionMatchState;
          map: (saved: AuctionMatchState) => unknown;
        } | { kind: 'skip'; result: unknown };
        if ('kind' in mutation && mutation.kind === 'skip') return mutation.result;
        const next = 'kind' in mutation ? mutation.state : mutation;
        const saved = {
          ...next,
          version: current.version + 1,
          updatedAt: (typeof options.now === 'function' ? options.now() : options.now ?? context.now()).toISOString(),
        };
        persisted = saved;
        return 'kind' in mutation ? mutation.map(saved) : saved;
      } finally {
        release();
      }
    });

    const results = await Promise.allSettled([
      handleAuctionSoloPickSelectionForUser(io, 'match-1', 'user-1', 'A', { context }),
      handleAuctionSoloPickSelection(io, staleState, 'seat-human', 'B', { context }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(roomEmit.mock.calls.filter(([event]) => event === 'auction:solo_pick_selected')).toHaveLength(1);
    expect(persisted?.version).toBeGreaterThan(staleState.version);
    expect(stateStoreMock.mutate).toHaveBeenCalledTimes(3);
  });

  it('solo-pick timeout no-ops for a stale timer (pick already resolved or superseded)', async () => {
    const { runAuctionSoloPickTimeoutTimer } =
      await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    persisted = startSoloPick(
      startInitialState(),
      'seat-human',
      'FWD',
      card('solo-option-a', 'FWD', 40_000_000),
      card('solo-option-b', 'FWD', 45_000_000),
      context
    );
    persisted = {
      ...persisted,
      soloPick: { ...persisted.soloPick!, selectedOption: 'A' },
    };

    await runAuctionSoloPickTimeoutTimer(io, {
      kind: 'auction_solo_pick_timeout',
      matchId: 'match-1',
      seatId: 'seat-human',
      startedAt: persisted.soloPick!.startedAt,
    }, { context });

    expect(roomEmit).not.toHaveBeenCalledWith('auction:solo_pick_selected', expect.anything());
  });

  it('ranks complete teams above incomplete teams in the final event payload', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);
    const finishLog = vi.spyOn(logger, 'info');
    persisted = {
      ...startInitialState(),
      phase: 'created',
      seats: [
        {
          ...startInitialState().seats[0],
          seatId: 'incomplete',
          team: {
            ...createEmptyTeam('2-2-2'),
            slots: { ...createEmptyTeam('2-2-2').slots, FWD: [card('goat', 'FWD', 500_000_000)] },
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
    expect(finishLog).toHaveBeenCalledWith(
      { matchId: 'match-1', finishReason: 'no_more_content' },
      'Auction match finished'
    );
  });

  it('emits AP per userId in the match_finished payload', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);

    const winner = completeTeamPlayer('complete-high', 200_000_000);
    const runnerUp = completeTeamPlayer('complete-low', 100_000_000);
    persisted = {
      ...startInitialState(),
      phase: 'created',
      seats: [runnerUp, winner],
    };

    // Persistence resolves the AP awards; the flow layer passes them through
    // keyed by userId, mirroring coinsByUserId.
    persistenceMock.persistFinishedAuctionMatch.mockResolvedValueOnce({
      coinsByUserId: { [winner.userId!]: 500, [runnerUp.userId!]: 300 },
      apByUserId: { [winner.userId!]: 50, [runnerUp.userId!]: 30 },
    } as never);

    persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    expect(persisted.phase).toBe('finished');
    const payload = roomEmit.mock.calls.find(([event]) => event === 'auction:match_finished')?.[1] as {
      apByUserId?: Record<string, number>;
    };
    expect(payload.apByUserId).toEqual({
      [winner.userId!]: 50,
      [runnerUp.userId!]: 30,
    });
  });

  it('omits apByUserId entirely for a friendly match', async () => {
    const { advanceAuctionMatchFlowAfterMutation } = await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    contentServiceMock.findRandomPublishedAuctionCard.mockResolvedValue(null);

    persisted = {
      ...startInitialState(),
      phase: 'created',
      seats: [
        completeTeamPlayer('complete-low', 100_000_000),
        completeTeamPlayer('complete-high', 200_000_000, true),
      ],
    };

    // A friendly/lobby match: persistence reports no AP map at all.
    persistenceMock.persistFinishedAuctionMatch.mockResolvedValueOnce({
      coinsByUserId: {},
    } as never);

    persisted = await advanceAuctionMatchFlowAfterMutation(io, persisted, { context });

    const payload = roomEmit.mock.calls.find(([event]) => event === 'auction:match_finished')?.[1] as {
      apByUserId?: Record<string, number>;
    };
    // Absent (not an empty object) so the client hides AP for friendlies.
    expect(payload.apByUserId).toBeUndefined();
  });

  it('retries transient content failures and leaves the match recoverable instead of finishing', async () => {
    vi.useFakeTimers();
    const { advanceAuctionMatchFlowAfterMutation } =
      await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io, roomEmit } = createIo();
    const transient = new AuctionContentUnavailableError({ source: 'temporary_db_failure' });
    contentServiceMock.findRandomPublishedAuctionCard.mockRejectedValue(transient);
    persisted = {
      ...startInitialState(),
      phase: 'created',
      version: 4,
    };
    const before = structuredClone(persisted);

    const advancing = advanceAuctionMatchFlowAfterMutation(io, persisted, { context });
    const rejected = expect(advancing).rejects.toBe(transient);
    await vi.advanceTimersByTimeAsync(250);

    await rejected;
    expect(contentServiceMock.findRandomPublishedAuctionCard).toHaveBeenCalledTimes(3);
    expect(persisted).toEqual(before);
    expect(roomEmit).not.toHaveBeenCalledWith('auction:match_finished', expect.anything());
  });

  it('retries transient database connection failures before leaving reveal recoverable', async () => {
    vi.useFakeTimers();
    const { advanceAuctionMatchFlowFromRevealGate } =
      await import('../../src/realtime/services/auction-match-flow.service.js');
    const { io } = createIo();
    const transient = Object.assign(new Error('getaddrinfo ENOTFOUND db.example'), {
      code: 'ENOTFOUND',
    });
    contentServiceMock.findRandomPublishedAuctionCard.mockRejectedValue(transient);
    const initial = startInitialState();
    persisted = {
      ...initial,
      phase: 'reveal',
      version: 4,
      currentRound: {
        roundId: 'round-current',
        roundIndex: 1,
        positionGroup: 'FWD',
        footballer: card('current', 'FWD'),
        clueRevealIndex: 3,
        bids: [],
        highestBidderSeatId: null,
        highestBid: 0,
        startingPrice: 10_000_000,
        winnerSeatId: null,
        winningBid: 0,
        revealed: true,
        turnOrder: ['seat-human'],
        currentTurnSeatId: null,
        foldedSeatIds: [],
        turnEndsAt: null,
        startedAt: '2026-06-20T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    };

    const advancing = advanceAuctionMatchFlowFromRevealGate(io, persisted, { context });
    const rejected = expect(advancing).rejects.toBe(transient);
    await vi.advanceTimersByTimeAsync(250);

    await rejected;
    expect(contentServiceMock.findRandomPublishedAuctionCard).toHaveBeenCalledTimes(3);
    expect(persisted.phase).toBe('reveal');
    expect(persisted.version).toBe(4);
  });

  it('advances persisted reveal state when the durable backstop fires', async () => {
    const { runAuctionAdvanceRetryTimer } =
      await import('../../src/realtime/services/auction-advance-retry.service.js');
    const { io, roomEmit } = createIo();
    mockContentFromPool(fixturePool());
    const initial = startInitialState();
    persisted = {
      ...initial,
      phase: 'reveal',
      version: 4,
      currentRound: {
        roundId: 'round-current',
        roundIndex: 1,
        positionGroup: 'FWD',
        footballer: card('current', 'FWD'),
        clueRevealIndex: 3,
        bids: [],
        highestBidderSeatId: null,
        highestBid: 0,
        startingPrice: 10_000_000,
        winnerSeatId: null,
        winningBid: 0,
        revealed: true,
        turnOrder: ['seat-human'],
        currentTurnSeatId: null,
        foldedSeatIds: [],
        turnEndsAt: null,
        startedAt: '2026-06-20T10:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    };

    await runAuctionAdvanceRetryTimer(io, {
      kind: 'auction_advance_retry',
      matchId: 'match-1',
      phaseHint: 'reveal',
    });

    expect(persisted.phase).toBe('clue_reveal');
    expect(persisted.version).toBe(5);
    expect(persisted.completedRounds).toHaveLength(1);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_started',
      expect.objectContaining({ matchId: 'match-1', stateVersion: 5 }),
    );
  });
});
