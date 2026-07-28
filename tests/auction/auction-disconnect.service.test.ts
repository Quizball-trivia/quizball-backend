import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

import { createEmptyTeam } from '../../src/modules/auction/auction-rules.js';
import type { AuctionMatchState } from '../../src/modules/auction/auction-match-state.js';
import type { AuctionFootballer, AuctionPlayer } from '../../src/modules/auction/auction.types.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';
import { installAuctionStateStoreMutationMock } from './auction-state-store-mock.js';

const stateStoreMock = vi.hoisted(() => ({
  getActiveMatchIdForUser: vi.fn(),
  load: vi.fn(),
  save: vi.fn(async (state: unknown) => state),
  mutate: vi.fn(),
  clearIndexes: vi.fn(),
  clearUserMatchIndex: vi.fn(async () => undefined),
}));

const schedulerMock = vi.hoisted(() => ({
  scheduleRealtimeTimer: vi.fn(),
  cancelRealtimeTimer: vi.fn(),
}));
const persistenceMock = vi.hoisted(() => ({
  persistFinishedAuctionMatch: vi.fn(async () => ({})),
}));

const redisMock = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    client: {
      isOpen: true,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      incr: vi.fn(async (key: string) => {
        const next = Number(store.get(key) ?? '0') + 1;
        store.set(key, String(next));
        return next;
      }),
      expire: vi.fn(async () => true),
      del: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        keys.forEach((entry) => store.delete(entry));
        return keys.length;
      }),
    },
    store,
    reset: () => store.clear(),
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
    cancelRealtimeTimer: schedulerMock.cancelRealtimeTimer,
  };
});

vi.mock('../../src/realtime/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/redis.js')>();
  return {
    ...actual,
    getRedisClient: () => redisMock.client,
  };
});

vi.mock('../../src/realtime/services/auction-persistence.service.js', () => ({
  persistFinishedAuctionMatch: persistenceMock.persistFinishedAuctionMatch,
}));

const footballer = {
  id: 'footballer-1',
  clueCardId: '11111111-1111-1111-1111-111111111111',
  name: 'Erling Haaland',
  positionGroup: 'FWD',
  trueValue: 180_000_000,
  startingPrice: 30_000_000,
  clues: ['Clue one', 'Clue two', 'Clue three'],
  imageUrl: 'https://img.example/haaland.jpg',
  currentClub: 'Manchester City',
  nationality: 'Norway',
} satisfies AuctionFootballer;

