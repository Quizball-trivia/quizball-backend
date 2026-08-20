import { describe, expect, it, vi } from 'vitest';
import {
  applyLocalFootballGridSocketTransition,
  transitionFootballGridSocket,
} from '../../src/realtime/football-grid-socket-transition.js';

describe('Football Grid socket ownership transitions', () => {
  it('updates data and rooms only on the socket-owning replica', async () => {
    const socket = {
      data: { lobbyId: 'lobby-1', matchId: undefined, gridMatchId: undefined },
      leave: vi.fn(async () => {}),
      join: vi.fn(async () => {}),
    };
    const io = {
      sockets: { sockets: new Map([['socket-1', socket]]) },
    } as never;

    expect(await applyLocalFootballGridSocketTransition(io, {
      socketId: 'socket-1', matchId: 'match-1', clearLobby: true,
    })).toBe(true);
    expect(socket.data).toEqual({ lobbyId: undefined, matchId: 'match-1', gridMatchId: 'match-1' });
    expect(socket.leave).toHaveBeenCalledWith('lobby:lobby-1');
    expect(socket.join).toHaveBeenCalledWith('grid:match-1');
  });

  it('forwards a remote socket transition to the replica cluster', async () => {
    const serverSideEmit = vi.fn();
    const io = {
      sockets: { sockets: new Map() },
      serverSideEmit,
    } as never;
    const payload = { socketId: 'remote-socket', matchId: 'match-2', clearLobby: true };

    await transitionFootballGridSocket(io, payload);

    expect(serverSideEmit).toHaveBeenCalledWith('grid:socket_transition', payload);
  });
});
