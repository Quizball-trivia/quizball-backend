/** Ranked AI lifecycle: persistent identities are the only fallback opponent. */
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
vi.mock('../../src/core/analytics/game-events.js', () => ({
  trackRankedMatchFound: vi.fn(),
  trackRankedQueueLeft: vi.fn(),
}));
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

const emit = vi.fn();
const io = { to: () => ({ emit }), in: () => ({ fetchSockets: vi.fn().mockResolvedValue([]) }) } as never;

const { startRankedAiForUser } = await import('../../src/realtime/services/lobby-ranked-ai.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  reservationService.isEnabled.mockReturnValue(false);
  selectionService.selectAndReserve.mockResolvedValue(null);
  usersRepo.create.mockImplementation(async () => {
    callOrder.push('create_user');
    return { id: 'ephemeral-ai', nickname: 'aibot', avatar_url: null };
  });
  lobbiesRepo.createLobby.mockImplementation(async () => {
    callOrder.push('create_lobby');
    return { id: 'lobby-1' };
  });
});

describe('persistent-only ranked fallback', () => {
  it('never creates an ephemeral user when persistent selection is unavailable', async () => {
    await startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: 100000 });
    expect(callOrder).toEqual(['create_lobby']);
    expect(usersRepo.create).not.toHaveBeenCalled();
    expect(selectionService.selectAndReserve).toHaveBeenCalledWith(expect.objectContaining({
      allowOutOfBandFallback: true,
    }));
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'match_found_cancel', undefined);
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'MATCH_PREPARATION_FAILED',
    }));
  });

  it('cleans up the reservation-anchor lobby when selection throws', async () => {
    selectionService.selectAndReserve.mockRejectedValueOnce(new Error('selection failed'));

    await startRankedAiForUser(io, 'human', { skipSearchEmit: true, searchDurationMs: 100000 });

    expect(usersRepo.create).not.toHaveBeenCalled();
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'match_found_cancel', undefined);
  });

  it('returns a terminal failure and clears the client search state when scheduling throws', async () => {
    selectionService.selectAndReserve.mockResolvedValueOnce({
      bot: { user_id: 'persistent-bot', rp: 1500, nickname: 'botname', avatar_url: null, country: 'GE', home_city: null, home_lat: null, home_lng: null, favorite_club: null },
      reservation: { botUserId: 'persistent-bot', lobbyId: 'lobby-1', fence: 1 },
      relaxationLevel: 'strict', targetRp: 1500,
    });
    emit.mockImplementationOnce(() => {
      throw new Error('socket emit failed');
    });

    const started = await startRankedAiForUser(io, 'human', { searchDurationMs: 100000 });

    expect(started).toBe(false);
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'match_found_cancel', undefined);
    expect(emit).toHaveBeenCalledWith('ranked:queue_left');
    expect(emit).toHaveBeenCalledWith('error', expect.objectContaining({
      code: 'MATCH_PREPARATION_FAILED',
    }));
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
