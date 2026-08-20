import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const offerRematchMock = vi.fn();
const createPairingMock = vi.fn();
const markPairingFailedMock = vi.fn();
const closeRematchAfterFailureMock = vi.fn();
const createMatchMock = vi.fn();
const withUserSessionLockMock = vi.fn();
const withUserSessionLocksMock = vi.fn();
const claimRematchActivityFenceMock = vi.fn();
const ownsActivityFencesMock = vi.fn();
const renewActivityFencesMock = vi.fn();
const releaseActivityFencesMock = vi.fn();
const emitSessionStateMock = vi.fn();
const scheduleRealtimeTimerMock = vi.fn();
const emitMatchFoundMock = vi.fn();

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/football-grid/index.js', () => ({
  footballGridRepo: {
    offerRematch: (...args: unknown[]) => offerRematchMock(...args),
    createPairing: (...args: unknown[]) => createPairingMock(...args),
    markPairingFailed: (...args: unknown[]) => markPairingFailedMock(...args),
    closeRematchAfterFailure: (...args: unknown[]) => closeRematchAfterFailureMock(...args),
  },
  footballGridService: {
    createMatch: (...args: unknown[]) => createMatchMock(...args),
  },
}));

vi.mock('../../src/realtime/services/user-session-guard.service.js', () => ({
  userSessionGuardService: {
    withUserSessionLock: (...args: unknown[]) => withUserSessionLockMock(...args),
    withUserSessionLocks: (...args: unknown[]) => withUserSessionLocksMock(...args),
    claimRematchActivityFence: (...args: unknown[]) => claimRematchActivityFenceMock(...args),
    ownsActivityFences: (...args: unknown[]) => ownsActivityFencesMock(...args),
    renewActivityFences: (...args: unknown[]) => renewActivityFencesMock(...args),
    releaseActivityFences: (...args: unknown[]) => releaseActivityFencesMock(...args),
    emitState: (...args: unknown[]) => emitSessionStateMock(...args),
  },
}));

vi.mock('../../src/realtime/realtime-timer-scheduler.js', () => ({
  scheduleRealtimeTimer: (...args: unknown[]) => scheduleRealtimeTimerMock(...args),
}));

vi.mock('../../src/realtime/services/football-grid-realtime.service.js', () => ({
  footballGridRealtimeService: {
    emitMatchFound: (...args: unknown[]) => emitMatchFoundMock(...args),
  },
}));

vi.mock('../../src/realtime/lobby-utils.js', () => ({ emitLobbyState: vi.fn() }));

const readyOffer = {
  seriesId: '00000000-0000-4000-8000-000000000101',
  seriesVersion: 4,
  rematchIndex: 2,
  pairingToken: '00000000-0000-4000-8000-000000000102',
  lobbyId: null,
  origin: 'random' as const,
  players: [
    { userId: '00000000-0000-4000-8000-000000000001', seat: 1 as const },
    { userId: '00000000-0000-4000-8000-000000000002', seat: 2 as const },
  ],
  openerSeat: 2 as const,
  acceptedUserIds: [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ],
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
  readyToCreate: true,
};

describe('football-grid-rematch.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    offerRematchMock.mockResolvedValue(readyOffer);
    withUserSessionLockMock.mockImplementation(async (_userId, work: () => Promise<unknown>) => work());
    withUserSessionLocksMock.mockImplementation(async (_userIds, work: () => Promise<unknown>) => work());
    claimRematchActivityFenceMock.mockResolvedValue(true);
    ownsActivityFencesMock.mockResolvedValue(true);
    renewActivityFencesMock.mockResolvedValue(true);
    createPairingMock.mockResolvedValue(undefined);
    createMatchMock.mockResolvedValue({ state: { matchId: 'next-grid-match' } });
    markPairingFailedMock.mockResolvedValue(undefined);
    closeRematchAfterFailureMock.mockResolvedValue(undefined);
    releaseActivityFencesMock.mockResolvedValue(undefined);
    emitSessionStateMock.mockResolvedValue(undefined);
    scheduleRealtimeTimerMock.mockResolvedValue(undefined);
    emitMatchFoundMock.mockResolvedValue(undefined);
  });

  it('creates the final rematch only under ordered player locks and renewed activity fences', async () => {
    const { footballGridRematchService } = await import('../../src/realtime/services/football-grid-rematch.service.js');
    const io = { to: () => ({ emit: vi.fn() }) } as never;
    const socket = { data: { user: { id: readyOffer.players[1].userId } } } as never;

    await footballGridRematchService.accept(io, socket, {
      matchId: '00000000-0000-4000-8000-000000000100',
      commandId: '00000000-0000-4000-8000-000000000103',
      expectedSeriesVersion: 3,
    });

    expect(withUserSessionLocksMock).toHaveBeenCalledWith(
      readyOffer.players.map((player) => player.userId),
      expect.any(Function),
      { waitMs: 1200 },
    );
    expect(renewActivityFencesMock).toHaveBeenCalledWith(
      readyOffer.players.map((player) => player.userId),
      readyOffer.pairingToken,
      30_000,
    );
    expect(renewActivityFencesMock.mock.invocationCallOrder[0]).toBeLessThan(
      createPairingMock.mock.invocationCallOrder[0],
    );
    expect(createPairingMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMatchMock.mock.invocationCallOrder[0],
    );
    expect(emitMatchFoundMock).toHaveBeenCalledWith(io, { matchId: 'next-grid-match' });
  });

  it('fails closed if either activity fence expired before the locked create', async () => {
    renewActivityFencesMock.mockResolvedValue(false);
    const { footballGridRematchService } = await import('../../src/realtime/services/football-grid-rematch.service.js');
    const io = { to: () => ({ emit: vi.fn() }) } as never;
    const socket = { data: { user: { id: readyOffer.players[1].userId } } } as never;

    await expect(footballGridRematchService.accept(io, socket, {
      matchId: '00000000-0000-4000-8000-000000000100',
      commandId: '00000000-0000-4000-8000-000000000103',
      expectedSeriesVersion: 3,
    })).rejects.toMatchObject({ details: { gridCode: 'REMATCH_ACTIVITY_CONFLICT' } });

    expect(createPairingMock).not.toHaveBeenCalled();
    expect(createMatchMock).not.toHaveBeenCalled();
    expect(closeRematchAfterFailureMock).toHaveBeenCalledWith(
      readyOffer.seriesId,
      readyOffer.pairingToken,
    );
    expect(releaseActivityFencesMock).toHaveBeenCalledWith(
      readyOffer.players.map((player) => player.userId),
      readyOffer.pairingToken,
    );
  });
});
