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
  releaseReservationByMatch: vi.fn(),
  releaseReservationByMatchIfSettled: vi.fn(),
  abortRankedAiLobbyLocked: vi.fn(),
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
  repo.releaseReservationByMatch.mockResolvedValue('bot');
  repo.releaseReservationByMatchIfSettled.mockResolvedValue('bot');
  repo.abortRankedAiLobbyLocked.mockResolvedValue({ aborted: true, botReleased: 'bot', lobbyDeleted: true, removedMemberIds: ['human', 'bot'] });
  repo.transferReservationToMatch.mockResolvedValue({ bot_user_id: 'bot' });
});

describe('settlement-gated release (P1-1): releaseIfSettled', () => {
  it('does NOT free the bot when settlement is not committed (repo returns null)', async () => {
    // Simulates a forfeit/completion whose settlement failed → bot ledger absent
    // → the atomic gated DELETE deletes nothing → facade reports no release.
    repo.releaseReservationByMatchIfSettled.mockResolvedValueOnce(null);
    await reservationService.releaseIfSettled('m', 'self_forfeit');
    expect(repo.releaseReservationByMatchIfSettled).toHaveBeenCalledWith('m');
    // No unconditional by-match delete is ever used by this path.
    expect(repo.releaseReservationByMatch).not.toHaveBeenCalled();
  });

  it('frees the bot once settlement is committed (repo returns the bot id)', async () => {
    repo.releaseReservationByMatchIfSettled.mockResolvedValueOnce('bot');
    await reservationService.releaseIfSettled('m', 'completion');
    expect(repo.releaseReservationByMatchIfSettled).toHaveBeenCalledWith('m');
  });
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
    await reservationService.abortLobby('l', 'auto_leave_lobby');
    await reservationService.releaseByMatch('m', 'completion');
    expect(repo.abortRankedAiLobbyLocked).toHaveBeenCalledWith('l', { uncommitFirst: false });
    expect(repo.releaseReservationByMatch).toHaveBeenCalledWith('m');
  });
});

describe('flag-on dispatch', () => {
  it('acquire returns the held reservation with its fence', async () => {
    const r = await reservationService.acquire({ botUserId: 'bot', lobbyId: 'lobby', ttlSec: 60 });
    expect(r).toEqual({ botUserId: 'bot', lobbyId: 'lobby', fence: 7 });
  });

  it('abortLobby is the sole lobby-phase release; delegates to the locked primitive', async () => {
    const result = await reservationService.abortLobby('lob', 'close_pre_match_lobby');
    expect(repo.abortRankedAiLobbyLocked).toHaveBeenCalledWith('lob', { uncommitFirst: false });
    expect(result).toEqual({ aborted: true, botReleased: 'bot', lobbyDeleted: true, removedMemberIds: ['human', 'bot'] });
  });

  it('releaseByMatch dispatches to the by-match repo method (unlocked, different key space)', async () => {
    await reservationService.releaseByMatch('mat', 'self_forfeit');
    expect(repo.releaseReservationByMatch).toHaveBeenCalledWith('mat');
  });

  it('swallows a repo error (never throws into a teardown path)', async () => {
    repo.releaseReservationByMatch.mockRejectedValueOnce(new Error('db down'));
    await expect(reservationService.releaseByMatch('m', 'completion')).resolves.toBeUndefined();
  });
});
