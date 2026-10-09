/**
 * Ready and Start name the game they were pressed on (`seen`). Through the real lobby command service: a command
 * pressed on a game the room has left is refused and everybody's state is refreshed; commands without `seen`
 * (older clients) behave as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

vi.setConfig({ testTimeout: 30_000 });

const lobbiesRepo = {
  getById: vi.fn(), listMembersWithUser: vi.fn(), countMembers: vi.fn(), countReadyMembers: vi.fn(),
  updateMemberReady: vi.fn(), readyMemberOnGame: vi.fn(), setAllReady: vi.fn(),
};
const startDuelMatchFromLobby = vi.fn();
const emitLobbyState = vi.fn();
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/guest/guest-rate-limit.js', () => ({ allowGuestOperation: vi.fn().mockResolvedValue(true) }));
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
  startDraft: vi.fn(), tryAcquireDraftStartGuard: vi.fn().mockResolvedValue(true), releaseDraftStartGuard: vi.fn(),
}));
vi.mock('../../src/realtime/locks.js', () => ({ acquireLock: vi.fn().mockResolvedValue({ acquired: true, token: 't' }), releaseLock: vi.fn() }));
vi.mock('../../src/realtime/lobby-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/lobby-utils.js')>();
  return { ...actual, attachUserSocketsToLobby: vi.fn(), emitLobbyState: (...a: unknown[]) => emitLobbyState(...a), syncFriendlyLobbyModeForMemberCountLocked: vi.fn() };
});
vi.mock('../../src/realtime/services/lobby-ranked-ai.service.js', () => ({ startRankedAiForUser: vi.fn() }));
vi.mock('../../src/db/readonly-breaker.js', () => ({ isDbWriteOutage: () => false, DbWriteOutageError: class extends Error {} }));

const { setReady, startFriendlyMatch } = await import('../../src/realtime/services/lobby-commands.service.js');
const { config } = await import('../../src/core/config.js');
(config as unknown as { DUEL_GAMES_ENABLED: string[] }).DUEL_GAMES_ENABLED = ['buscaminas', 'pistas'];

const socketFor = (id: string) => ({ id: `s-${id}`, data: { user: { id, is_guest: false }, lobbyId: 'L' }, emit: vi.fn(), join: vi.fn() });
const io = { to: vi.fn(() => ({ emit: vi.fn() })), in: vi.fn(() => ({ fetchSockets: async () => [] })) };
const member = (id: string) => ({ lobby_id: 'L', user_id: id, is_ready: true, joined_at: '2026-01-01', nickname: id, avatar_url: null, avatar_customization: null, favorite_club: null, is_guest: false });
const lobby = (gameMode: string | null, game: { duel?: string; room?: string | null } = {}) => ({
  id: 'L', invite_code: 'ABC123', mode: 'friendly', status: 'waiting', host_user_id: 'host', game_mode: gameMode,
  duel_game: game.duel ?? null, room_game: game.room ?? null, friendly_random: true, friendly_category_a_id: null, friendly_category_b_id: null, is_public: false,
});
const errorCodes = (socket: ReturnType<typeof socketFor>) =>
  socket.emit.mock.calls.filter(([event]) => event === 'error').map(([, payload]) => (payload as { code: string }).code);

beforeEach(() => {
  vi.clearAllMocks();
  lobbiesRepo.getById.mockResolvedValue(lobby('duel', { duel: 'pistas' }));
  lobbiesRepo.listMembersWithUser.mockResolvedValue([member('host'), member('guest')]);
  lobbiesRepo.countMembers.mockResolvedValue(2);
  lobbiesRepo.countReadyMembers.mockResolvedValue(2);
  lobbiesRepo.updateMemberReady.mockResolvedValue(true);
  lobbiesRepo.readyMemberOnGame.mockResolvedValue('ready');
});

describe('Ready names the game it was pressed on', () => {
  it('on the game the room holds: readied, state pushed', async () => {
    const socket = socketFor('guest');
    await setReady(io as never, socket as never, true, { gameMode: 'duel', duelGame: 'pistas' });
    expect(lobbiesRepo.readyMemberOnGame).toHaveBeenCalledWith('L', 'guest', { gameMode: 'duel', duelGame: 'pistas' });
    expect(lobbiesRepo.updateMemberReady).not.toHaveBeenCalled();
    expect(errorCodes(socket)).toEqual([]);
    expect(emitLobbyState).toHaveBeenCalledTimes(1);
  });

  it('on a game the room has left: refused, nobody is readied, everyone gets the current state', async () => {
    lobbiesRepo.readyMemberOnGame.mockResolvedValue('game_changed');
    const socket = socketFor('guest');
    await setReady(io as never, socket as never, true, { gameMode: 'room_game', roomGame: 'shared_player' });
    expect(errorCodes(socket)).toEqual(['LOBBY_SETTINGS_CHANGED']);
    expect(lobbiesRepo.updateMemberReady).not.toHaveBeenCalled();
    expect(emitLobbyState).toHaveBeenCalledWith(io, 'L');
    // No "everyone is ready" bookkeeping follows a refused Ready.
    expect(lobbiesRepo.countReadyMembers).not.toHaveBeenCalled();
  });

  it('a Ready that arrives while the room is not waiting (its match is running or finishing) is dropped quietly', async () => {
    lobbiesRepo.readyMemberOnGame.mockResolvedValue('not_waiting');
    const socket = socketFor('guest');
    await setReady(io as never, socket as never, true, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(socket)).toEqual([]);
    expect(emitLobbyState).not.toHaveBeenCalled();
    expect(lobbiesRepo.countReadyMembers).not.toHaveBeenCalled();
  });

  it('an un-ready is never refused, and a client that names no game is handled as before', async () => {
    const socket = socketFor('guest');
    await setReady(io as never, socket as never, false, { gameMode: 'room_game', roomGame: 'shared_player' });
    expect(lobbiesRepo.updateMemberReady).toHaveBeenLastCalledWith('L', 'guest', false);
    await setReady(io as never, socket as never, true);
    expect(lobbiesRepo.updateMemberReady).toHaveBeenLastCalledWith('L', 'guest', true);
    expect(lobbiesRepo.readyMemberOnGame).not.toHaveBeenCalled();
    expect(errorCodes(socket)).toEqual([]);
  });
});

describe('Start names the game it was pressed on', () => {
  it('starts the game the host saw', async () => {
    const socket = socketFor('host');
    await startFriendlyMatch(io as never, socket as never, undefined, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(socket)).toEqual([]);
    expect(startDuelMatchFromLobby).toHaveBeenCalledTimes(1);
  });

  it('refuses a start pressed on another game, even with everyone ready', async () => {
    for (const seen of [{ gameMode: 'duel', duelGame: 'buscaminas' }, { gameMode: 'room_game', roomGame: 'shared_player' }, { gameMode: 'auction' }] as const) {
      const socket = socketFor('host');
      await startFriendlyMatch(io as never, socket as never, undefined, seen);
      expect(errorCodes(socket)).toEqual(['LOBBY_SETTINGS_CHANGED']);
    }
    expect(startDuelMatchFromLobby).not.toHaveBeenCalled();
    expect(emitLobbyState).toHaveBeenCalledTimes(3);
  });

  it('a host whose screen is behind is told the game changed, not that somebody is not ready', async () => {
    // The change un-readied everyone; the host's screen never heard of it.
    lobbiesRepo.countReadyMembers.mockResolvedValue(0);
    const socket = socketFor('host');
    await startFriendlyMatch(io as never, socket as never, undefined, { gameMode: 'room_game', roomGame: 'shared_player' });
    expect(errorCodes(socket)).toEqual(['LOBBY_SETTINGS_CHANGED']);
    expect(emitLobbyState).toHaveBeenCalledWith(io, 'L');
    // And when the room turned into one that starts on its own.
    lobbiesRepo.getById.mockResolvedValue(lobby('ranked_sim'));
    const again = socketFor('host');
    await startFriendlyMatch(io as never, again as never, undefined, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(again)).toEqual(['LOBBY_SETTINGS_CHANGED']);
  });

  it('the game changes between the first look at the room and the ready count: still "the game changed"', async () => {
    // The first read still shows the game the host named; the change (which un-readies everyone) lands right after.
    lobbiesRepo.getById.mockResolvedValueOnce(lobby('duel', { duel: 'pistas' })).mockResolvedValue(lobby('room_game', { room: 'name_chain' }));
    lobbiesRepo.countReadyMembers.mockResolvedValue(0);
    const socket = socketFor('host');
    await startFriendlyMatch(io as never, socket as never, undefined, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(socket)).toEqual(['LOBBY_SETTINGS_CHANGED']);
    expect(emitLobbyState).toHaveBeenCalledWith(io, 'L');
    // Simply not everyone ready, on the game the host sees: the old answer.
    lobbiesRepo.getById.mockResolvedValue(lobby('duel', { duel: 'pistas' }));
    const waiting = socketFor('host');
    await startFriendlyMatch(io as never, waiting as never, undefined, { gameMode: 'duel', duelGame: 'pistas' });
    expect(errorCodes(waiting)).toEqual(['LOBBY_NOT_READY']);
  });

  it('a start that names no game (an older client) is not refused for it', async () => {
    const socket = socketFor('host');
    await startFriendlyMatch(io as never, socket as never);
    expect(errorCodes(socket)).toEqual([]);
    expect(startDuelMatchFromLobby).toHaveBeenCalledTimes(1);
  });
});
