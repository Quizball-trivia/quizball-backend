import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const warnMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

beforeEach(() => {
  warnMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

async function loadService() {
  return import('../../src/realtime/services/auth-realtime.service.js');
}

function makeIo() {
  const emitMock = vi.fn();
  const disconnectSocketsMock = vi.fn();
  const toMock = vi.fn().mockReturnValue({ emit: emitMock });
  const inMock = vi.fn().mockReturnValue({ disconnectSockets: disconnectSocketsMock });
  return {
    io: { to: toMock, in: inMock } as never,
    toMock,
    emitMock,
    inMock,
    disconnectSocketsMock,
  };
}

describe('disconnectUserSockets', () => {
  it('emits force_logout, then disconnects sockets after a flush delay', async () => {
    const { setAuthRealtimeServer, disconnectUserSockets } = await loadService();
    const { io, toMock, emitMock, inMock, disconnectSocketsMock } = makeIo();

    setAuthRealtimeServer(io);
    await disconnectUserSockets('user-1', 'account_deleted');

    expect(toMock).toHaveBeenCalledWith('user:user-1');
    expect(emitMock).toHaveBeenCalledWith('auth:force_logout', { reason: 'account_deleted' });
    expect(inMock).toHaveBeenCalledWith('user:user-1');
    expect(disconnectSocketsMock).toHaveBeenCalledWith(true);
  });

  it('emits before disconnecting (ordering)', async () => {
    const { setAuthRealtimeServer, disconnectUserSockets } = await loadService();
    const order: string[] = [];
    const io = {
      to: () => ({
        emit: () => {
          order.push('emit');
        },
      }),
      in: () => ({
        disconnectSockets: () => {
          order.push('disconnect');
        },
      }),
    } as never;

    setAuthRealtimeServer(io);
    await disconnectUserSockets('user-1', 'account_deleted');

    expect(order).toEqual(['emit', 'disconnect']);
  });

  it('logs a warning and does nothing when the server is not initialized', async () => {
    const { disconnectUserSockets } = await loadService();
    // Note: we do NOT call setAuthRealtimeServer here.

    await expect(disconnectUserSockets('user-1', 'account_deleted')).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      reason: 'account_deleted',
    });
  });

  it('swallows emit errors so deletion flows are never blocked', async () => {
    const { setAuthRealtimeServer, disconnectUserSockets } = await loadService();
    const failingIo = {
      to: () => ({
        emit: () => {
          throw new Error('redis adapter exploded');
        },
      }),
      in: () => ({ disconnectSockets: vi.fn() }),
    } as never;

    setAuthRealtimeServer(failingIo);

    await expect(disconnectUserSockets('user-1', 'account_deleted')).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledOnce();
    expect(warnMock.mock.calls[0]?.[0]).toMatchObject({
      userId: 'user-1',
      reason: 'account_deleted',
    });
  });

  it('throws when initialized with null/undefined', async () => {
    const { setAuthRealtimeServer } = await loadService();
    expect(() => setAuthRealtimeServer(null as never)).toThrow();
  });
});
