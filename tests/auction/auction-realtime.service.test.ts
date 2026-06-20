import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

const auctionContentServiceMock = vi.hoisted(() => ({
  assertPublishedAuctionContentAvailable: vi.fn(),
  getRandomPublishedAuctionCard: vi.fn(),
}));

const auctionStateStoreMock = vi.hoisted(() => ({
  save: vi.fn(async (state: unknown) => state),
}));

const clueTimerMock = vi.hoisted(() => ({
  scheduleAuctionClueRevealTimer: vi.fn(),
}));

vi.mock('../../src/modules/auction/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/index.js')>();
  return {
    ...actual,
    auctionContentService: auctionContentServiceMock,
  };
});

vi.mock('../../src/modules/auction/auction-state.store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/auction-state.store.js')>();
  return {
    ...actual,
    auctionStateStore: auctionStateStoreMock,
  };
});

vi.mock('../../src/realtime/services/auction-clue-timer.service.js', () => ({
  scheduleAuctionClueRevealTimer: clueTimerMock.scheduleAuctionClueRevealTimer,
}));

import {
  AuctionContentUnavailableError,
  AuctionStartingPriceUnavailableError,
} from '../../src/modules/auction/index.js';
import { auctionRealtimeService } from '../../src/realtime/services/auction-realtime.service.js';
import type { QuizballServer, QuizballSocket } from '../../src/realtime/socket-server.js';

function publishedCard(overrides: Record<string, unknown> = {}) {
  return {
    id: 'football-player-1',
    footballPlayerId: 'football-player-1',
    clueCardId: '11111111-1111-1111-1111-111111111111',
    transfermarktId: '123',
    name: 'Erling Haaland',
    positionGroup: 'FWD',
    positionLabelEn: 'Forward',
    positionLabelKa: 'ფორვარდი',
    trueValue: 180_000_000,
    trueValueEur: 180_000_000,
    auctionPriceEur: 180_000_000,
    startingPrice: 30_000_000,
    startingPriceEur: 30_000_000,
    currentValueEur: 180_000_000,
    peakValueEur: 200_000_000,
    currentClub: 'Manchester City',
    nationality: 'Norway',
    imageUrl: 'https://img.example/haaland.jpg',
    clues: [
      'Scored heavily in his first Premier League campaign.',
      'Won the Champions League with a Manchester club.',
      'Represents Norway at international level.',
    ],
    locale: 'en',
    difficulty: 'easy',
    generationProvider: 'openrouter',
    generationModel: 'google/gemini-3-flash-preview',
    promptVersion: 'v2-openrouter-localgate',
    evidence: {},
    reviewNotes: null,
    createdAt: '2026-06-20T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...overrides,
  };
}

