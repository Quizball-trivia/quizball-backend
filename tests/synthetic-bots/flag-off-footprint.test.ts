/**
 * Flag-off footprint parity (Sol finding #5): with PERSISTENT_BOTS_ENABLED off,
 * startRankedAiForUser must create the ephemeral user BEFORE the lobby, exactly
 * as main did — so an ephemeral-user insert failure leaves NO orphan lobby, and
 * the selection/reservation machinery is never touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const callOrder: string[] = [];

const usersRepo = {
  findTakenLowerNicknames: vi.fn().mockResolvedValue(new Set<string>()),
  getById: vi.fn().mockResolvedValue({ id: 'human', country: 'GE', is_ai: false }),
  create: vi.fn(),
};
const lobbiesRepo = {
  createLobby: vi.fn(),
  addMember: vi.fn().mockResolvedValue(undefined),
  updateRankedContext: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
  deleteLobby: vi.fn().mockResolvedValue(undefined),
  getById: vi.fn(),
  listMembersWithUser: vi.fn().mockResolvedValue([]),
};
const reservationService = {
  isEnabled: vi.fn().mockReturnValue(false),
  acquire: vi.fn(),
  releaseOwned: vi.fn().mockResolvedValue(undefined),
  abortLobby: vi.fn().mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: true, removedMemberIds: [] }),
};
const selectionService = {
  selectAndReserve: vi.fn(),
  recordRecentlyFaced: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
vi.mock('../../src/modules/synthetic-bots/synthetic-bot-selection.service.js', () => ({
  syntheticBotSelectionService: selectionService,
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: vi.fn().mockResolvedValue({ user_id: 'human', rp: 1500, placement_status: 'placed', placement_played: 3, placement_required: 3, placement_wins: 2 }),
    buildAiMatchContext: vi.fn().mockReturnValue({ isPlacement: false, aiAnchorRp: 1500, aiCorrectness: 0.5, aiDelayProfile: { minMs: 500, maxMs: 3000 } }),
    buildPersistentBotMatchContext: vi.fn().mockReturnValue({ aiCorrectness: 0.5, aiDelayProfile: { minMs: 500, maxMs: 3000 } }),
    DEFAULT_AI_OPPONENT_RP: 1900,
  },
}));
vi.mock('../../src/core/analytics.js', () => ({ registerAiUserId: vi.fn() }));
vi.mock('../../src/core/analytics/game-events.js', () => ({ trackRankedMatchFound: vi.fn() }));
vi.mock('../../src/modules/stats/stats.service.js', () => ({ statsService: { getRecentFormForUser: vi.fn().mockResolvedValue([]) } }));
vi.mock('../redis.js', () => ({ getRedisClient: () => null }), { virtual: true } as never);
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({
  attachUserSocketsToLobby: vi.fn().mockResolvedValue(undefined),
  emitLobbyState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: { emitState: vi.fn().mockResolvedValue(undefined), resolveState: vi.fn(), },
}));
vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({ startDraft: vi.fn() }));
vi.mock('../../src/core/rng.js', () => ({ getRandom: () => 0.5 }));
vi.mock('../../src/core/harness-timing.js', () => ({ harnessDelayMs: (n: number) => n }));

const io = { to: () => ({ emit: vi.fn() }), in: () => ({ fetchSockets: vi.fn().mockResolvedValue([]) }) } as never;

const { startRankedAiForUser } = await import('../../src/realtime/services/lobby-ranked-ai.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  reservationService.isEnabled.mockReturnValue(false);
  usersRepo.create.mockImplementation(async () => {
    callOrder.push('create_user');
    return { id: 'ephemeral-ai', nickname: 'aibot', avatar_url: null };
  });
  lobbiesRepo.createLobby.mockImplementation(async () => {
    callOrder.push('create_lobby');
    return { id: 'lobby-1' };
  });
});

describe('flag-off footprint parity', () => {
  it('creates the ephemeral user BEFORE the lobby (no lobby-first) and never touches selection', async () => {
    // skipSearchEmit + a fixed short duration keeps the deferred match-found out
    // of this synchronous assertion window.
    await startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: 100000 });
    expect(callOrder).toEqual(['create_user', 'create_lobby']);
    expect(reservationService.acquire).not.toHaveBeenCalled();
    expect(selectionService.selectAndReserve).not.toHaveBeenCalled();
  });

  it('leaves NO orphan lobby when the ephemeral-user insert fails', async () => {
    usersRepo.create.mockRejectedValueOnce(new Error('insert failed'));
    await expect(
      startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: 100000 }),
    ).rejects.toThrow('insert failed');
    // The lobby is created AFTER the user, so a user-insert failure means the
    // lobby was never created — no orphan.
    expect(lobbiesRepo.createLobby).not.toHaveBeenCalled();
    expect(lobbiesRepo.deleteLobby).not.toHaveBeenCalled();
  });
});

describe('persistent lobby-build compensation runs even when a setup step throws BEFORE aiUser is assigned (CodeRabbit CRITICAL)', () => {
  it('a throw in updateRankedContext (before aiUser) still compensates (release + teardown)', async () => {
    // Flag ON + selection succeeds → the probe lobby is created and the reservation
    // is held. A throw in updateRankedContext happens BEFORE aiUser is assigned, so
    // the catch must NOT deref aiUser (would TypeError and skip compensation). We
    // assert the compensation (abortLobby) still fired.
    reservationService.isEnabled.mockReturnValue(true);
    selectionService.selectAndReserve.mockResolvedValueOnce({
      bot: { user_id: 'persistent-bot', rp: 1500, nickname: 'botname', avatar_url: null, country: 'GE', home_city: null, home_lat: null, home_lng: null, favorite_club: null },
      reservation: { botUserId: 'persistent-bot', lobbyId: 'lobby-1', fence: 1 },
      relaxationLevel: 'strict', targetRp: 1500,
    });
    // buildPersistentBotMatchContext succeeds; updateRankedContext THROWS (before aiUser=…).
    lobbiesRepo.updateRankedContext.mockRejectedValueOnce(new Error('ctx write failed'));

    // startRankedAiForUser returns (does not throw) because the catch compensates + returns.
    await startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: 100000 });

    // The compensation MUST have run — the reservation is released via the locked
    // abort, not stranded. (Before the fix, the catch's aiUser!.id threw a
    // TypeError and this never ran.) compensateAbortLobby → abortLobby(lobbyId, path).
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'match_found_cancel', undefined);
  });
});