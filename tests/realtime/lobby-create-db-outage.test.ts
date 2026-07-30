import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

/**
 * INC-2026-07-29: creating a lobby while the pool is read-only produces a
 * session the database cannot persist. The gate is the FIRST statement in
 * createLobby, so it must refuse before touching the session guard or any repo.
 */
const prepareForLobbyEntryMock = vi.fn();
const createLobbyRepoMock = vi.fn();
const runWithUserTransitionLockMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: { createLobby: (...args: unknown[]) => createLobbyRepoMock(...args) },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    prepareForLobbyEntry: (...args: unknown[]) => prepareForLobbyEntryMock(...args),
    runWithUserTransitionLock: (...args: unknown[]) => runWithUserTransitionLockMock(...args),
    emitBlocked: vi.fn(),
    emitState: vi.fn(),
  },
}));

describe('createLobby during a database write outage', () => {
  afterEach(async () => {
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    readOnlyDbBreaker.resetForTests();
    vi.clearAllMocks();
  });

  it('refuses with a retryable DB_WRITE_OUTAGE and creates nothing', async () => {
    const { readOnlyDbBreaker } = await import('../../src/db/readonly-breaker.js');
    const error = new Error('cannot execute INSERT in a read-only transaction') as Error & {
      code: string;
    };
    error.code = '25006';
    readOnlyDbBreaker.recordError(error);

    const { createLobby } = await import('../../src/realtime/services/lobby-commands.service.js');
    const socket = { data: { user: { id: 'u1' } }, emit: vi.fn() };
    const io = { to: vi.fn(() => ({ emit: vi.fn() })) };

    const result = await createLobby(io as never, socket as never, {
      mode: 'friendly',
      correlationId: 'c1',
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'DB_WRITE_OUTAGE',
      retryable: true,
      correlationId: 'c1',
    });
    // Refused before any session-guard or repo work.
    expect(runWithUserTransitionLockMock).not.toHaveBeenCalled();
    expect(prepareForLobbyEntryMock).not.toHaveBeenCalled();
    expect(createLobbyRepoMock).not.toHaveBeenCalled();
  });
});