function createSocket(user: { id: string; nickname: string | null } | null = { id: 'user-1', nickname: 'Human' }) {
  return {
    data: user ? { user } : {},
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
  } as unknown as QuizballSocket & {
    join: Mock;
    emit: Mock;
    data: Record<string, unknown>;
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

const deterministicContext = {
  now: () => new Date('2026-06-20T10:00:00.000Z'),
  random: () => 0,
  createId: (kind: 'match' | 'round' | 'bot-seat') => `${kind}-id`,
};

describe('auctionRealtimeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auctionContentServiceMock.assertPublishedAuctionContentAvailable.mockResolvedValue(undefined);
    auctionContentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(publishedCard());
    auctionStateStoreMock.save.mockImplementation(async (state: unknown) => state);
  });

  it('starts an authenticated AI auction match, stores Redis state, joins the match room, and emits start events', async () => {
    const { io, to, roomEmit } = createIo();
    const socket = createSocket();

    await auctionRealtimeService.handleStartAiMatch(
      io,
      socket,
      { locale: 'en', formation: '4-3-3' },
      { context: deterministicContext }
    );

    expect(auctionContentServiceMock.assertPublishedAuctionContentAvailable).toHaveBeenCalledWith('en');
    expect(auctionContentServiceMock.getRandomPublishedAuctionCard).toHaveBeenCalledWith({ locale: 'en' });
    expect(auctionStateStoreMock.save).toHaveBeenCalledTimes(1);
    expect(clueTimerMock.scheduleAuctionClueRevealTimer).toHaveBeenCalledWith(
      expect.objectContaining({ matchId: 'match-id', phase: 'clue_reveal' }),
      { now: new Date('2026-06-20T10:00:00.000Z'), context: deterministicContext }
    );
    expect(socket.join).toHaveBeenCalledWith('match:match-id');
    expect(socket.data.matchId).toBe('match-id');
    expect(socket.data.lobbyId).toBeUndefined();
    expect(to).toHaveBeenCalledWith('match:match-id');
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:match_started',
      expect.objectContaining({ matchId: 'match-id', locale: 'en' })
    );
    expect(roomEmit).toHaveBeenCalledWith(
      'auction:round_started',
      expect.objectContaining({
        matchId: 'match-id',
        stateVersion: 0,
        round: expect.objectContaining({
          positionGroup: 'FWD',
          startingPrice: 30_000_000,
        }),
      })
    );
  });

  it('does not leak unrevealed footballer identity, club, image, or true value in emitted payloads', async () => {
    const { io, roomEmit } = createIo();
    const socket = createSocket();

    await auctionRealtimeService.handleStartAiMatch(
      io,
      socket,
      { locale: 'en' },
      { context: deterministicContext }
    );

    const emittedPayloads = roomEmit.mock.calls.map(([, payload]) => payload);
    const payloadText = JSON.stringify(emittedPayloads);

    expect(payloadText).not.toContain('Erling Haaland');
    expect(payloadText).not.toContain('Manchester City');
    expect(payloadText).not.toContain('https://img.example/haaland.jpg');
    expect(payloadText).not.toContain('180000000');
    expect(payloadText).toContain('30000000');
    expect(payloadText).toContain('FWD');
  });

  it('emits auction_content_unavailable when no published content exists', async () => {
    const { io } = createIo();
    const socket = createSocket();
    auctionContentServiceMock.assertPublishedAuctionContentAvailable.mockRejectedValue(
      new AuctionContentUnavailableError({ locale: 'en' })
    );

    await auctionRealtimeService.handleStartAiMatch(
      io,
      socket,
      { locale: 'en' },
      { context: deterministicContext }
    );

    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'auction_content_unavailable',
      message: 'Published auction content unavailable',
      meta: { locale: 'en' },
    });
    expect(auctionStateStoreMock.save).not.toHaveBeenCalled();
  });

  it('emits auction_starting_price_unavailable when published content is missing price fields', async () => {
    const { io } = createIo();
    const socket = createSocket();
    auctionContentServiceMock.assertPublishedAuctionContentAvailable.mockRejectedValue(
      new AuctionStartingPriceUnavailableError({ locale: 'en', missing_price_count: 1 })
    );

    await auctionRealtimeService.handleStartAiMatch(
      io,
      socket,
      { locale: 'en' },
      { context: deterministicContext }
    );

    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'auction_starting_price_unavailable',
      message: 'Published auction content is missing auction price fields',
      meta: { locale: 'en', missing_price_count: 1 },
    });
  });

  it('requires an authenticated socket user', async () => {
    const { io } = createIo();
    const socket = createSocket(null);

    await auctionRealtimeService.handleStartAiMatch(
      io,
      socket,
      { locale: 'en' },
      { context: deterministicContext }
    );

    expect(socket.emit).toHaveBeenCalledWith('auction:error', {
      code: 'AUTHENTICATION_ERROR',
      message: 'Authentication required',
    });
    expect(auctionContentServiceMock.getRandomPublishedAuctionCard).not.toHaveBeenCalled();
  });
});
