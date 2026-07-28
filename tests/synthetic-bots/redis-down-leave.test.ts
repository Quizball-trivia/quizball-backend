/**
 * P1-C: waiting-lobby leave/disconnect must free the bot WITHOUT Redis, and must
 * NEVER release the reservation while the bot is still a lobby member.
 * releaseRankedAiLobbyMemberSafely resolves the bot from the DB (lobby_members ⨝
 * users.is_ai), removes it, confirms removal, then releases; if removal can't be
 * confirmed it leaves the reservation for the sweeper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const lobbiesRepo = {
  listMembersWithUser: vi.fn(),
  removeMember: vi.fn().mockResolvedValue(undefined),
};
const reservationService = { releaseByLobby: vi.fn().mockResolvedValue(undefined) };

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
// Redis is DOWN — getRedisClient returns null (simulating an outage).
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => null }));

const { releaseRankedAiLobbyMemberSafely } = await import(
  '../../src/realtime/services/lobby-lifecycle.helpers.js'
);

const HUMAN = { user_id: 'human', is_ai: false };
const BOT = { user_id: 'persistent-bot', is_ai: true };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('releaseRankedAiLobbyMemberSafely (Redis down)', () => {
  it('resolves the bot from the DB, removes it, confirms removal, THEN releases', async () => {
    // First listing (resolve) has the bot; second listing (confirm) does not.
    lobbiesRepo.listMembersWithUser
      .mockResolvedValueOnce([HUMAN, BOT]) // resolve
      .mockResolvedValueOnce([]); // confirm: bot gone
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(lobbiesRepo.removeMember).toHaveBeenCalledWith('lobby-1', 'persistent-bot');
    expect(reservationService.releaseByLobby).toHaveBeenCalledWith('lobby-1', 'auto_leave_lobby');
    // removeMember happened before release.
    const removeOrder = lobbiesRepo.removeMember.mock.invocationCallOrder[0];
    const releaseOrder = reservationService.releaseByLobby.mock.invocationCallOrder[0];
    expect(removeOrder).toBeLessThan(releaseOrder);
  });

  it('does NOT release when the bot is still a lobby member after removal (leaves it for the sweeper)', async () => {
    // Confirm listing STILL shows the bot → removal not confirmed → no release.
    lobbiesRepo.listMembersWithUser
      .mockResolvedValueOnce([HUMAN, BOT]) // resolve
      .mockResolvedValueOnce([BOT]); // confirm: bot STILL present
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(lobbiesRepo.removeMember).toHaveBeenCalledWith('lobby-1', 'persistent-bot');
    expect(reservationService.releaseByLobby).not.toHaveBeenCalled();
  });

  it('does NOT release when removeMember throws (leaves it for the sweeper)', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN, BOT]);
    lobbiesRepo.removeMember.mockRejectedValueOnce(new Error('db down'));
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(reservationService.releaseByLobby).not.toHaveBeenCalled();
  });

  it('releases directly when there is no bot member (human-only leftover)', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN]);
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
    expect(reservationService.releaseByLobby).toHaveBeenCalledWith('lobby-1', 'auto_leave_lobby');
  });
});
