/**
 * P1-C + P1-2: waiting-lobby leave/disconnect must free the bot WITHOUT Redis and
 * WITHOUT racing a concurrent draft activation. releaseRankedAiLobbyMemberSafely
 * resolves the bot from the DB (lobby_members ⨝ users.is_ai), then delegates the
 * member-removal + reservation-release to reservationService.abortLobby, which
 * performs them atomically under the shared per-lobby advisory lock (re-reads
 * status, no-ops if the draft advanced).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const lobbiesRepo = {
  listMembersWithUser: vi.fn(),
  removeMember: vi.fn().mockResolvedValue(undefined),
  getById: vi.fn(),
};
const reservationService = {
  abortLobby: vi.fn().mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: false }),
};

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
  reservationService.abortLobby.mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: false });
});

describe('releaseRankedAiLobbyMemberSafely (Redis down)', () => {
  it('resolves the bot from the DB and delegates the atomic locked abort (member removal + release)', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN, BOT]);
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    // The bot id came from the DB, and the removal+release happens atomically in
    // abortLobby (which holds the advisory lock) — never a separate unlocked
    // removeMember here.
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', ['persistent-bot'], 'auto_leave_lobby');
    expect(lobbiesRepo.removeMember).not.toHaveBeenCalled();
  });

  it('passes no member ids when there is no bot member (human-only leftover)', async () => {
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN]);
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', [], 'auto_leave_lobby');
  });

  it('resolves the bot even from a Redis-down state (DB is the source of truth)', async () => {
    // getRedisClient is mocked to null; resolution still succeeds via the DB.
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN, BOT]);
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', ['persistent-bot'], 'auto_leave_lobby');
  });

  it('no-ops (abortLobby returns aborted:false) when the lobby advanced to active — bot kept', async () => {
    // Simulate the locked abort observing an advanced lobby.
    reservationService.abortLobby.mockResolvedValueOnce({ aborted: false, botReleased: null, lobbyDeleted: false });
    lobbiesRepo.listMembersWithUser.mockResolvedValueOnce([HUMAN, BOT]);
    await releaseRankedAiLobbyMemberSafely('lobby-1');
    // We still called abortLobby (it is the authority), but it reported no abort,
    // so nothing was torn down here and the reservation was kept.
    expect(reservationService.abortLobby).toHaveBeenCalledWith('lobby-1', ['persistent-bot'], 'auto_leave_lobby');
  });
});
