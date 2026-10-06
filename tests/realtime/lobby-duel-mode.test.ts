/**
 * Friend duel rooms (game mode 'duel') through the real lobby command service: create (member and
 * guest hosts), join by code (two seats), settings switches to/from a duel, and the host start that
 * dispatches to the duel runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const lobbiesRepo = {
  createLobby: vi.fn(), addMember: vi.fn(), getByInviteCode: vi.fn(), getById: vi.fn(), listMembersWithUser: vi.fn(),
  countMembers: vi.fn(), countReadyMembers: vi.fn(), updateLobbySettings: vi.fn(), setAllReady: vi.fn(), setVisibility: vi.fn(),
  updateMemberReady: vi.fn(), findWaitingLobbyForUser: vi.fn(),
};
const allowGuestOperation = vi.fn();
const startDuelMatchFromLobby = vi.fn();
const emitLobbyState = vi.fn();
const tryAcquireDraftStartGuard = vi.fn();
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({ allowGuestOperation: (...a: unknown[]) => allowGuestOperation(...a) }));
vi.mock('../../src/realtime/services/lobby-duel-start.service.js', () => ({
  startDuelMatchFromLobby: (...a: unknown[]) => startDuelMatchFromLobby(...a),
}));
vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    prepareForLobbyEntry: vi.fn().mockResolvedValue({ ok: true }),
    runWithUserTransitionLock: async (_io: unknown, _socket: unknown, fn: () => Promise<void>) => { await fn(); return true; },
    emitBlocked: vi.fn(), emitState: vi.fn(), resolveState: vi.fn(),
  },
}));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: vi.fn().mockResolvedValue({ acquired: true, token: 't' }),
  closeLobbyIfEmpty: vi.fn(), isRankedAiLobby: () => false, releaseRankedAiLobbyMemberSafely: vi.fn(),
  resolveLobbyId: (socket: { data: { lobbyId?: string } }, override?: string) => override ?? socket.data.lobbyId ?? null,
}));
vi.mock('../../src/realtime/services/lobby-draft-start.service.js', () => ({
  startDraft: vi.fn(),
  tryAcquireDraftStartGuard: (...a: unknown[]) => tryAcquireDraftStartGuard(...a),
  releaseDraftStartGuard: vi.fn(),
}));
vi.mock('../../src/realtime/locks.js', () => ({ acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 't' }), releaseLock: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/lobby-utils.js')>();
  return {
    ...actual,
    attachUserSocketsToLobby: vi.fn(),
    emitLobbyState: (...a: unknown[]) => emitLobbyState(...a),
    syncFriendlyLobbyModeForMemberCountLocked: vi.fn(),
  };
});
vi.mock('../../src/realtime/services/lobby-ranked-ai.service.js', () => ({ startRankedAiForUser: vi.fn() }));
vi.mock('../../src/db/readonly-breaker.js', () => ({ isDbWriteOutage: () => false, DbWriteOutageError: class extends Error {} }));

const { createLobby, joinByCode, setReady, startFriendlyMatch, updateSettings } = await import('../../src/realtime/services/lobby-commands.service.js');
const { config } = await import('../../src/core/config.js');
const flags = config as unknown as { DUEL_GAMES_ENABLED: string[]; GUEST_LOBBIES_PROVISIONING_ENABLED: boolean };
const originalDuelGames = [...flags.DUEL_GAMES_ENABLED];
const originalProvisioning = flags.GUEST_LOBBIES_PROVISIONING_ENABLED;

const socketFor = (id: string, guest = false, lobbyId?: string) => ({ id: `s-${id}`, data: { user: { id, is_guest: guest }, lobbyId }, emit: vi.fn(), join: vi.fn() });
const io = { to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: async () => [] })) };
const member = (id: string, guest = false, ready = false) => ({ lobby_id: 'L', user_id: id, is_ready: ready, joined_at: '2026-01-01', nickname: id, avatar_url: null, avatar_customization: null, favorite_club: null, is_ai: false, ai_kind: null, is_guest: guest });
const lobby = (gameMode: string, duelGame: string | null = null, host = 'host') => ({
  id: 'L', invite_code: 'ABC123', mode: 'friendly', status: 'waiting', host_user_id: host, game_mode: gameMode, duel_game: duelGame,
  friendly_random: true, friendly_category_a_id: null, friendly_category_b_id: null, is_public: false,
});
const errorCodes = (socket: ReturnType<typeof socketFor>) =>
  socket.emit.mock.calls.filter(([event]) => event === 'error').map(([, payload]) => (payload as { code: string }).code);

beforeEach(() => {
  vi.clearAllMocks();
  flags.DUEL_GAMES_ENABLED = ['buscaminas', 'pistas'];
  flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
  allowGuestOperation.mockResolvedValue(true);
  lobbiesRepo.addMember.mockResolvedValue(undefined);
  lobbiesRepo.updateLobbySettings.mockResolvedValue(undefined);
  lobbiesRepo.setAllReady.mockResolvedValue(0);
  lobbiesRepo.countReadyMembers.mockResolvedValue(0);
  startDuelMatchFromLobby.mockResolvedValue(undefined);
});
afterEach(() => {
  flags.DUEL_GAMES_ENABLED = [...originalDuelGames];
  flags.GUEST_LOBBIES_PROVISIONING_ENABLED = originalProvisioning;
});

describe('duel rooms — create', () => {
  beforeEach(() => {
    lobbiesRepo.createLobby.mockImplementation(async (data: { gameMode?: string; duelGame?: string | null }) => ({
      id: 'L', game_mode: data.gameMode ?? 'friendly_possession', duel_game: data.duelGame ?? null,
    }));
  });

  it('a member host opens a private room already in the duel', async () => {
    const result = await createLobby(io as never, socketFor('m') as never, {
      mode: 'friendly', isPublic: false, gameMode: 'duel', duelGame: 'pistas', correlationId: 'c',
    });
    expect(result).toMatchObject({ ok: true, lobbyId: 'L' });
    expect(lobbiesRepo.createLobby).toHaveBeenCalledWith(expect.objectContaining({ gameMode: 'duel', duelGame: 'pistas', isPublic: false }));
    expect(lobbiesRepo.addMember).toHaveBeenCalledWith('L', 'm', false);
  });

  it('a guest host opens the duel too (not the guest default mode)', async () => {
    const result = await createLobby(io as never, socketFor('g', true) as never, {
      mode: 'friendly', isPublic: false, gameMode: 'duel', duelGame: 'buscaminas', correlationId: 'c',
    });
    expect(result).toMatchObject({ ok: true });
    expect(lobbiesRepo.createLobby).toHaveBeenCalledWith(expect.objectContaining({ gameMode: 'duel', duelGame: 'buscaminas' }));
  });

  it('other rooms are created without a duel game', async () => {
    await createLobby(io as never, socketFor('m') as never, { mode: 'friendly', gameMode: 'auction', correlationId: 'c' });
    expect(lobbiesRepo.createLobby).toHaveBeenCalledWith(expect.objectContaining({ gameMode: 'auction', duelGame: null }));
  });

  it('a disabled game is refused before any room or session work', async () => {
    flags.DUEL_GAMES_ENABLED = ['buscaminas'];
    const result = await createLobby(io as never, socketFor('m') as never, {
      mode: 'friendly', gameMode: 'duel', duelGame: 'pistas', correlationId: 'c',
    });
    expect(result).toMatchObject({ ok: false, code: 'DUEL_UNAVAILABLE', retryable: false });
    expect(lobbiesRepo.createLobby).not.toHaveBeenCalled();
  });
});

describe('duel rooms — join by code', () => {
  const room = (members: ReturnType<typeof member>[]) => {
    lobbiesRepo.getByInviteCode.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue(members);
  };

  it('a second member takes the other seat', async () => {
    room([member('host')]);
    expect(await joinByCode(io as never, socketFor('m2') as never, 'ABC123', 'c')).toMatchObject({ ok: true, alreadyMember: false });
    expect(lobbiesRepo.addMember).toHaveBeenCalledWith('L', 'm2', false);
  });

  it('a guest may take the second seat', async () => {
    room([member('host')]);
    expect(await joinByCode(io as never, socketFor('g', true) as never, 'ABC123', 'c')).toMatchObject({ ok: true });
    expect(lobbiesRepo.addMember).toHaveBeenCalledWith('L', 'g', false);
  });

  it('a third player is refused (two seats; no party-quiz promotion)', async () => {
    room([member('host'), member('m2')]);
    expect(await joinByCode(io as never, socketFor('m3') as never, 'ABC123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_FULL' });
    room([member('host'), member('g1', true)]);
    expect(await joinByCode(io as never, socketFor('g2', true) as never, 'ABC123', 'c')).toMatchObject({ ok: false, code: 'LOBBY_FULL' });
    expect(lobbiesRepo.addMember).not.toHaveBeenCalled();
  });

  it('a seated player rejoining is not counted twice', async () => {
    room([member('host'), member('m2')]);
    expect(await joinByCode(io as never, socketFor('m2') as never, 'ABC123', 'c')).toMatchObject({ ok: true, alreadyMember: true });
  });
});

describe('duel rooms — settings', () => {
  const host = () => socketFor('host', false, 'L');

  it('switches a two-player room into a duel and resets readiness', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('friendly_possession'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2', false, true)]);
    lobbiesRepo.countReadyMembers.mockResolvedValue(1);
    const socket = host();
    await updateSettings(io as never, socket as never, { gameMode: 'duel', duelGame: 'buscaminas' });
    expect(errorCodes(socket)).toEqual([]);
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', {
      gameMode: 'duel', duelGame: 'buscaminas', roomGame: null, friendlyRandom: true, friendlyCategoryAId: null, friendlyCategoryBId: null,
    });
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('L', false);
  });

  it('a guest room may switch into a duel', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('football_grid'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('g', true)]);
    const socket = host();
    await updateSettings(io as never, socket as never, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(socket)).toEqual([]);
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'duel', duelGame: 'pistas' }));
  });

  it('switching away from a duel clears its game', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2')]);
    await updateSettings(io as never, host() as never, { gameMode: 'auction' });
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'auction', duelGame: null }));
  });

  it('switching between duel games is a change (readiness resets); the same game is a no-op', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2')]);
    await updateSettings(io as never, host() as never, { gameMode: 'duel', duelGame: 'buscaminas' });
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'duel', duelGame: 'buscaminas' }));
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('L', false);

    vi.clearAllMocks();
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2')]);
    lobbiesRepo.countReadyMembers.mockResolvedValue(0);
    await updateSettings(io as never, host() as never, { gameMode: 'duel', duelGame: 'pistas' });
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
  });

  it('a duel keeps its game when only visibility changes', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', 'pistas'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host')]);
    await updateSettings(io as never, host() as never, { gameMode: 'duel', isPublic: true });
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'duel', duelGame: 'pistas' }));
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
    expect(lobbiesRepo.setVisibility).toHaveBeenCalledWith('L', true);
  });

  it('refuses a duel for three players instead of turning it into party quiz', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('friendly_party_quiz'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2'), member('m3')]);
    const socket = host();
    await updateSettings(io as never, socket as never, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(socket)).toEqual(['LOBBY_MODE_CAPACITY']);
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
  });

  it('refuses a disabled game and a duel without a game', async () => {
    flags.DUEL_GAMES_ENABLED = ['buscaminas'];
    lobbiesRepo.getById.mockResolvedValue(lobby('friendly_possession'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host')]);
    const socket = host();
    await updateSettings(io as never, socket as never, { gameMode: 'duel', duelGame: 'pistas' });
    await updateSettings(io as never, socket as never, { gameMode: 'duel' });
    expect(errorCodes(socket)).toEqual(['DUEL_UNAVAILABLE', 'INVALID_SETTINGS']);
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
  });
});

describe('duel rooms — ready and start', () => {
  const readyRoom = (members: ReturnType<typeof member>[], duelGame = 'buscaminas') => {
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', duelGame));
    lobbiesRepo.listMembersWithUser.mockResolvedValue(members);
    lobbiesRepo.countMembers.mockResolvedValue(members.length);
    lobbiesRepo.countReadyMembers.mockResolvedValue(members.filter((m) => m.is_ready).length);
  };

  it('both ready waits for the host (no draft)', async () => {
    readyRoom([member('host', false, true), member('g', true, true)]);
    lobbiesRepo.updateMemberReady.mockResolvedValue(true);
    await setReady(io as never, socketFor('g', true, 'L') as never, true);
    expect(tryAcquireDraftStartGuard).not.toHaveBeenCalled();
  });

  it('the host start dispatches to the duel runtime with the room game', async () => {
    readyRoom([member('host', false, true), member('g', true, true)], 'pistas');
    const socket = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual([]);
    expect(startDuelMatchFromLobby).toHaveBeenCalledWith(io, socket, { lobbyId: 'L', duelGame: 'pistas' });
  });

  it('a socket whose room binding is missing (back from a duel, still re-joining) is re-bound to its waiting room', async () => {
    readyRoom([member('host', false, true), member('g', true, true)], 'pistas');
    lobbiesRepo.findWaitingLobbyForUser.mockResolvedValue({ id: 'L' });
    const socket = socketFor('host', false);
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual([]);
    expect(socket.join).toHaveBeenCalledWith('lobby:L');
    expect(socket.data.lobbyId).toBe('L');
    expect(startDuelMatchFromLobby).toHaveBeenCalledWith(io, socket, { lobbyId: 'L', duelGame: 'pistas' });
    lobbiesRepo.findWaitingLobbyForUser.mockResolvedValue(null);
    const stranger = socketFor('nobody', false);
    await startFriendlyMatch(io as never, stranger as never);
    expect(errorCodes(stranger)).toEqual(['NOT_IN_LOBBY']);
  });

  it('refuses with one member or before both are ready', async () => {
    readyRoom([member('host', false, true)]);
    const alone = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, alone as never);
    readyRoom([member('host', false, true), member('m2', false, false)]);
    const unready = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, unready as never);
    expect(errorCodes(alone)).toEqual(['LOBBY_NOT_READY']);
    expect(errorCodes(unready)).toEqual(['LOBBY_NOT_READY']);
    expect(startDuelMatchFromLobby).not.toHaveBeenCalled();
  });

  it('only the host starts', async () => {
    readyRoom([member('host', false, true), member('m2', false, true)]);
    const guestSocket = socketFor('m2', false, 'L');
    await startFriendlyMatch(io as never, guestSocket as never);
    expect(errorCodes(guestSocket)).toEqual(['NOT_HOST']);
    expect(startDuelMatchFromLobby).not.toHaveBeenCalled();
  });

  it('refuses a game switched off after the room was made', async () => {
    flags.DUEL_GAMES_ENABLED = ['buscaminas'];
    readyRoom([member('host', false, true), member('m2', false, true)], 'pistas');
    const socket = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual(['DUEL_UNAVAILABLE']);
    expect(startDuelMatchFromLobby).not.toHaveBeenCalled();
  });

  it('a failed start resets readiness, re-broadcasts the room and reports MATCH_CREATE_FAILED', async () => {
    readyRoom([member('host', false, true), member('m2', false, true)]);
    startDuelMatchFromLobby.mockRejectedValueOnce(new Error('duel_needs_two'));
    const socket = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, socket as never);
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('L', false);
    expect(emitLobbyState).toHaveBeenCalledWith(io, 'L');
    expect(errorCodes(socket)).toEqual(['MATCH_CREATE_FAILED']);
  });
});
