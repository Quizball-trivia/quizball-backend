import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DbOverloadedError } from '../../src/db/index.js';
import { AppError, AuthenticationError, ErrorCode } from '../../src/core/errors.js';

const verifyTokenMock = vi.fn();

vi.mock('../../src/modules/auth/index.js', () => ({
  getAuthProvider: () => ({ verifyToken: verifyTokenMock }),
}));
vi.mock('../../src/modules/users/index.js', () => ({
  usersService: { getOrCreateFromIdentity: vi.fn() },
}));
vi.mock('../../src/modules/users/user-cache.js', () => ({
  getCachedUser: vi.fn(),
}));
vi.mock('../../src/realtime/session-country.js', () => ({
  rememberCurrentCountry: vi.fn(),
}));
vi.mock('../../src/core/geo.js', () => ({
  detectCountryFromHeaders: vi.fn(),
}));
vi.mock('../../src/core/tracing.js', () => ({
  withSpan: async (_name: string, _attributes: unknown, work: (span: { setAttribute: () => void }) => unknown) => (
    work({ setAttribute: vi.fn() })
  ),
}));

describe('socketAuthMiddleware', () => {
  beforeEach(() => {
    verifyTokenMock.mockReset();
  });

  it.each([
    new AppError('Auth unavailable', 503, ErrorCode.EXTERNAL_SERVICE_ERROR),
    Object.assign(new Error('(EAUTHPROTOCOL) protocol violation during authentication'), { code: '08P01' }),
  ])('keeps temporary infrastructure failure distinct from an invalid token', async failure => {
    verifyTokenMock.mockRejectedValue(failure);
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware({ id: 'qa-socket', handshake: { auth: { token: 'qa-token' }, headers: {}, address: '127.0.0.1' }, data: {} } as never, next);
    expect(next.mock.calls[0][0]).toMatchObject({ message: 'Server temporarily unavailable; retry connection', data: { code: 'AUTH_SERVICE_UNAVAILABLE', retryable: true } });
  });
  it('still rejects genuinely invalid tokens', async () => {
    verifyTokenMock.mockRejectedValue(new AuthenticationError('Invalid token'));
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    await socketAuthMiddleware({ id: 'qa-socket', handshake: { auth: { token: 'bad' }, headers: {}, address: '127.0.0.1' }, data: {} } as never, next);
    expect(next.mock.calls[0][0].message).toBe('Invalid token');
  });

  it('reports DB admission shedding as retryable overload, not an invalid token', async () => {
    const overloaded = new DbOverloadedError();
    Object.assign(overloaded, { reason: 'queue_full' });
    verifyTokenMock.mockRejectedValue(overloaded);
    const { socketAuthMiddleware } = await import('../../src/realtime/socket-auth.js');
    const next = vi.fn();
    const socket = {
      id: 'socket-1',
      handshake: {
        auth: { token: 'valid-token' },
        headers: {},
        address: '127.0.0.1',
      },
      data: {},
    };

    await socketAuthMiddleware(socket as never, next);

    const error = next.mock.calls[0]?.[0] as Error & { data?: unknown };
    expect(error.message).toBe('Server busy; retry connection');
    expect(error.data).toEqual({
      code: 'DB_OVERLOADED',
      retryable: true,
      reason: 'queue_full',
    });
  });
});
