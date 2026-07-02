import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

const stateStoreMock = vi.hoisted(() => ({
  getActiveMatchIdForUser: vi.fn(),
  clearUserMatchIndex: vi.fn(),
  listActiveMatchIds: vi.fn(),
  clearIndexes: vi.fn(),
  load: vi.fn(),
}));

const clueTimerMock = vi.hoisted(() => ({
  scheduleAuctionClueRevealTimer: vi.fn(),
}));

const turnTimerMock = vi.hoisted(() => ({
  scheduleAuctionTurnTimeoutTimer: vi.fn(),
}));

const botTimerMock = vi.hoisted(() => ({
  scheduleAuctionBotActionTimer: vi.fn(),
}));

const matchFlowMock = vi.hoisted(() => ({
  advanceAuctionMatchFlowAfterMutation: vi.fn(async (_io: unknown, state: unknown) => state),
  scheduleAuctionSoloPickTimeoutTimer: vi.fn(),
}));

const disconnectServiceMock = vi.hoisted(() => ({
  handleAuctionSocketDisconnect: vi.fn(),
  buildAuctionRejoinAvailable: vi.fn(),
}));

vi.mock('../../src/modules/auction/auction-state.store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/auction-state.store.js')>();
  return {
    ...actual,
    auctionStateStore: stateStoreMock,
  };
});

vi.mock('../../src/realtime/services/auction-clue-timer.service.js', () => ({
  scheduleAuctionClueRevealTimer: clueTimerMock.scheduleAuctionClueRevealTimer,
}));

vi.mock('../../src/realtime/services/auction-turn.service.js', () => ({
  scheduleAuctionTurnTimeoutTimer: turnTimerMock.scheduleAuctionTurnTimeoutTimer,
}));

vi.mock('../../src/realtime/services/auction-bot.service.js', () => ({
  scheduleAuctionBotActionTimer: botTimerMock.scheduleAuctionBotActionTimer,
}));

vi.mock('../../src/realtime/services/auction-match-flow.service.js', () => ({
  advanceAuctionMatchFlowAfterMutation: matchFlowMock.advanceAuctionMatchFlowAfterMutation,
  scheduleAuctionSoloPickTimeoutTimer: matchFlowMock.scheduleAuctionSoloPickTimeoutTimer,
}));

vi.mock('../../src/realtime/services/auction-disconnect.service.js', () => ({
  handleAuctionSocketDisconnect: disconnectServiceMock.handleAuctionSocketDisconnect,
  buildAuctionRejoinAvailable: disconnectServiceMock.buildAuctionRejoinAvailable,
}));

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

