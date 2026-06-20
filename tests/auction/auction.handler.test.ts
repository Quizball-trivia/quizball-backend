import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

const auctionRealtimeServiceMock = vi.hoisted(() => ({
  handleStartAiMatch: vi.fn(),
}));

const auctionTurnServiceMock = vi.hoisted(() => ({
  handleAuctionBid: vi.fn(),
  handleAuctionFold: vi.fn(),
  handleAuctionSoloPickSelect: vi.fn(),
}));

const auctionMatchmakingServiceMock = vi.hoisted(() => ({
  handleSearchStart: vi.fn(),
  handleSearchCancel: vi.fn(),
}));

vi.mock('../../src/realtime/services/auction-realtime.service.js', () => ({
  auctionRealtimeService: auctionRealtimeServiceMock,
}));

vi.mock('../../src/realtime/services/auction-matchmaking.service.js', () => ({
  auctionMatchmakingService: auctionMatchmakingServiceMock,
}));

vi.mock('../../src/realtime/services/auction-turn.service.js', () => ({
  handleAuctionBid: auctionTurnServiceMock.handleAuctionBid,
  handleAuctionFold: auctionTurnServiceMock.handleAuctionFold,
  handleAuctionSoloPickSelect: auctionTurnServiceMock.handleAuctionSoloPickSelect,
}));

import { registerAuctionHandlers } from '../../src/realtime/handlers/auction.handler.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

function createSocket() {
  const handlers = new Map<string, (payload?: unknown) => Promise<void> | void>();
  const socket = {
    data: { user: { id: 'user-1' } },
    on: vi.fn((event: string, handler: (payload?: unknown) => Promise<void> | void) => {
      handlers.set(event, handler);
    }),
    emit: vi.fn(),
  } as unknown as QuizballSocket & {
    on: Mock;
    emit: Mock;
  };

  return { socket, handlers };
}

describe('registerAuctionHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers auction:start_ai_match and applies default locale', async () => {
    const { socket, handlers } = createSocket();
    const io = {} as QuizballServer;

    registerAuctionHandlers(io, socket);
    await handlers.get('auction:start_ai_match')?.({ formation: '4-3-3' });

    expect(socket.on).toHaveBeenCalledWith('auction:start_ai_match', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('auction:bid', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('auction:fold', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('auction:solo_pick_select', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('auction:search_start', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('auction:search_cancel', expect.any(Function));
    expect(auctionRealtimeServiceMock.handleStartAiMatch).toHaveBeenCalledWith(
      io,
      socket,
      { formation: '4-3-3', locale: 'en' }
    );
  });

  it('routes valid auction actions to their services', async () => {
    const { socket, handlers } = createSocket();
    const io = {} as QuizballServer;

    registerAuctionHandlers(io, socket);
    await handlers.get('auction:search_start')?.({ formation: '4-3-3' });
    await handlers.get('auction:search_cancel')?.();
    await handlers.get('auction:bid')?.({ matchId: 'match-1', amount: 30_000_000 });
    await handlers.get('auction:fold')?.({ matchId: 'match-1' });
    await handlers.get('auction:solo_pick_select')?.({ matchId: 'match-1', option: 'B' });

    expect(auctionMatchmakingServiceMock.handleSearchStart).toHaveBeenCalledWith(
      io,
      socket,
      { formation: '4-3-3', locale: 'en' }
    );
    expect(auctionMatchmakingServiceMock.handleSearchCancel).toHaveBeenCalledWith(io, socket);
    expect(auctionTurnServiceMock.handleAuctionBid).toHaveBeenCalledWith(
      io,
      socket,
      { matchId: 'match-1', amount: 30_000_000 }
    );
    expect(auctionTurnServiceMock.handleAuctionFold).toHaveBeenCalledWith(
      io,
      socket,
      { matchId: 'match-1' }
    );
    expect(auctionTurnServiceMock.handleAuctionSoloPickSelect).toHaveBeenCalledWith(
      io,
      socket,
      { matchId: 'match-1', option: 'B' }
    );
  });

  it('emits a validation error for invalid payloads', async () => {
    const { socket, handlers } = createSocket();

    registerAuctionHandlers({} as QuizballServer, socket);
    await handlers.get('auction:start_ai_match')?.({ formation: '9-9-9' });

    expect(socket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction start payload',
      })
    );
    expect(auctionRealtimeServiceMock.handleStartAiMatch).not.toHaveBeenCalled();
  });

  it('emits validation errors for invalid bid and fold payloads', async () => {
    const { socket, handlers } = createSocket();

    registerAuctionHandlers({} as QuizballServer, socket);
    await handlers.get('auction:bid')?.({ matchId: 'match-1', amount: 0 });
    await handlers.get('auction:fold')?.({});
    await handlers.get('auction:solo_pick_select')?.({ matchId: 'match-1', option: 'C' });
    await handlers.get('auction:search_start')?.({ formation: '9-9-9' });

    expect(socket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction bid payload',
      })
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction fold payload',
      })
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction solo pick payload',
      })
    );
    expect(socket.emit).toHaveBeenCalledWith(
      'auction:error',
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Invalid auction search payload',
      })
    );
    expect(auctionMatchmakingServiceMock.handleSearchStart).not.toHaveBeenCalled();
    expect(auctionTurnServiceMock.handleAuctionBid).not.toHaveBeenCalled();
    expect(auctionTurnServiceMock.handleAuctionFold).not.toHaveBeenCalled();
    expect(auctionTurnServiceMock.handleAuctionSoloPickSelect).not.toHaveBeenCalled();
  });
});
