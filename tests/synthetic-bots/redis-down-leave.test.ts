/**
 * P1-C + P1-2: waiting-lobby leave/disconnect frees the bot WITHOUT Redis and
 * WITHOUT racing a draft activation. releaseRankedAiLobbyMemberSafely delegates
 * entirely to reservationService.abortLobby — the ONE locked primitive that,
 * under the shared per-lobby advisory lock, re-reads status and (only if still
 * waiting/gone) removes ALL members + frees the reservation + deletes the lobby
 * in one transaction. No Redis dependency, no unlocked member removal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const reservationService = {
  abortLobby: vi.fn().mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: true, removedMemberIds: ['human', 'persistent-bot'] }),
};
// lobbiesRepo is imported by the helpers module but not used by this function now.
const lobbiesRepo = { listMembersWithUser: vi.fn(), removeMember: vi.fn(), getById: vi.fn() };

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
// Redis is DOWN — getRedisClient returns null (simulating an outage).
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

const { releaseRankedAiLobbyMemberSafely } = await import(
  '../../src/realtime/services/lobby-lifecycle.helpers.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  reservationService.abortLobby.mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: true, removedMemberIds: ['human', 'persistent-bot'] });
});

describe('releaseRankedAiLobbyMemberSafely (Redis down)', () => {
  it('delegates to the locked abort primitive (no Redis, no unlocked member removal)', async () => {
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'auto_leave_lobby');
    // The function does NOT do its own unlocked member removal — the primitive
    // handles it atomically under the lock.
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
  });

  it('no-ops (abortLobby returns aborted:false) when the lobby advanced to active — bot kept', async () => {
    reservationService.abortLobby.mockResolvedValueOnce({ aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] });
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    // Still delegated to the authority; it reported no abort → nothing torn down.
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', 'auto_leave_lobby');
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
  });
});
