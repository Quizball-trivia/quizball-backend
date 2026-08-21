/**
 * Under-lock status enforcement in startDraft (be#426 double-start guard):
 * with expectWaiting, a lobby that a competitor activated between the caller's
 * guard and lock acquisition must be left alone ('already_active'), and the
 * recovery path (no option) must keep accepting an active lobby.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const lobbiesRepo = {
  getById: vi.fn(),
  listMembersWithUser: vi.fn().mockResolvedValue([]),
  setAllReady: vi.fn().mockResolvedValue(undefined),
  clearLobbyCategoryBans: vi.fn().mockResolvedValue(undefined),
  clearLobbyCategories: vi.fn().mockResolvedValue(undefined),
  insertLobbyCategories: vi.fn().mockResolvedValue(undefined),
};
const lobbiesService = {
  selectRandomCategories: vi.fn().mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]),
  selectRankedCategoriesForDraft: vi.fn().mockResolvedValue({ categories: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], recentFilterApplied: false }),
};
const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn().mockResolvedValue(undefined);
const syntheticBotsRepo = { activateLobbyForDraftLocked: vi.fn() };

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({ lobbiesService }));
vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => acquireLockMock(...args),
  releaseLock: (...args: unknown[]) => releaseLockMock(...args),
}));
vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({ syntheticBotsRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: { abortLobby: vi.fn().mockResolvedValue({ aborted: true }) },
}));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/realtime/services/warmup-realtime.service.js', () => ({
  warmupRealtimeService: { cleanupLobby: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: { emitState: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  detachAllSocketsFromLobby: vi.fn().mockResolvedValue(undefined),
  emitClosedLobbyStateForMode: vi.fn().mockResolvedValue(undefined),
  resolveRankedAiUserIdForDraft: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/db/readonly-breaker.js', () => ({
  isDbWriteOutage: () => false,
  DbWriteOutageDeferral: class extends Error {},
}));
vi.mock('../../src/core/analytics/game-events.js', () => ({ trackDraftStarted: vi.fn() }));

const emit = vi.fn();
const io = { to: () => ({ emit }) } as never;

const { startDraft } = await import('../../src/realtime/services/lobby-draft-start.service.js');

const WAITING = { id: 'lobby-1', mode: 'friendly', status: 'waiting', host_user_id: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  acquireLockMock.mockResolvedValue({ acquired: true, token: 't1' });
  lobbiesRepo.getById.mockResolvedValue(WAITING);
  lobbiesService.selectRandomCategories.mockResolvedValue([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);
  syntheticBotsRepo.activateLobbyForDraftLocked.mockResolvedValue({ activated: true, committedReservation: false });
});

describe('startDraft expectWaiting enforcement', () => {
  it("returns 'already_active' under the lock when a competitor activated the lobby", async () => {
    lobbiesRepo.getById
      .mockResolvedValueOnce(WAITING)
      .mockResolvedValueOnce({ ...WAITING, status: 'active' });

    const result = await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(result).toBe('already_active');
    expect(lobbiesRepo.clearLobbyCategories).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('draft:start', expect.anything());
    expect(releaseLockMock).toHaveBeenCalled();
  });

  it("returns 'lobby_missing' under the lock when the lobby vanished after the pre-lock read", async () => {
    lobbiesRepo.getById
      .mockResolvedValueOnce(WAITING)
      .mockResolvedValueOnce(null);

    const result = await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(result).toBe('lobby_missing');
    expect(lobbiesRepo.clearLobbyCategories).not.toHaveBeenCalled();
  });

  it('still starts a draft on an ACTIVE lobby without the option (recovery restart path)', async () => {
    lobbiesRepo.getById.mockResolvedValue({ ...WAITING, status: 'active' });

    const result = await startDraft(io, 'lobby-1');

    expect(result).toBe('started');
    expect(emit).toHaveBeenCalledWith('draft:start', expect.anything());
  });

  it("returns 'lock_busy' without touching the lobby when the lock is contended", async () => {
    acquireLockMock.mockResolvedValue({ acquired: false, token: null });

    const result = await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(result).toBe('lock_busy');
    expect(lobbiesRepo.clearLobbyCategories).not.toHaveBeenCalled();
  });

  it("returns 'started' with the option when the lobby is still waiting under the lock", async () => {
    const result = await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(result).toBe('started');
    expect(lobbiesService.selectRandomCategories).toHaveBeenCalledWith(3, 5, 'possession');
    expect(syntheticBotsRepo.activateLobbyForDraftLocked).toHaveBeenCalledWith('lobby-1', { requireWaiting: true });
    expect(emit).toHaveBeenCalledWith('draft:start', expect.anything());
  });

  it("returns 'already_active' with NO writes and NO emit when the activation CAS is lost", async () => {
    // Both under-lock reads see 'waiting' (the slow competitor has not
    // activated yet), but its activation lands first — the CAS is the last
    // line of defense: the loser must not emit a second draft:start NOR
    // rewrite the winner's category rows.
    syntheticBotsRepo.activateLobbyForDraftLocked.mockResolvedValue({ activated: false, committedReservation: false });

    const result = await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(result).toBe('already_active');
    expect(emit).not.toHaveBeenCalledWith('draft:start', expect.anything());
    expect(lobbiesRepo.clearLobbyCategoryBans).not.toHaveBeenCalled();
    expect(lobbiesRepo.clearLobbyCategories).not.toHaveBeenCalled();
    expect(lobbiesRepo.insertLobbyCategories).not.toHaveBeenCalled();
  });

  it('performs the CAS before any category write in expectWaiting mode', async () => {
    const order: string[] = [];
    syntheticBotsRepo.activateLobbyForDraftLocked.mockImplementation(async () => {
      order.push('cas');
      return { activated: true, committedReservation: false };
    });
    lobbiesRepo.clearLobbyCategories.mockImplementation(async () => {
      order.push('clear');
    });

    await startDraft(io, 'lobby-1', { expectWaiting: true });

    expect(order.indexOf('cas')).toBeLessThan(order.indexOf('clear'));
  });

  it('keeps the unconditional activation on the recovery path (no option)', async () => {
    lobbiesRepo.getById.mockResolvedValue({ ...WAITING, status: 'active' });

    const result = await startDraft(io, 'lobby-1');

    expect(syntheticBotsRepo.activateLobbyForDraftLocked).toHaveBeenCalledWith('lobby-1', { requireWaiting: false });
    expect(result).toBe('started');
  });
});
