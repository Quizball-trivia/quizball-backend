import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// Mode-agnostic stranded-lobby janitor (#715): every new game mode has
// shipped without lobby teardown (grid, then duel on launch day). The janitor
// dissolves lobbies stuck waiting/active >2h with no live socket and no
// active match — the prod probe's exact detection condition, acting.

const removeMemberMock = vi.fn();
const getByIdMock = vi.fn();
vi.mock('../../src/modules/lobbies/index.js', () => ({
  lobbiesRepo: {
    removeMember: (...a: unknown[]) => removeMemberMock(...a),
    getById: (...a: unknown[]) => getByIdMock(...a),
  },
}));

const sqlMock = vi.fn();
vi.mock('../../src/db/index.js', () => ({
  sql: (...a: unknown[]) => sqlMock(...a),
}));

const closeLobbyIfEmptyMock = vi.fn();
vi.mock('../../src/realtime/services/lobby-lifecycle.helpers.js', () => ({
  acquireLobbyLockWithRetry: vi.fn(async () => ({ acquired: true, token: 't1' })),
  closeLobbyIfEmpty: (...a: unknown[]) => closeLobbyIfEmptyMock(...a),
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'sweep-token' })),
  releaseLock: vi.fn(async () => undefined),
}));

import { lobbyJanitorService } from '../../src/realtime/services/lobby-janitor.service.js';

function ioMock(liveLobbyIds: string[] = []) {
  return {
    in: (room: string) => ({
      fetchSockets: async () => {
        const id = room.replace('lobby:', '');
        return liveLobbyIds.includes(id) ? [{ data: { lobbyId: id } }] : [];
      },
    }),
  } as never;
}

beforeEach(() => {
  removeMemberMock.mockReset();
  getByIdMock.mockReset();
  closeLobbyIfEmptyMock.mockReset().mockResolvedValue(true);
  sqlMock.mockReset().mockResolvedValue([]);
});

describe('lobby janitor sweepLobby', () => {
  it('dissolves a stranded lobby: removes members then closes', async () => {
    getByIdMock.mockResolvedValue({ id: 'l1', status: 'waiting' });
    sqlMock.mockResolvedValue([{ user_id: 'u1' }, { user_id: 'u2' }]);
    const swept = await lobbyJanitorService.__internals.sweepLobby(
      ioMock([]), { id: 'l1', status: 'waiting', game_mode: 'duel' });
    expect(swept).toBe(true);
    expect(removeMemberMock).toHaveBeenCalledWith('l1', 'u1');
    expect(removeMemberMock).toHaveBeenCalledWith('l1', 'u2');
    expect(closeLobbyIfEmptyMock).toHaveBeenCalledWith(expect.anything(), 'l1');
  });

  it('skips a room whose friend duel is still live (duels are not in matches)', async () => {
    getByIdMock.mockResolvedValue({ id: 'l5', status: 'waiting' });
    sqlMock.mockResolvedValueOnce([{ live: true }]);
    const swept = await lobbyJanitorService.__internals.sweepLobby(
      ioMock([]), { id: 'l5', status: 'waiting', game_mode: 'duel' });
    expect(swept).toBe(false);
    expect(removeMemberMock).not.toHaveBeenCalled();
    expect(closeLobbyIfEmptyMock).not.toHaveBeenCalled();
  });

  it('skips a lobby with a live socket in its room', async () => {
    getByIdMock.mockResolvedValue({ id: 'l2', status: 'waiting' });
    const swept = await lobbyJanitorService.__internals.sweepLobby(
      ioMock(['l2']), { id: 'l2', status: 'waiting', game_mode: 'football_grid' });
    expect(swept).toBe(false);
    expect(removeMemberMock).not.toHaveBeenCalled();
    expect(closeLobbyIfEmptyMock).not.toHaveBeenCalled();
  });

  it('skips when the lobby closed between listing and locking', async () => {
    getByIdMock.mockResolvedValue({ id: 'l3', status: 'closed' });
    const swept = await lobbyJanitorService.__internals.sweepLobby(
      ioMock([]), { id: 'l3', status: 'waiting', game_mode: 'auction' });
    expect(swept).toBe(false);
    expect(removeMemberMock).not.toHaveBeenCalled();
  });

  it('fails safe when presence cannot be read', async () => {
    getByIdMock.mockResolvedValue({ id: 'l4', status: 'waiting' });
    const io = { in: () => ({ fetchSockets: async () => { throw new Error('adapter down'); } }) } as never;
    const swept = await lobbyJanitorService.__internals.sweepLobby(
      io, { id: 'l4', status: 'waiting', game_mode: 'duel' });
    expect(swept).toBe(false);
    expect(removeMemberMock).not.toHaveBeenCalled();
  });
});
