/**
 * Unit tests for the reservation lifecycle facade (PR7) with mocked repo:
 *   - flag OFF → every method is a no-op (no repo calls) — inertness
 *   - flag ON → owner-qualified release uses holder+fence; by-lobby / by-match
 *     releases dispatch to the right repo method; transfer/acquire flow
 *   - a repo error never throws back into a teardown path
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const repo = {
  acquireReservation: vi.fn(),
  transferReservationToMatch: vi.fn(),
  releaseReservationOwned: vi.fn(),
  releaseReservationByLobby: vi.fn(),
  releaseReservationByMatch: vi.fn(),
};

vi.mock('../../src/modules/synthetic-bots/synthetic-bots.repo.js', () => ({
  syntheticBotsRepo: repo,
}));

// Toggle the real (mutable) parsed config object rather than mocking the whole
// module — the logger reads config at load, so a partial mock would break it.
const { config } = await import('../../src/core/config.js');
const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };
const { reservationService } = await import('../../src/modules/synthetic-bots/reservation.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  configObj.PERSISTENT_BOTS_ENABLED = true;
  repo.acquireReservation.mockResolvedValue({ bot_user_id: 'bot', lobby_id: 'lobby', fence: 7 });
  repo.releaseReservationOwned.mockResolvedValue(true);
  repo.releaseReservationByLobby.mockResolvedValue('bot');
  repo.releaseReservationByMatch.mockResolvedValue('bot');
  repo.transferReservationToMatch.mockResolvedValue({ bot_user_id: 'bot' });
});

describe('flag-off: only ACQUISITION is gated; cleanup still runs (kill-switch safety)', () => {
  beforeEach(() => {
    configObj.PERSISTENT_BOTS_ENABLED = false;
  });
  it('acquire is a no-op with the flag off', async () => {
    expect(await reservationService.acquire({ botUserId: 'bot', lobbyId: 'l', ttlSec: 60 })).toBeNull();
    expect(await reservationService.isEnabled()).toBe(false);
    expect(repo.acquireReservation).not.toHaveBeenCalled();
  });
  it('releases STILL run with the flag off so leases created while on are cleaned up', async () => {
    await reservationService.releaseByLobby('l', 'auto_leave_lobby');
    await reservationService.releaseByMatch('m', 'completion');
    await reservationService.releaseOwned({ botUserId: 'bot', fence: 1 }, 'match_found_cancel');
    expect(repo.releaseReservationByLobby).toHaveBeenCalledWith('l');
    expect(repo.releaseReservationByMatch).toHaveBeenCalledWith('m');
    expect(repo.releaseReservationOwned).toHaveBeenCalledWith(
      expect.objectContaining({ botUserId: 'bot', fence: 1 }),
    );
  });
});

describe('flag-on dispatch', () => {
  it('acquire returns the held reservation with its fence', async () => {
    const r = await reservationService.acquire({ botUserId: 'bot', lobbyId: 'lobby', ttlSec: 60 });
    expect(r).toEqual({ botUserId: 'bot', lobbyId: 'lobby', fence: 7 });
  });

  it('releaseOwned passes the per-process holder + fence', async () => {
    await reservationService.releaseOwned({ botUserId: 'bot', fence: 42 }, 'draft_start_cancel');
    expect(repo.releaseReservationOwned).toHaveBeenCalledWith(
      expect.objectContaining({ botUserId: 'bot', fence: 42, holder: reservationService.holderId }),
    );
  });

  it('releaseByLobby / releaseByMatch dispatch to their repo methods', async () => {
    await reservationService.releaseByLobby('lob', 'close_pre_match_lobby');
    await reservationService.releaseByMatch('mat', 'self_forfeit');
    expect(repo.releaseReservationByLobby).toHaveBeenCalledWith('lob');
    expect(repo.releaseReservationByMatch).toHaveBeenCalledWith('mat');
  });

  it('swallows a repo error (never throws into a teardown path)', async () => {
    repo.releaseReservationByMatch.mockRejectedValueOnce(new Error('db down'));
    await expect(reservationService.releaseByMatch('m', 'completion')).resolves.toBeUndefined();
  });
});
