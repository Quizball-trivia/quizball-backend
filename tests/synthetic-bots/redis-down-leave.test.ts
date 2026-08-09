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
const usersRepo = { getByIds: vi.fn() };
const redisState: {
  client: null | {
    isOpen: boolean;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
} = { client: null };

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({ lobbiesRepo }));
vi.mock('../../src/modules/users/users.repo.js', () => ({ usersRepo }));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => redisState.client }));

const {
  getRankedAiUserIdForLobby,
  releaseRankedAiLobbyMemberSafely,
  resolveRankedAiUserIdForDraft,
} = await import(
  '../../src/realtime/services/lobby-lifecycle.helpers.js'
);

beforeEach(() => {
  vi.clearAllMocks();
  redisState.client = null;
  reservationService.abortLobby.mockResolvedValue({ aborted: true, botReleased: 'persistent-bot', lobbyDeleted: true, removedMemberIds: ['human', 'persistent-bot'] });
  usersRepo.getByIds.mockResolvedValue(new Map([
    ['human', { id: 'human', is_ai: false }],
    ['persistent-bot', { id: 'persistent-bot', is_ai: true }],
  ]));
});

describe('ranked AI marker resilience', () => {
  it('does not call a closed Redis client and resolves the bot from lobby members', async () => {
    redisState.client = {
      isOpen: false,
      get: vi.fn().mockRejectedValue(new Error('closed')),
      set: vi.fn().mockRejectedValue(new Error('closed')),
      del: vi.fn(),
    };

    await expect(getRankedAiUserIdForLobby('lobby-1')).resolves.toBeNull();
    await expect(resolveRankedAiUserIdForDraft('lobby-1', [
      { user_id: 'human' },
      { user_id: 'persistent-bot' },
    ])).resolves.toBe('persistent-bot');
    expect(redisState.client.get).not.toHaveBeenCalled();
    expect(redisState.client.set).not.toHaveBeenCalled();
  });

  it('falls back to members when an open Redis client rejects the marker read', async () => {
    redisState.client = {
      isOpen: true,
      get: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn(),
    };

    await expect(resolveRankedAiUserIdForDraft('lobby-1', [
      { user_id: 'human' },
      { user_id: 'persistent-bot' },
    ])).resolves.toBe('persistent-bot');
    expect(redisState.client.set).toHaveBeenCalled();
  });
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
