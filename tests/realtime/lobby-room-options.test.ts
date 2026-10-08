/** The host's room-game options (lobby:room_options) through the real service, with the lobby store mocked. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const lobbiesRepo = { getById: vi.fn(), setRoomOptions: vi.fn(), setAllReady: vi.fn() };
const emitLobbyState = vi.fn();
const releaseLock = vi.fn();
const lockState = { acquired: true };
vi.mock('../../src/core/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: vi.fn(async () => (lockState.acquired ? { acquired: true, token: 't' } : { acquired: false })),
  resolveLobbyId: (socket: { data: { lobbyId?: string } }, override?: string) => override ?? socket.data.lobbyId ?? undefined,
}));
vi.mock('../../src/realtime/locks.js', () => ({ releaseLock: (...a: unknown[]) => releaseLock(...a) }));
vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: (...a: unknown[]) => emitLobbyState(...a) }));

const { setRoomOptions } = await import('../../src/realtime/services/lobby-room-options.service.js');

const io = {} as never;
const socketOf = (userId = 'host') => {
  const emit = vi.fn();
  return { socket: { emit, data: { user: { id: userId }, lobbyId: 'lobby-1' } } as never, emit };
};
const lobby = (extra: Record<string, unknown> = {}) => ({ id: 'lobby-1', host_user_id: 'host', status: 'waiting', game_mode: 'room_game', room_game: 'shared_player', room_options: null, ...extra });
const errorCode = (emit: ReturnType<typeof vi.fn>) => emit.mock.calls.find(([event]) => event === 'error')?.[1]?.code;

describe('lobby:room_options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockState.acquired = true;
    lobbiesRepo.getById.mockResolvedValue(lobby());
    lobbiesRepo.setRoomOptions.mockResolvedValue(true);
  });

  it('stores what the game validated, un-readies everyone and tells the room', async () => {
    const { socket, emit } = socketOf();
    await setRoomOptions(io, socket, { options: { scope: 'ESP', difficulty: 'easy' } });
    expect(lobbiesRepo.setRoomOptions).toHaveBeenCalledWith('lobby-1', 'shared_player', { scope: 'ESP', difficulty: 'easy' });
    // Readiness is cleared by the same statement that stores the options (lobbies.repo setRoomOptions).
    expect(emitLobbyState).toHaveBeenCalledWith(io, 'lobby-1');
    expect(errorCode(emit)).toBeUndefined();
    expect(releaseLock).toHaveBeenCalledWith('lock:lobby:lobby-1', 't');
  });

  it('refuses options the game does not offer, and leaves the room as it was', async () => {
    for (const options of [{ scope: 'TR', difficulty: 'hard' }, { scope: 'MARS' }, { scope: 'ESP', extra: true }]) {
      const { socket, emit } = socketOf();
      await setRoomOptions(io, socket, { options });
      expect(errorCode(emit)).toBe('INVALID_SETTINGS');
    }
    expect(lobbiesRepo.setRoomOptions).not.toHaveBeenCalled();
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
  });

  it('only the host, only while the room waits, only for a room game', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{}, 'guest', 'NOT_HOST'], [{ status: 'active' }, 'host', 'LOBBY_NOT_WAITING'], [{ game_mode: 'auction', room_game: null }, 'host', 'INVALID_SETTINGS'],
    ];
    for (const [extra, userId, code] of cases) {
      lobbiesRepo.getById.mockResolvedValue(lobby(extra));
      const { socket, emit } = socketOf(userId);
      await setRoomOptions(io, socket, { options: { scope: 'ESP' } });
      expect(errorCode(emit)).toBe(code);
    }
    lobbiesRepo.getById.mockResolvedValue(null);
    const gone = socketOf();
    await setRoomOptions(io, gone.socket, { options: { scope: 'ESP' } });
    expect(errorCode(gone.emit)).toBe('LOBBY_NOT_FOUND');
    expect(lobbiesRepo.setRoomOptions).not.toHaveBeenCalled();
  });

  it('the same options again change nothing (nobody is un-readied)', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby({ room_options: { scope: 'ESP' } }));
    const { socket } = socketOf();
    await setRoomOptions(io, socket, { options: { scope: 'ESP' } });
    expect(lobbiesRepo.setRoomOptions).not.toHaveBeenCalled();
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
  });

  it('null goes back to the defaults; a game with nothing to choose stores nothing', async () => {
    lobbiesRepo.getById.mockResolvedValue(lobby({ room_options: { scope: 'ESP' } }));
    await setRoomOptions(io, socketOf().socket, { options: null });
    expect(lobbiesRepo.setRoomOptions).toHaveBeenCalledWith('lobby-1', 'shared_player', null);
    vi.clearAllMocks();
    lobbiesRepo.getById.mockResolvedValue(lobby({ room_game: 'aproximado' }));
    await setRoomOptions(io, socketOf().socket, { options: { scope: 'ESP' } });
    expect(lobbiesRepo.setRoomOptions).not.toHaveBeenCalled();
  });

  it('a room that started while the command waited is told so, and a busy lock is a retry', async () => {
    lobbiesRepo.setRoomOptions.mockResolvedValue(false);
    const raced = socketOf();
    await setRoomOptions(io, raced.socket, { options: { scope: 'ESP' } });
    expect(errorCode(raced.emit)).toBe('LOBBY_NOT_WAITING');
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
    lockState.acquired = false;
    const busy = socketOf();
    await setRoomOptions(io, busy.socket, { options: { scope: 'ESP' } });
    expect(errorCode(busy.emit)).toBe('LOBBY_SETTINGS_LOCKED');
  });
});
