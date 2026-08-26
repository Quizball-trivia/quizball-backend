import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';
import { acquireLock, releaseLock } from '../../src/realtime/locks.js';
import { lobbiesRepo } from '../../src/modules/lobbies/lobbies.repo.js';
import {
  attachUserSocketsToLobby,
  emitLobbyState,
  maxMembersForFriendlyGameMode,
  normalizeFriendlyGameMode,
  orderLobbyMembersByJoinTime,
  playableMembersForFriendlyGameMode,
  syncFriendlyLobbyModeForMemberCount,
  syncFriendlyLobbyModeForMemberCountLocked,
} from '../../src/realtime/lobby-utils.js';

const buildLobbyStateMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.service.js', () => ({
  lobbiesService: {
    buildLobbyState: (...args: unknown[]) => buildLobbyStateMock(...args),
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
    expect(normalizeFriendlyGameMode('auction')).toBe('auction');
    expect(normalizeFriendlyGameMode('ranked_sim')).toBe('ranked_sim');
    expect(normalizeFriendlyGameMode('football_grid')).toBe('football_grid');
  });

  it('caps auction lobbies at 3 members and everything else at the party ceiling', () => {
    expect(maxMembersForFriendlyGameMode('auction')).toBe(3);
    expect(maxMembersForFriendlyGameMode('football_grid')).toBe(2);
    expect(maxMembersForFriendlyGameMode('friendly_party_quiz')).toBe(6);
    // Possession may HOLD more than 2 — it auto-promotes to party quiz.
    expect(maxMembersForFriendlyGameMode('friendly_possession')).toBe(6);
  });

  it('reports playable size per mode (possession is strictly a duel)', () => {
    expect(playableMembersForFriendlyGameMode('auction')).toBe(3);
    expect(playableMembersForFriendlyGameMode('football_grid')).toBe(2);
    expect(playableMembersForFriendlyGameMode('friendly_possession')).toBe(2);
    expect(playableMembersForFriendlyGameMode('ranked_sim')).toBe(2);
    expect(playableMembersForFriendlyGameMode('friendly_party_quiz')).toBe(6);
  });

  it('orders lobby members when Postgres returns joined_at as Date objects', () => {
    const later = { userId: 'later', joined_at: new Date('2026-08-26T12:00:01.000Z') };
    const earlier = { userId: 'earlier', joined_at: new Date('2026-08-26T12:00:00.000Z') };

    expect(orderLobbyMembersByJoinTime([later, earlier]).map((member) => member.userId)).toEqual([
      'earlier',
      'later',
    ]);
  });

  it('EDGE 1/5: a 3-member auction lobby is never auto-promoted to party quiz', async () => {
    vi.mocked(lobbiesRepo.getById).mockResolvedValue({
      id: 'lobby-auction',
      mode: 'friendly',
      status: 'waiting',
      game_mode: 'auction',
      friendly_random: true,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
    } as never);
    vi.mocked(lobbiesRepo.countMembers).mockResolvedValue(3);

    await syncFriendlyLobbyModeForMemberCountLocked('lobby-auction', {
      clearReadyOnPartyTransition: true,
    });

    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
    // The expected 3rd auction member must not wipe ready states.
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
  });

  it('keeps a two-player Football Grid lobby isolated from party auto-promotion', async () => {
    vi.mocked(lobbiesRepo.getById).mockResolvedValue({
      id: 'lobby-grid',
      mode: 'friendly',
      status: 'waiting',
      game_mode: 'football_grid',
      friendly_random: false,
      friendly_category_a_id: null,
      friendly_category_b_id: null,
    } as never);
    vi.mocked(lobbiesRepo.countMembers).mockResolvedValue(2);

    await syncFriendlyLobbyModeForMemberCountLocked('lobby-grid', {
      clearReadyOnPartyTransition: true,
    });

    expect(lobbiesRepo.updateLobbySettings).not.toHaveBeenCalled();
    expect(lobbiesRepo.setAllReady).not.toHaveBeenCalled();
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

  it('does not attach sockets from a mismatched user room to a lobby', async () => {
    const goodSocket = {
      data: { user: { id: 'u1' }, lobbyId: undefined },
      join: vi.fn(),
      leave: vi.fn(),
    };
    const staleSocket = {
      data: { user: { id: 'u2' }, lobbyId: undefined },
      join: vi.fn(),
      leave: vi.fn(),
    };
    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => [goodSocket, staleSocket]),
      })),
    };

    await attachUserSocketsToLobby(io as never, 'u1', 'lobby-1');

    expect(goodSocket.join).toHaveBeenCalledWith('lobby:lobby-1');
    expect(goodSocket.data.lobbyId).toBe('lobby-1');
    expect(staleSocket.join).not.toHaveBeenCalled();
    expect(staleSocket.leave).toHaveBeenCalledWith('user:u1');
    expect(staleSocket.data.lobbyId).toBeUndefined();
  });

  it('emits lobby state only to member user rooms and removes stale lobby sockets', async () => {
    const memberSocket = {
      data: { user: { id: 'u1' }, lobbyId: 'lobby-1' },
      leave: vi.fn(),
    };
    const staleSocket = {
      data: { user: { id: 'u2' }, lobbyId: 'lobby-1' },
      leave: vi.fn(),
    };
    const emit = vi.fn();
    const io = {
      in: vi.fn(() => ({
        fetchSockets: vi.fn(async () => [memberSocket, staleSocket]),
      })),
      to: vi.fn(() => ({ emit })),
    };
    const lobby = {
      id: 'lobby-1',
      mode: 'friendly',
      status: 'waiting',
      game_mode: 'friendly_possession',
    };
    const state = {
      lobbyId: 'lobby-1',
      mode: 'friendly',
      status: 'waiting',
      inviteCode: 'ABC123',
      displayName: 'Lobby',
      isPublic: false,
      hostUserId: 'u1',
      settings: {
        gameMode: 'friendly_possession',
        friendlyRandom: true,
        friendlyCategoryAId: null,
        friendlyCategoryBId: null,
      },
      members: [
        { userId: 'u1', username: 'u1', avatarUrl: null, isReady: false, isHost: true },
      ],
    };
    vi.mocked(lobbiesRepo.getById).mockResolvedValue(lobby as never);
    buildLobbyStateMock.mockResolvedValue(state);

    await emitLobbyState(io as never, 'lobby-1');

    expect(staleSocket.leave).toHaveBeenCalledWith('lobby:lobby-1');
    expect(staleSocket.data.lobbyId).toBeUndefined();
    expect(memberSocket.leave).not.toHaveBeenCalled();
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(emit).toHaveBeenCalledWith('lobby:state', state);
  });
});
