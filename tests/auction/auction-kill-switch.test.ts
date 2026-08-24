import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// AUCTION_ENABLED defaults false in config; this file exercises the DISABLED
// path, so no config mock: a fresh deploy must reject new auction entry with a
// clean error and never reach validation or the matchmaking service.
const searchStartMock = vi.fn();
vi.mock('../../src/realtime/services/auction-matchmaking.service.js', () => ({
  auctionMatchmakingService: { handleSearchStart: (...args: unknown[]) => searchStartMock(...args) },
}));
vi.mock('../../src/realtime/services/auction-realtime.service.js', () => ({
  auctionRealtimeService: {},
}));
vi.mock('../../src/realtime/services/auction-turn.service.js', () => ({
  auctionTurnService: {},
}));

import { registerAuctionHandlers } from '../../src/realtime/handlers/auction.handler.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

function fakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emit = vi.fn();
  const socket = {
    data: { user: { id: 'user-1' } },
    emit,
    on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
  } as unknown as QuizballSocket;
  return { socket, handlers, emit };
}

describe('auction kill switch (AUCTION_ENABLED=false)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects new searches and AI matches with AUCTION_DISABLED', async () => {
    const { socket, handlers, emit } = fakeSocket();
    registerAuctionHandlers({} as QuizballServer, socket);

    await handlers.get('auction:search_start')?.({});
    await handlers.get('auction:start_ai_match')?.({});

    expect(emit).toHaveBeenCalledTimes(2);
    for (const call of emit.mock.calls) {
      expect(call[0]).toBe('auction:error');
      expect((call[1] as { code: string }).code).toBe('AUCTION_DISABLED');
    }
    expect(searchStartMock).not.toHaveBeenCalled();
  });
});
