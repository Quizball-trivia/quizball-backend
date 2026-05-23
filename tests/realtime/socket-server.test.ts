import { describe, expect, it } from 'vitest';

import '../setup.js';
import { SOCKET_HEARTBEAT_CONFIG } from '../../src/realtime/socket-server.js';

describe('socket heartbeat config', () => {
  it('detects gameplay disconnects within the 5s feedback target', () => {
    expect(SOCKET_HEARTBEAT_CONFIG).toEqual({
      pingInterval: 2000,
      pingTimeout: 3000,
    });
    expect(SOCKET_HEARTBEAT_CONFIG.pingTimeout).toBeLessThanOrEqual(3000);
    expect(SOCKET_HEARTBEAT_CONFIG.pingInterval + SOCKET_HEARTBEAT_CONFIG.pingTimeout).toBeLessThanOrEqual(5000);
  });
});
