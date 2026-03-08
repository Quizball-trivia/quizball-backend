import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import { acquireLock, releaseLock } from '../../src/realtime/locks.js';
import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';
import {
  normalizeFriendlyGameMode,
  syncFriendlyLobbyModeForMemberCount,
  syncFriendlyLobbyModeForMemberCountLocked,
} from '../../src/realtime/lobby-utils.js';

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: vi.fn(async () => ({ acquired: true, token: 'lock-token' })),
  releaseLock: vi.fn(async () => true),
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    getById: vi.fn(),
    countMembers: vi.fn(),
    updateLobbySettings: vi.fn(),
    setAllReady: vi.fn(),
  },
}));

describe('lobby-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes unknown friendly game modes to friendly_possession', () => {
    expect(normalizeFriendlyGameMode(undefined)).toBe('friendly_possession');
    expect(normalizeFriendlyGameMode(null)).toBe('friendly_possession');
    expect(normalizeFriendlyGameMode('friendly')).toBe('friendly_possession');
    expect(normalizeFriendlyGameMode('friendly_party_quiz')).toBe('friendly_party_quiz');
    expect(normalizeFriendlyGameMode('ranked_sim')).toBe('ranked_sim');
  });

  it('acquires and releases a lobby lock while forcing party quiz and clearing ready states', async () => {
    vi.mocked(lobbiesRepo.getById).mockResolvedValue({
      id: 'lobby-1',
      mode: 'friendly',
      status: 'waiting',
      game_mode: 'friendly_possession',
      friendly_random: false,
      friendly_category_a_id: 'cat-a',
      friendly_category_b_id: 'cat-b',
    } as never);
    vi.mocked(lobbiesRepo.countMembers).mockResolvedValue(3);
    vi.mocked(lobbiesRepo.updateLobbySettings).mockResolvedValue(undefined as never);
    vi.mocked(lobbiesRepo.setAllReady).mockResolvedValue(undefined as never);

    await syncFriendlyLobbyModeForMemberCount('lobby-1', {
      clearReadyOnPartyTransition: true,
    });

    expect(acquireLock).toHaveBeenCalledWith('lock:lobby:lobby-1', 3000);
    expect(lobbiesRepo.updateLobbySettings).toHaveBeenCalledWith(
      'lobby-1',
      expect.objectContaining({
        gameMode: 'friendly_party_quiz',
        friendlyRandom: false,
        friendlyCategoryAId: 'cat-a',
        friendlyCategoryBId: null,
      })
    );
    expect(lobbiesRepo.setAllReady).toHaveBeenCalledWith('lobby-1', false);
    expect(releaseLock).toHaveBeenCalledWith('lock:lobby:lobby-1', 'lock-token');
  });

  it('skips work when the lobby lock cannot be acquired', async () => {
    vi.mocked(acquireLock).mockResolvedValueOnce({ acquired: false });

    await syncFriendlyLobbyModeForMemberCount('lobby-2');

    expect(lobbiesRepo.getById).not.toHaveBeenCalled();
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('locked variant reuses the caller-held lock and does not reacquire', async () => {
    vi.mocked(lobbiesRepo.getById).mockResolvedValue({
      id: 'lobby-3',
      mode: 'friendly',
      status: 'waiting',
      game_mode: 'friendly_party_quiz',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
    } as never);
    vi.mocked(lobbiesRepo.countMembers).mockResolvedValue(2);

    await syncFriendlyLobbyModeForMemberCountLocked('lobby-3');

    expect(acquireLock).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
  });
});
