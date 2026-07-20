import { describe, expect, it } from 'vitest';

import '../setup.js';
import {
  __socketServerInternals,
  SOCKET_HEARTBEAT_CONFIG,
} from '../../src/realtime/socket-server.js';

describe('socket heartbeat config', () => {
  it('tolerates routine mobile network hiccups while keeping detection bounded', () => {
    expect(SOCKET_HEARTBEAT_CONFIG).toEqual({
      pingInterval: 2500,
      pingTimeout: 10000,
    });
    // Mobile radio wake-ups / wifi roaming / GC pauses routinely take 3-8s.
    // A timeout below that produced constant false disconnects in prod
    // (mass socket-drop bursts pausing 7+ matches at once, 2026-06-10).
    expect(SOCKET_HEARTBEAT_CONFIG.pingTimeout).toBeGreaterThanOrEqual(8000);
    // Worst-case disconnect detection must stay well inside the disconnect grace
    // window so the opponent overlay + grace flow remain meaningful.
    expect(
      SOCKET_HEARTBEAT_CONFIG.pingInterval + SOCKET_HEARTBEAT_CONFIG.pingTimeout
    ).toBeLessThanOrEqual(15000);
  });
});

describe('socket disconnect DB task routing', () => {
  it('avoids the unrelated fallback for a socket with a known binding', () => {
    expect(__socketServerInternals.selectDisconnectDbTasks({ lobbyId: 'lobby-1' }))
      .toEqual(['lobby_disconnect']);
    expect(__socketServerInternals.selectDisconnectDbTasks({ matchId: 'match-1' }))
      .toEqual(['match_disconnect']);
  });

  it('retains both recovery lookups for unbound or inconsistent sockets', () => {
    expect(__socketServerInternals.selectDisconnectDbTasks({}))
      .toEqual(['lobby_disconnect', 'match_disconnect']);
    expect(__socketServerInternals.selectDisconnectDbTasks({
      lobbyId: 'lobby-1',
      matchId: 'match-1',
    })).toEqual(['lobby_disconnect', 'match_disconnect']);
  });
});
