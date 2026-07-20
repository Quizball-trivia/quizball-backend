import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DbOverloadedError } from '../../src/db/admission.js';

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

  it('reports DB admission shedding as retryable overload, not an invalid token', async () => {
    verifyTokenMock.mockRejectedValue(new DbOverloadedError('queue_full'));
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