function auctionState(overrides: Partial<AuctionMatchState> = {}): AuctionMatchState {
  return {
    matchId: 'match-1',
    version: 7,
    phase: 'clue_reveal',
    formation: '4-3-3',
    locale: 'en',
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
      clueRevealIndex: 1,
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

function biddingState(currentTurnSeatId = 'seat-human'): AuctionMatchState {
  return auctionState({
    phase: 'bidding',
    currentRound: {
      ...auctionState().currentRound!,
      clueRevealIndex: 3,
      currentTurnSeatId,
      turnEndsAt: '2026-06-20T10:00:30.000Z',
    },
  });
}

function createSocket(userId = 'user-1') {
  return {
    data: { user: { id: userId }, lobbyId: 'lobby-1' },
    join: vi.fn(),
    emit: vi.fn(),
  } as unknown as QuizballSocket & {
    data: { user?: { id: string }; lobbyId?: string; matchId?: string };
    join: Mock;
    emit: Mock;
  };
}

function createIo() {
  return {} as QuizballServer;
}

describe('auction lifecycle service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStoreMock.getActiveMatchIdForUser.mockResolvedValue('match-1');
    stateStoreMock.listActiveMatchIds.mockResolvedValue(['match-1']);
    stateStoreMock.load.mockResolvedValue(auctionState());
  });

  it('rejoins a socket to an active auction match and emits safe hydration state', async () => {
    const { auctionLifecycleService } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    const socket = createSocket();

    const rejoined = await auctionLifecycleService.rejoinActiveAuctionMatchOnConnect(createIo(), socket);

    expect(rejoined).toBe(true);
    expect(socket.data.lobbyId).toBeUndefined();
    expect(socket.data.matchId).toBe('match-1');
    expect(socket.join).toHaveBeenCalledWith('match:match-1');
    expect(socket.emit).toHaveBeenCalledWith(
      'auction:state',
      expect.objectContaining({
        matchId: 'match-1',
        stateVersion: 7,
        state: expect.objectContaining({ matchId: 'match-1', phase: 'clue_reveal' }),
      })
    );
    expect(JSON.stringify((socket.emit as Mock).mock.calls)).not.toContain('Erling Haaland');
    expect(clueTimerMock.scheduleAuctionClueRevealTimer).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', phase: 'clue_reveal' })
    );
  });

  it('clears stale reconnect indexes when state is missing', async () => {
    const { auctionLifecycleService } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    stateStoreMock.load.mockResolvedValue(null);

    const rejoined = await auctionLifecycleService.rejoinActiveAuctionMatchOnConnect(createIo(), createSocket());

    expect(rejoined).toBe(false);
    expect(stateStoreMock.clearIndexes).toHaveBeenCalledWith('match-1');
    expect(stateStoreMock.clearUserMatchIndex).toHaveBeenCalledWith('user-1', 'match-1');
  });

  it('rearms clue, turn, and bot timers based on the active phase', async () => {
    const { ensureAuctionActiveTimers } = await import('../../src/realtime/services/auction-lifecycle.service.js');

    await expect(ensureAuctionActiveTimers(createIo(), auctionState())).resolves.toBe(true);
    expect(clueTimerMock.scheduleAuctionClueRevealTimer).toHaveBeenCalledTimes(1);

    await expect(ensureAuctionActiveTimers(createIo(), biddingState('seat-human'))).resolves.toBe(true);
    expect(turnTimerMock.scheduleAuctionTurnTimeoutTimer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'bidding' })
    );
    expect(botTimerMock.scheduleAuctionBotActionTimer).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'bidding' })
    );

    await expect(ensureAuctionActiveTimers(createIo(), biddingState('seat-bot-a'))).resolves.toBe(true);
    expect(turnTimerMock.scheduleAuctionTurnTimeoutTimer).toHaveBeenCalledTimes(2);
    expect(botTimerMock.scheduleAuctionBotActionTimer).toHaveBeenCalledTimes(2);
  });

  it('handles a disconnect even when the socket lost its match binding (user-index fallback)', async () => {
    const { auctionLifecycleService } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    // Token-refresh flap: the socket re-authenticated but never rebound, so
    // socket.data.matchId is unset. The wrapper must resolve the match via the
    // user→match index instead of silently no-op'ing (which left the match
    // hanging unpaused until Redis TTLs).
    stateStoreMock.load.mockResolvedValue(biddingState());
    const socket = createSocket();
    socket.data.matchId = undefined;

    await auctionLifecycleService.handleAuctionSocketDisconnect(createIo(), socket);

    expect(stateStoreMock.getActiveMatchIdForUser).toHaveBeenCalledWith('user-1');
    expect(disconnectServiceMock.handleAuctionSocketDisconnect).toHaveBeenCalled();
    // Re-arm still runs for the resolved match (bidding phase → turn timer).
    expect(turnTimerMock.scheduleAuctionTurnTimeoutTimer).toHaveBeenCalled();
  });

  it('disconnect stays a no-op when the user has no active match anywhere', async () => {
    const { auctionLifecycleService } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    stateStoreMock.getActiveMatchIdForUser.mockResolvedValue(null);
    const socket = createSocket();
    socket.data.matchId = undefined;

    await auctionLifecycleService.handleAuctionSocketDisconnect(createIo(), socket);

    expect(disconnectServiceMock.handleAuctionSocketDisconnect).not.toHaveBeenCalled();
  });

  it('re-arms the human solo-pick deadline on boot/reconnect', async () => {
    const { ensureAuctionActiveTimers } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    const soloState = auctionState({
      phase: 'solo_pick',
      currentRound: null,
      soloPick: {
        playerSeatId: 'seat-human',
        positionGroup: 'FWD',
        optionA: { type: 'revealed', footballer },
        optionB: { type: 'mystery', footballer, clues: ['clue'] },
        selectedOption: null,
        startedAt: '2026-06-20T10:00:00.000Z',
      },
    });

    await expect(ensureAuctionActiveTimers(createIo(), soloState)).resolves.toBe(true);
    expect(matchFlowMock.scheduleAuctionSoloPickTimeoutTimer).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-1', phase: 'solo_pick' })
    );
  });

  it('re-opens the reveal gate so a match frozen at reveal (restart/crash) advances', async () => {
    const { ensureAuctionActiveTimers } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    // A reveal-phase match with no live gate (gate + ceiling timer lost on
    // restart) must be re-advanced — otherwise it's stuck and ui_ready acks are
    // ignored. With no in-memory gate, the re-arm re-opens it via the flow.
    const revealState = auctionState({ phase: 'reveal' });
    await expect(ensureAuctionActiveTimers(createIo(), revealState)).resolves.toBe(true);
    expect(matchFlowMock.advanceAuctionMatchFlowAfterMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ phase: 'reveal', matchId: 'match-1' }),
    );
  });

  it('rearms active auction timers on boot and cleans finished or missing states', async () => {
    const { auctionLifecycleService } = await import('../../src/realtime/services/auction-lifecycle.service.js');
    const finished = auctionState({ phase: 'finished', rankings: [] });
    stateStoreMock.listActiveMatchIds.mockResolvedValue(['missing-match', 'finished-match', 'active-match']);
    stateStoreMock.load.mockImplementation(async (matchId: string) => {
      if (matchId === 'missing-match') return null;
      if (matchId === 'finished-match') return finished;
      return biddingState();
    });

    const summary = await auctionLifecycleService.rearmActiveAuctionTimersOnBoot(createIo());

    expect(summary).toEqual({
      scanned: 3,
      rearmed: 1,
      finished: 1,
      missing: 1,
      failed: 0,
    });
    expect(stateStoreMock.clearIndexes).toHaveBeenCalledWith('missing-match');
    expect(stateStoreMock.clearIndexes).toHaveBeenCalledWith(finished);
    expect(turnTimerMock.scheduleAuctionTurnTimeoutTimer).toHaveBeenCalledTimes(1);
  });
});
