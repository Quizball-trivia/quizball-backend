/**
 * Room-game rooms (game mode 'room_game', 2–6 players) through the real lobby command service: create, settings
 * switches, the host start that dispatches to the room runtime, and leaving an active room while sitting out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const lobbiesRepo = {
  createLobby: vi.fn(), addMember: vi.fn(), getByInviteCode: vi.fn(), getById: vi.fn(), listMembersWithUser: vi.fn(),
  countMembers: vi.fn(), countReadyMembers: vi.fn(), updateLobbySettings: vi.fn(), setAllReady: vi.fn(), setVisibility: vi.fn(),
  updateMemberReady: vi.fn(), findWaitingLobbyForUser: vi.fn(), removeMember: vi.fn(),
};
const startRoomMatchFromLobby = vi.fn();
const hasLiveSeat = vi.fn();
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
vi.mock('../../src/realtime/services/lobby-room-start.service.js', () => ({
  startRoomMatchFromLobby: (...a: unknown[]) => startRoomMatchFromLobby(...a),
}));
vi.mock('../../src/modules/room/room.service.js', () => ({ roomService: { hasLiveSeat: (...a: unknown[]) => hasLiveSeat(...a) } }));
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

const { createLobby, leaveLobby, startFriendlyMatch, updateSettings } = await import('../../src/realtime/services/lobby-commands.service.js');
const { config } = await import('../../src/core/config.js');
const flags = config as unknown as { ROOM_GAMES_ENABLED: string[]; GUEST_LOBBIES_PROVISIONING_ENABLED: boolean };
const originalRoomGames = [...(flags.ROOM_GAMES_ENABLED ?? [])];

const socketFor = (id: string, guest = false, lobbyId?: string) => ({ id: `s-${id}`, data: { user: { id, is_guest: guest }, lobbyId }, emit: vi.fn(), join: vi.fn(), leave: vi.fn() });
const io = { to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: async () => [], socketsLeave: vi.fn() })) };
const member = (id: string, guest = false, ready = false) => ({ lobby_id: 'L', user_id: id, is_ready: ready, joined_at: '2026-01-01', nickname: id, avatar_url: null, avatar_customization: null, favorite_club: null, is_ai: false, ai_kind: null, is_guest: guest });
const lobby = (gameMode: string, roomGame: string | null = null, status = 'waiting') => ({
  id: 'L', invite_code: 'ABC123', mode: 'friendly', status, host_user_id: 'host', game_mode: gameMode, duel_game: null, room_game: roomGame,
  friendly_random: true, friendly_category_a_id: null, friendly_category_b_id: null, is_public: false,
});
const errorCodes = (socket: ReturnType<typeof socketFor>) =>
  socket.emit.mock.calls.filter(([event]) => event === 'error').map(([, payload]) => (payload as { code: string }).code);

beforeEach(() => {
  vi.clearAllMocks();
  flags.ROOM_GAMES_ENABLED = ['aproximado'];
  flags.GUEST_LOBBIES_PROVISIONING_ENABLED = true;
  allowGuestOperation.mockResolvedValue(true);
  lobbiesRepo.addMember.mockResolvedValue(undefined);
  lobbiesRepo.updateLobbySettings.mockResolvedValue(undefined);
  lobbiesRepo.setAllReady.mockResolvedValue(0);
  lobbiesRepo.countReadyMembers.mockResolvedValue(0);
  lobbiesRepo.removeMember.mockResolvedValue(undefined);
  startRoomMatchFromLobby.mockResolvedValue(undefined);
  lobbiesRepo.createLobby.mockImplementation(async (data: { gameMode?: string; roomGame?: string | null }) => ({
    id: 'L', game_mode: data.gameMode ?? 'friendly_possession', duel_game: null, room_game: data.roomGame ?? null,
  }));
});
afterEach(() => { flags.ROOM_GAMES_ENABLED = [...originalRoomGames]; });

describe('room games — create and settings', () => {
  it('a guest host opens a private room already in the room game', async () => {
    const result = await createLobby(io as never, socketFor('g', true) as never, {
      mode: 'friendly', isPublic: false, gameMode: 'room_game', roomGame: 'aproximado', correlationId: 'c',
    });
    expect(result).toMatchObject({ ok: true, lobbyId: 'L' });
    expect(lobbiesRepo.createLobby).toHaveBeenCalledWith(expect.objectContaining({ gameMode: 'room_game', roomGame: 'aproximado', duelGame: null }));
  });

  it('a switched-off room game is refused before any room work', async () => {
    flags.ROOM_GAMES_ENABLED = [];
    const result = await createLobby(io as never, socketFor('m') as never, { mode: 'friendly', gameMode: 'room_game', roomGame: 'aproximado', correlationId: 'c' });
    expect(result).toMatchObject({ ok: false, code: 'ROOM_GAME_UNAVAILABLE' });
    expect(lobbiesRepo.createLobby).not.toHaveBeenCalled();
  });

  it('a room of four (two guests) switches into the room game and readiness resets; leaving it clears the game', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('friendly_party_quiz'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2', false, true), member('g1', true), member('g2', true)]);
    lobbiesRepo.countReadyMembers.mockResolvedValue(1);
    const socket = socketFor('host', false, 'L');
    await updateSettings(io as never, socket as never, { gameMode: 'room_game', roomGame: 'aproximado' });
    expect(errorCodes(socket)).toEqual([]);
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith('L', expect.objectContaining({ gameMode: 'room_game', roomGame: 'aproximado', duelGame: null }));
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('L', false);

    lobbiesRepo.getById.mockResolvedValue(lobby('room_game', 'aproximado'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2')]);
    await updateSettings(io as never, socket as never, { gameMode: 'auction' });
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenLastCalledWith('L', expect.objectContaining({ gameMode: 'auction', roomGame: null }));
  });
});

describe('room games — start', () => {
  const readyRoom = (members: ReturnType<typeof member>[]) => {
    lobbiesRepo.getById.mockResolvedValue(lobby('room_game', 'aproximado'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue(members);
    lobbiesRepo.countMembers.mockResolvedValue(members.length);
    lobbiesRepo.countReadyMembers.mockResolvedValue(members.filter((m) => m.is_ready).length);
  };

  it('the host start with six ready members (guests included) dispatches to the room runtime with the stored game', async () => {
    readyRoom([member('host', false, true), ...['a', 'b', 'c', 'd', 'e'].map((id) => member(id, true, true))]);
    const socket = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual([]);
    expect(startRoomMatchFromLobby).toHaveBeenCalledWith(io, socket, { lobbyId: 'L', roomGame: 'aproximado' });
    expect(tryAcquireDraftStartGuard).not.toHaveBeenCalled();
  });

  it('refuses alone, or a game switched off after the room was made', async () => {
    readyRoom([member('host', false, true)]);
    const alone = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, alone as never);
    expect(errorCodes(alone)).toEqual(['LOBBY_NOT_READY']);
    flags.ROOM_GAMES_ENABLED = [];
    readyRoom([member('host', false, true), member('m2', false, true)]);
    const off = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, off as never);
    expect(errorCodes(off)).toEqual(['ROOM_GAME_UNAVAILABLE']);
    expect(startRoomMatchFromLobby).not.toHaveBeenCalled();
  });

  it('a runtime failure resets readiness and reports MATCH_CREATE_FAILED', async () => {
    readyRoom([member('host', false, true), member('m2', false, true)]);
    startRoomMatchFromLobby.mockRejectedValue(new Error('boom'));
    const socket = socketFor('host', false, 'L');
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual(['MATCH_CREATE_FAILED']);
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('L', false);
  });
});

describe('room games — leaving an active room', () => {
  beforeEach(() => {
    lobbiesRepo.getById.mockResolvedValue(lobby('room_game', 'aproximado', 'active'));
    lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('m2'), member('out')]);
  });

  it('clears a stale closed-lobby binding without leaving the match or showing an active-room error', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby('friendly_party_quiz', null, 'closed'));
    const socket = { ...socketFor('m2', false, 'L'), data: { user: { id: 'm2', is_guest: false }, lobbyId: 'L' as string | undefined, matchId: 'M' } };
    const result = await leaveLobby(io as never, socket as never, 'c');
    expect(result).toMatchObject({ ok: true, lobbyId: 'L', closed: true });
    expect(socket.data.lobbyId).toBeUndefined();
    expect(socket.data.matchId).toBe('M');
    expect(socket.leave).toHaveBeenCalledWith('lobby:L');
    expect(errorCodes(socket)).toEqual([]);
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
    expect(hasLiveSeat).not.toHaveBeenCalled();
  });

  it('a member sitting the match out (left it, or left out at the gate) may leave the room', async () => {
    hasLiveSeat.mockResolvedValue(false);
    const result = await leaveLobby(io as never, socketFor('out', false, 'L') as never, 'c');
    expect(result).toMatchObject({ ok: true, lobbyId: 'L' });
    expect(hasLiveSeat).toHaveBeenCalledWith('out', 'L');
    expect(lobbiesRepo.removeMember).toHaveBeenCalledWith('L', 'out');
  });

  it('a member still playing is told to go back to the match', async () => {
    hasLiveSeat.mockResolvedValue(true);
    const result = await leaveLobby(io as never, socketFor('m2', false, 'L') as never, 'c');
    expect(result).toMatchObject({ ok: false, code: 'LOBBY_ACTIVE' });
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
  });

  it('other active rooms keep refusing a leave without asking the room runtime', async () => {
    lobbiesRepo.getById.mockResolvedValue({ ...lobby('duel', null, 'active'), duel_game: 'pistas' });
    const result = await leaveLobby(io as never, socketFor('m2', false, 'L') as never, 'c');
    expect(result).toMatchObject({ ok: false, code: 'LOBBY_ACTIVE' });
    expect(hasLiveSeat).not.toHaveBeenCalled();
  });
});
