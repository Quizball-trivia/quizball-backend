import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

const auctionRealtimeServiceMock = vi.hoisted(() => ({
  handleStartAiMatch: vi.fn(),
}));

vi.mock('../../src/realtime/services/auction-realtime.service.js', () => ({
  auctionRealtimeService: auctionRealtimeServiceMock,
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
    expect(auctionRealtimeServiceMock.handleStartAiMatch).toHaveBeenCalledWith(
      io,
      socket,
      { formation: '4-3-3', locale: 'en' }
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
});