const context = {
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
    locale: 'en',
    seats: [
      seat('seat-human', 'user-1'),
      seat('seat-human-2', 'user-2'),
      seat('seat-bot-a', null, true),
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
      turnOrder: ['seat-human', 'seat-human-2', 'seat-bot-a'],
      currentTurnSeatId: 'seat-human',
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

function createIo(fetchSockets: Array<{ id: string; rooms: Set<string> }> = []) {
  const roomEmit = vi.fn();
  const to = vi.fn(() => ({ emit: roomEmit }));
  const inMock = vi.fn(() => ({ fetchSockets: vi.fn(async () => fetchSockets) }));
  return {
    io: { to, in: inMock } as unknown as QuizballServer,
    to,
    inMock,
    roomEmit,
  };
}

function createSocket(userId = 'user-1') {
  const rooms = new Set<string>();
  return {
    id: 'socket-1',
    rooms,
    data: {
      user: { id: userId },
      matchId: 'match-1',
    },
    emit: vi.fn(),
    join: vi.fn((room: string) => rooms.add(room)),
    leave: vi.fn((room: string) => rooms.delete(room)),
  } as unknown as QuizballSocket & {
    id: string;
    rooms: Set<string>;
    emit: Mock;
    join: Mock;
    data: { user?: { id: string }; lobbyId?: string; matchId?: string };
  };
}

describe('auction disconnect service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.reset();
    installAuctionStateStoreMutationMock(stateStoreMock);
    stateStoreMock.getActiveMatchIdForUser.mockResolvedValue('match-1');
    stateStoreMock.load.mockResolvedValue(biddingState());
    stateStoreMock.save.mockImplementation(async (state: unknown) => state);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-06-20T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pauses and extends the current human turn when their last auction socket disconnects', async () => {
    const { handleAuctionSocketDisconnect, runAuctionDisconnectDebounceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    const { io, roomEmit } = createIo();

    await handleAuctionSocketDisconnect(io, createSocket(), { context });
    await runAuctionDisconnectDebounceTimer(io, {
      kind: 'auction_disconnect_debounce', matchId: 'match-1', userId: 'user-1',
      seatId: 'seat-human', disconnectedAt: '2026-06-20T10:00:00.000Z',
    }, { context });

    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.version).toBe(4);
    // ISSUE 4: the paused turn is parked at the far-future backstop
    // (pauseUntil + 90s), NOT at pauseUntil — so the grace forfeit (10:00:30)
    // always resolves before the turn-timeout can auto-fold.
    expect(saved.currentRound?.turnEndsAt).toBe('2026-06-20T10:02:00.000Z');
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_disconnect_grace',
      'match-1:user-1',
      new Date('2026-06-20T10:00:30.000Z'),
      expect.objectContaining({
        kind: 'auction_disconnect_grace',
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      'match-1:round-1:seat-human',
      new Date('2026-06-20T10:02:00.000Z'),
      expect.objectContaining({
        expectedTurnSeatId: 'seat-human',
        stateVersion: 4,
        turnEndsAt: '2026-06-20T10:02:00.000Z',
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:opponent_disconnected',
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        remainingReconnects: 2,
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:paused',
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        pauseUntil: '2026-06-20T10:00:30.000Z',
        stateVersion: 4,
      })
    );
  });

  it('atomically counts parallel auction disconnects', async () => {
    const { incrementAuctionDisconnectCount } = await import('../../src/realtime/services/auction-disconnect-state.service.js');

    const counts = await Promise.all(Array.from({ length: 20 }, () => (
      incrementAuctionDisconnectCount('match-1', 'user-1')
    )));

    expect(new Set(counts).size).toBe(20);
    expect(redisMock.store.get('auction:reconnect_count:match-1:user-1')).toBe('20');
    expect(redisMock.client.expire).toHaveBeenCalledTimes(20);
  });

  it('does not pause if another socket for the same user is still in the match room', async () => {
    const { handleAuctionSocketDisconnect } = await import('../../src/realtime/services/auction-disconnect.service.js');
    const { io, roomEmit } = createIo([{ id: 'socket-2', rooms: new Set(['match:match-1']) }]);

    await handleAuctionSocketDisconnect(io, createSocket(), { context });

    expect(stateStoreMock.save).not.toHaveBeenCalled();
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalled();
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('arms durable grace when a matched human has no socket at match start', async () => {
    const { armAuctionDisconnectGrace } = await import(
      '../../src/realtime/services/auction-disconnect.service.js'
    );
    const { io } = createIo();

    expect(await armAuctionDisconnectGrace(io, biddingState(), 'user-1')).toBe(true);
    expect(JSON.parse(redisMock.store.get('auction:disconnect:match-1:user-1')!)).toEqual(
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        disconnectCount: 0,
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_disconnect_grace',
      'match-1:user-1',
      expect.any(Date),
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
      })
    );
  });

  it('keeps a replacement socket inside the debounce completely invisible', async () => {
    const { handleAuctionSocketDisconnect, resumeAuctionUserIfDisconnected } = await import('../../src/realtime/services/auction-disconnect.service.js');
    const liveSockets: Array<{ id: string; rooms: Set<string> }> = [];
    const { io, roomEmit } = createIo(liveSockets);
    await handleAuctionSocketDisconnect(io, createSocket(), { context });

    const replacement = createSocket();
    replacement.id = 'socket-2';
    replacement.rooms.add('match:match-1');
    liveSockets.push(replacement);
    await resumeAuctionUserIfDisconnected(io, replacement, biddingState());

    expect(redisMock.store.has('auction:reconnect_count:match-1:user-1')).toBe(false);
    expect(redisMock.store.has('auction:disconnect:match-1:user-1')).toBe(false);
    expect(roomEmit).not.toHaveBeenCalled();
    expect(schedulerMock.cancelRealtimeTimer).toHaveBeenCalledWith('auction_disconnect_grace', 'match-1:user-1');
    expect(schedulerMock.scheduleRealtimeTimer).not.toHaveBeenCalledWith(
      'auction_resume_countdown', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('on reconnect: clears the disconnect marker, cancels grace, and starts a resume countdown', async () => {
    const { resumeAuctionUserIfDisconnected } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const socket = createSocket();
    const { io, roomEmit } = createIo();

    const resumed = await resumeAuctionUserIfDisconnected(io, socket, biddingState());

    expect(resumed).toBe(true);
    // Disconnect marker cleared + grace timer cancelled (no late forfeit).
    expect(redisMock.store.has('auction:disconnect:match-1:user-1')).toBe(false);
    expect(schedulerMock.cancelRealtimeTimer).toHaveBeenCalledWith('auction_disconnect_grace', 'match-1:user-1');
    // Resume countdown scheduled + broadcast; the match stays paused until it ends.
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_resume_countdown',
      'match-1:user-1',
      expect.any(Date),
      expect.objectContaining({ kind: 'auction_resume_countdown', matchId: 'match-1', userId: 'user-1' }),
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:resume_countdown',
      expect.objectContaining({ matchId: 'match-1' }),
    );
    expect(redisMock.store.has('auction:pause:match-1')).toBe(true);
  });

  it('rejoining with a replacement socket clears grace and prevents a stale timer from forfeiting the seat', async () => {
    const { rejoinAuctionMatch } = await import('../../src/realtime/services/auction-realtime.service.js');
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const socket = createSocket();
    socket.data.matchId = undefined;
    const { io } = createIo([socket]);

    expect(await rejoinAuctionMatch(io, socket, 'match-1')).toBe(true);
    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      disconnectCount: 1,
    }, { context });

    expect(outcome).toEqual({ kind: 'noop', reason: 'already_reconnected' });
    expect(redisMock.store.has('auction:disconnect:match-1:user-1')).toBe(false);
    expect(stateStoreMock.save).not.toHaveBeenCalled();
  });

  it('does not forfeit a live match-bound socket when a stale disconnect marker reaches expiry', async () => {
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const socket = createSocket();
    socket.rooms.add('match:match-1');
    const { io } = createIo([socket]);

    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      disconnectCount: 1,
    }, { context }, 'reconnect_limit');

    expect(outcome).toEqual({ kind: 'noop', reason: 'replacement_socket_present' });
    expect(redisMock.store.has('auction:disconnect:match-1:user-1')).toBe(false);
    expect(stateStoreMock.save).not.toHaveBeenCalled();
  });

  it('still forfeits from the provisional durable marker after a restart loses the debounce process', async () => {
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({
      seats: [seat('seat-human', 'user-1'), seat('bot-a', null, true), seat('bot-b', null, true)],
    }));
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1', userId: 'user-1', seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z', disconnectCount: 0,
    }));
    const { io } = createIo();

    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace', matchId: 'match-1', userId: 'user-1',
      seatId: 'seat-human', disconnectCount: 0,
    }, { context });

    expect(outcome.kind).toBe('forfeited');
    expect(persistenceMock.persistFinishedAuctionMatch).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'finished' })
    );
  });

  it('finishes and persists immediately when a voluntary forfeit removes the last live human', async () => {
    const { handleAuctionForfeit } = await import('../../src/realtime/services/auction-disconnect.service.js');
    const onlyHuman = biddingState({
      seats: [seat('seat-human', 'user-1'), seat('bot-a', null, true), seat('bot-b', null, true)],
    });
    stateStoreMock.load.mockResolvedValue(onlyHuman);
    const { io, roomEmit } = createIo();

    await handleAuctionForfeit(io, createSocket(), { context });

    expect(persistenceMock.persistFinishedAuctionMatch).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'finished' })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_finished', expect.objectContaining({ matchId: 'match-1' })
    );
  });

  it('finishes a 3-human match with last_player_standing when the second opponent forfeits', async () => {
    const { logger } = await import('../../src/core/logger.js');
    const info = vi.spyOn(logger, 'info');
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    const first = {
      ...seat('seat-human', 'user-1'),
      isEliminated: true,
      forfeited: true,
    };
    stateStoreMock.load.mockResolvedValue(biddingState({
      seats: [
        first,
        seat('seat-human-2', 'user-2'),
        seat('seat-human-3', 'user-3'),
      ],
      currentRound: {
        ...biddingState().currentRound!,
        turnOrder: ['seat-human-2', 'seat-human-3'],
        currentTurnSeatId: 'seat-human-2',
      },
    }));
    redisMock.store.set('auction:disconnect:match-1:user-2', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-2',
      seatId: 'seat-human-2',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const { io } = createIo();

    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-2',
      seatId: 'seat-human-2',
      disconnectCount: 1,
    }, { context });

    expect(outcome).toEqual(expect.objectContaining({
      kind: 'forfeited',
      finishReason: 'last_player_standing',
      state: expect.objectContaining({
        phase: 'finished',
        rankings: expect.arrayContaining([
          expect.objectContaining({ userId: 'user-3', rank: 1 }),
        ]),
      }),
    }));
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        matchId: 'match-1',
        finishReason: 'last_player_standing',
      }),
      'Auction match finished'
    );
  });

  it('resume countdown elapses: clears the pause and broadcasts auction:resume', async () => {
    const { runAuctionResumeCountdownTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    stateStoreMock.load.mockResolvedValue(biddingState());
    const { io, roomEmit } = createIo();

    await runAuctionResumeCountdownTimer(io, { kind: 'auction_resume_countdown', matchId: 'match-1', userId: 'user-1' });

    expect(redisMock.store.has('auction:pause:match-1')).toBe(false);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:resume',
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        reason: 'reconnected',
      }),
    );
  });

  it('resume countdown re-points the shared pause to another disconnected human', async () => {
    const { runAuctionResumeCountdownTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    redisMock.store.set('auction:disconnect:match-1:user-2', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-2',
      seatId: 'seat-human-2',
      pauseUntil: '2026-06-20T10:00:31.000Z',
      disconnectCount: 1,
    }));
    stateStoreMock.load.mockResolvedValue(biddingState());
    const { io } = createIo();

    await runAuctionResumeCountdownTimer(io, {
      kind: 'auction_resume_countdown',
      matchId: 'match-1',
      userId: 'user-1',
    });

    expect(JSON.parse(redisMock.store.get('auction:pause:match-1')!)).toEqual(
      expect.objectContaining({
        userId: 'user-2',
        seatId: 'seat-human-2',
      })
    );
  });

  it('pauses the match when a player disconnects during clue_reveal (phase-agnostic pause)', async () => {
    const { handleAuctionSocketDisconnect, runAuctionDisconnectDebounceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    stateStoreMock.load.mockResolvedValue(biddingState({ phase: 'clue_reveal' }));
    const { io, roomEmit } = createIo();

    await handleAuctionSocketDisconnect(io, createSocket(), { context });
    await runAuctionDisconnectDebounceTimer(io, {
      kind: 'auction_disconnect_debounce', matchId: 'match-1', userId: 'user-1',
      seatId: 'seat-human', disconnectedAt: '2026-06-20T10:00:00.000Z',
    }, { context });

    // Pause row written (clue/solo timers defer against it) + paused broadcast,
    // without mutating the match state.
    expect(redisMock.store.has('auction:pause:match-1')).toBe(true);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:paused',
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        pauseUntil: '2026-06-20T10:00:30.000Z',
        stateVersion: 3,
      })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_disconnect_grace',
      'match-1:user-1',
      new Date('2026-06-20T10:00:30.000Z'),
      expect.objectContaining({ kind: 'auction_disconnect_grace' })
    );
    expect(stateStoreMock.save).not.toHaveBeenCalled();
  });

  it('re-bases the paused turn to a fresh window when the resume countdown completes', async () => {
    const { runAuctionResumeCountdownTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    // Turn was parked at the pause backstop while the player was gone.
    stateStoreMock.load.mockResolvedValue(biddingState({
      currentRound: {
        ...biddingState().currentRound!,
        turnEndsAt: '2026-06-20T10:02:00.000Z',
      },
    }));
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const { io, roomEmit } = createIo();

    await runAuctionResumeCountdownTimer(io, { kind: 'auction_resume_countdown', matchId: 'match-1', userId: 'user-1' });

    // Fresh opening-turn window from now (10:00:00 + 30s), not the backstop.
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.currentRound?.turnEndsAt).toBe('2026-06-20T10:00:30.000Z');
    expect(redisMock.store.has('auction:pause:match-1')).toBe(false);
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:resume',
      expect.objectContaining({ matchId: 'match-1', userId: 'user-1', reason: 'reconnected' })
    );
    expect(schedulerMock.scheduleRealtimeTimer).toHaveBeenCalledWith(
      'auction_turn_timeout',
      'match-1:round-1:seat-human',
      new Date('2026-06-20T10:00:30.000Z'),
      expect.objectContaining({ turnEndsAt: '2026-06-20T10:00:30.000Z' })
    );
  });

  it('forfeits a still-disconnected seat when grace expires and starts the next turn', async () => {
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const { io, roomEmit } = createIo();

    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      disconnectCount: 1,
    }, { context });

    expect(outcome.kind).toBe('forfeited');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    expect(saved.seats.find((entry) => entry.seatId === 'seat-human')?.isEliminated).toBe(true);
    expect(saved.currentRound?.foldedSeatIds).toContain('seat-human');
    expect(saved.currentRound?.currentTurnSeatId).toBe('seat-human-2');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:player_forfeited',
      expect.objectContaining({
        matchId: 'match-1',
        userId: 'user-1',
        seatId: 'seat-human',
        reason: 'disconnect_timeout',
      })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:turn_started',
      expect.objectContaining({
        currentTurnSeatId: 'seat-human-2',
        stateVersion: 4,
      })
    );
  });

  it("strips a forfeiting high bidder's lead so a quitter can never win the round", async () => {
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    redisMock.store.set('auction:disconnect:match-1:user-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    // user-1 (seat-human) is the current HIGH BIDDER when they drop out.
    stateStoreMock.load.mockResolvedValue(biddingState({
      currentRound: {
        ...biddingState().currentRound!,
        bids: [
          { seatId: 'seat-bot-a', amount: 40_000_000, placedAt: '2026-06-20T09:59:50.000Z' },
          { seatId: 'seat-human', amount: 50_000_000, placedAt: '2026-06-20T09:59:55.000Z' },
        ],
        highestBidderSeatId: 'seat-human',
        highestBid: 50_000_000,
      },
    }));
    const { io } = createIo();

    const outcome = await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      disconnectCount: 1,
    }, { context });

    expect(outcome.kind).toBe('forfeited');
    const saved = (stateStoreMock.save as Mock).mock.calls[0][0] as AuctionMatchState;
    // Leadership recomputed to the best remaining LIVE bid — never the quitter.
    expect(saved.currentRound?.highestBidderSeatId).toBe('seat-bot-a');
    expect(saved.currentRound?.highestBid).toBe(40_000_000);
    expect(saved.currentRound?.winnerSeatId ?? null).not.toBe('seat-human');
  });

  it('keeps the pause protecting a second disconnected player when the first forfeits', async () => {
    const { runAuctionDisconnectGraceTimer } = await import('../../src/realtime/services/auction-disconnect.service.js');
    // Both humans are disconnected; the shared pause row belongs to user-1.
    for (const [userId, seatId] of [['user-1', 'seat-human'], ['user-2', 'seat-human-2']] as const) {
      redisMock.store.set(`auction:disconnect:match-1:${userId}`, JSON.stringify({
        matchId: 'match-1',
        userId,
        seatId,
        pauseUntil: '2026-06-20T10:00:30.000Z',
        disconnectCount: 1,
      }));
    }
    redisMock.store.set('auction:pause:match-1', JSON.stringify({
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      pauseUntil: '2026-06-20T10:00:30.000Z',
      disconnectCount: 1,
    }));
    const { io } = createIo();

    await runAuctionDisconnectGraceTimer(io, {
      kind: 'auction_disconnect_grace',
      matchId: 'match-1',
      userId: 'user-1',
      seatId: 'seat-human',
      disconnectCount: 1,
    }, { context });

    // user-1's forfeit must NOT drop the pause — it re-points to user-2, who is
    // still inside their own grace window.
    const pauseRaw = redisMock.store.get('auction:pause:match-1');
    expect(pauseRaw).toBeTruthy();
    expect(JSON.parse(pauseRaw!).userId).toBe('user-2');
  });
});
