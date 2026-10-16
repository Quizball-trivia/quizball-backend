/** A friendly Auction deals its cards in the host's language: Russian when Russian cards exist, else English. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const lobbiesRepo = {
  getById: vi.fn(), listMembersWithUser: vi.fn(), countMembers: vi.fn(), countReadyMembers: vi.fn(),
  updateMemberReady: vi.fn(), setAllReady: vi.fn(),
};
const acquireLobbyLockWithRetry = vi.fn();
const releaseLock = vi.fn();
const startDuelMatchFromLobby = vi.fn();
const startAuctionMatchFromLobby = vi.fn();
const resolveContentLocale = vi.fn();
const emitLobbyState = vi.fn();
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({ allowGuestOperation: vi.fn().mockResolvedValue(true) }));
vi.mock('../../src/realtime/services/lobby-duel-start.service.js', () => ({
  startDuelMatchFromLobby: (...a: unknown[]) => startDuelMatchFromLobby(...a),
}));
vi.mock('../../src/realtime/services/lobby-auction-start.service.js', () => ({
  startAuctionMatchFromLobby: (...a: unknown[]) => startAuctionMatchFromLobby(...a),
}));
vi.mock('../../src/modules/auction/auction-content.service.js', () => ({ auctionContentService: { resolveContentLocale: (...a: unknown[]) => resolveContentLocale(...a) } }));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    prepareForLobbyEntry: vi.fn().mockResolvedValue({ ok: true }),
    runWithUserTransitionLock: async (_io: unknown, _socket: unknown, fn: () => Promise<void>) => { await fn(); return true; },
    emitBlocked: vi.fn(), emitState: vi.fn(), resolveState: vi.fn(),
  },
}));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: (...a: unknown[]) => acquireLobbyLockWithRetry(...a),
  closeLobbyIfEmpty: vi.fn(), isRankedAiLobby: () => false, releaseRankedAiLobbyMemberSafely: vi.fn(),
  resolveLobbyId: (socket: { data: { lobbyId?: string } }, override?: string) => override ?? socket.data.lobbyId ?? null,
}));
vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({
  startDraft: vi.fn(), tryAcquireDraftStartGuard: vi.fn().mockResolvedValue(true), releaseDraftStartGuard: vi.fn(),
}));
vi.mock('../../src/realtime/locks.js', () => ({ acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 't' }), releaseLock: (...a: unknown[]) => releaseLock(...a) }));
vi.mock('../../src/realtime/lobby-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/lobby-utils.js')>();
  return { ...actual, attachUserSocketsToLobby: vi.fn(), emitLobbyState: (...a: unknown[]) => emitLobbyState(...a), syncFriendlyLobbyModeForMemberCountLocked: vi.fn() };
});
vi.mock('../../src/realtime/services/lobby-ranked-ai.service.js', () => ({ startRankedAiForUser: vi.fn() }));
vi.mock('../../src/db/readonly-breaker.js', () => ({ isDbWriteOutage: () => false, DbWriteOutageError: class extends Error {} }));

const { startFriendlyMatch } = await import('../../src/realtime/services/lobby-commands.service.js');
const { config } = await import('../../src/core/config.js');
(config as unknown as { AUCTION_ENABLED: boolean }).AUCTION_ENABLED = true;

const socketFor = (id: string) => ({ id: `s-${id}`, data: { user: { id, is_guest: false }, lobbyId: 'L' }, emit: vi.fn(), join: vi.fn() });
const io = { to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: async () => [] })) };
const member = (id: string) => ({ lobby_id: 'L', user_id: id, is_ready: true, joined_at: '2026-01-01', nickname: id, avatar_url: null, avatar_customization: null, favorite_club: null, is_guest: false });

beforeEach(() => {
  vi.clearAllMocks();
  lobbiesRepo.getById.mockResolvedValue({
    id: 'L', invite_code: 'ABC123', mode: 'friendly', status: 'waiting', host_user_id: 'host', game_mode: 'auction',
    duel_game: null, room_game: null, friendly_random: true, friendly_category_a_id: null, friendly_category_b_id: null, is_public: false,
  });
  lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('guest')]);
  lobbiesRepo.countMembers.mockResolvedValue(2);
  lobbiesRepo.countReadyMembers.mockResolvedValue(2);
  acquireLobbyLockWithRetry.mockResolvedValue({ acquired: true, token: 'guard' });
});

describe('a friendly Auction started from a lobby', () => {
  it("deals in the host's language, resolved against the published cards", async () => {
    resolveContentLocale.mockResolvedValue('ru');
    await startFriendlyMatch(io as never, socketFor('host') as never, undefined, undefined, 'ru');
    expect(resolveContentLocale).toHaveBeenCalledWith('ru');
    expect(startAuctionMatchFromLobby).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ locale: 'ru' }));
  });

  it('falls back to English when Russian cannot be resolved, and an older client without a language plays English', async () => {
    resolveContentLocale.mockRejectedValueOnce(new Error('db down'));
    await startFriendlyMatch(io as never, socketFor('host') as never, undefined, undefined, 'ru');
    resolveContentLocale.mockImplementation(async (l: string) => l);
    await startFriendlyMatch(io as never, socketFor('host') as never);
    expect(startAuctionMatchFromLobby.mock.calls.map((c) => (c[2] as { locale: string }).locale)).toEqual(['en', 'en']);
  });
});
