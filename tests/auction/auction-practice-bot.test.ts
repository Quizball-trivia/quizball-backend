import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

const auctionContentServiceMock = vi.hoisted(() => ({
  assertPublishedAuctionContentAvailable: vi.fn(),
  getRandomPublishedAuctionCard: vi.fn(),
  getSeasonSnapshots: vi.fn(async () => []),
  recordSeenClueCards: vi.fn(async () => {}),
}));

const auctionStateStoreMock = vi.hoisted(() => ({
  save: vi.fn(async (state: unknown) => state),
  getActiveMatchIdForUser: vi.fn(async () => null),
  clearUserMatchIndex: vi.fn(async () => {}),
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


const guard = vi.hoisted(() => ({ blocked: false, emitBlocked: vi.fn() }));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    runWithUserTransitionLock: vi.fn(async (_io: unknown, _socket: unknown, work: () => Promise<void>) => work()),
    prepareForQueueJoin: vi.fn(async () => ({
      ok: !guard.blocked,
      reason: guard.blocked ? 'ACTIVE_MATCH' : undefined,
      snapshot: { state: guard.blocked ? 'IN_ACTIVE_MATCH' : 'IDLE', activeMatchId: guard.blocked ? 'other' : null, waitingLobbyId: null, openLobbyIds: [] },
    })),
    emitBlocked: guard.emitBlocked,
  },
}));
const limits = vi.hoisted(() => ({ allow: true }));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({ allowGuestOperation: vi.fn(async () => limits.allow) }));
vi.mock('../../src/realtime/socket-auth.js', () => ({ socketIpBucket: () => 'ip-bucket' }));

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

function createSocket(user: { id: string; nickname: string | null; is_guest?: boolean } | null = { id: 'user-1', nickname: 'Human' }) {
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


const GUEST_NAME = /^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/;

describe('auctionRealtimeService.handleStartPracticeMatch (guest "Play now")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guard.blocked = false;
    limits.allow = true;
    auctionContentServiceMock.assertPublishedAuctionContentAvailable.mockResolvedValue(undefined);
    auctionContentServiceMock.getRandomPublishedAuctionCard.mockResolvedValue(publishedCard());
    auctionStateStoreMock.save.mockImplementation(async (state: unknown) => state);
    auctionStateStoreMock.getActiveMatchIdForUser.mockResolvedValue(null);
  });

  it('seats the guest with anonymous guest-style bots, origin practice, no ranked identity on any seat', async () => {
    const { io } = createIo();
    const socket = createSocket({ id: 'guest-1', nickname: 'Masked Keeper 4321', is_guest: true });
    await auctionRealtimeService.handleStartPracticeMatch(io, socket, { locale: 'en', formation: '2-2-2' }, { context: deterministicContext });

    expect(auctionStateStoreMock.save).toHaveBeenCalledTimes(1);
    const saved = auctionStateStoreMock.save.mock.calls[0][0] as {
      origin: string;
      seats: Array<{ userId: string | null; isBot: boolean; displayName: string; avatarUrl: string | null; isGuest?: boolean; tier?: string | null; rp?: number | null }>;
    };
    expect(saved.origin).toBe('practice');
    const human = saved.seats.find((seat) => !seat.isBot)!;
    expect(human).toMatchObject({ userId: 'guest-1', displayName: 'Masked Keeper 4321', isGuest: true });
    const bots = saved.seats.filter((seat) => seat.isBot);
    expect(bots.length).toBeGreaterThan(0);
    for (const bot of bots) {
      expect(bot.displayName).toMatch(GUEST_NAME);
      expect(bot.avatarUrl).toBeNull();
      expect(bot.tier ?? null).toBeNull();
      expect(bot.rp ?? null).toBeNull();
    }
    expect(new Set(bots.map((bot) => bot.displayName)).size).toBe(bots.length);
    expect(socket.join).toHaveBeenCalledWith('match:match-id');
  });

  it('refuses members, the rate limit and a blocked session without creating a table', async () => {
    const { io } = createIo();
    const member = createSocket({ id: 'member-1', nickname: 'Human' });
    await auctionRealtimeService.handleStartPracticeMatch(io, member, { locale: 'en' }, { context: deterministicContext });
    expect(member.emit).toHaveBeenCalledWith('auction:error', expect.objectContaining({ code: 'AUCTION_PRACTICE_GUEST_ONLY' }));

    limits.allow = false;
    const limited = createSocket({ id: 'guest-2', nickname: 'Rogue Winger 1000', is_guest: true });
    await auctionRealtimeService.handleStartPracticeMatch(io, limited, { locale: 'en' }, { context: deterministicContext });
    expect(limited.emit).toHaveBeenCalledWith('auction:error', expect.objectContaining({ code: 'RATE_LIMIT_EXCEEDED' }));

    limits.allow = true;
    guard.blocked = true;
    const busy = createSocket({ id: 'guest-3', nickname: 'Silent Scout 2000', is_guest: true });
    await auctionRealtimeService.handleStartPracticeMatch(io, busy, { locale: 'en' }, { context: deterministicContext });
    expect(guard.emitBlocked).toHaveBeenCalledWith(busy, expect.objectContaining({ operation: 'auction:practice_bot_start' }));

    expect(auctionStateStoreMock.save).not.toHaveBeenCalled();
  });
});
