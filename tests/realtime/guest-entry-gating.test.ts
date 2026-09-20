/**
 * A guest socket reaches every handler family (they are registered after auth);
 * the ENTRY SERVICES must refuse before any queue/lobby work. Each service pulls
 * a large module graph, so the graph is mocked to the minimum that lets the
 * first statement run.
 */
import { describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const guestSocket = () => ({ id: 's-guest', connected: true, data: { user: { id: 'guest-1', is_guest: true, is_ai: false, ai_kind: null } }, emit: vi.fn() });

describe('guest entry gating', () => {
  it('ranked queue join', async () => {
    const { rankedMatchmakingService } = await import('../../src/realtime/services/ranked-matchmaking.service.js');
    await expect(rankedMatchmakingService.handleQueueJoin({} as never, guestSocket() as never, { source: 'mode_select' })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });

  it('football grid search', async () => {
    const { footballGridMatchmakingService } = await import('../../src/realtime/services/football-grid-matchmaking.service.js');
    await expect(footballGridMatchmakingService.handleSearchStart({} as never, guestSocket() as never, { locale: 'en', theme: 'european' } as never)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });

  it('auction search and direct AI start', async () => {
    const { auctionMatchmakingService } = await import('../../src/realtime/services/auction-matchmaking.service.js');
    await expect(auctionMatchmakingService.handleSearchStart({} as never, guestSocket() as never, { locale: 'en' } as never)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    const { auctionRealtimeService } = await import('../../src/realtime/services/auction-realtime.service.js');
    await expect(auctionRealtimeService.handleStartAiMatch({} as never, guestSocket() as never, { locale: 'en' } as never)).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
  });
});
