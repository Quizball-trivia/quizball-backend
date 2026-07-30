/**
 * Sol P2: releaseRankedAiLobbyMemberSafely must NOT delete the AI lobby Redis key
 * (rankedAiLobbyKey) when the locked abort NO-OPs on a live/committed lobby — that
 * key is being handed off to the match key (rankedAiLobbyKey → rankedAiMatchKey at
 * beginMatchForLobby), so deleting it here would race the handoff and drop a live
 * match's AI marker. The Redis del is gated on the abort actually aborting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../setup.js';

const reservationService = { abortLobby: vi.fn() };
const redis = { isOpen: true, del: vi.fn().mockResolvedValue(1) };

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: { listMembersWithUser: vi.fn(), removeMember: vi.fn(), getById: vi.fn() },
}));
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({ reservationService }));
// Redis is UP here so we can observe whether del() is called.
vi.mock('../../src/realtime/redis.js', () => ({ getRedisClient: () => redis }));

const { releaseRankedAiLobbyMemberSafely } = await import(
  '../../src/realtime/services/lobby-lifecycle.helpers.js'
);
const { rankedAiLobbyKey } = await import('../../src/realtime/ai-ranked.constants.js');

beforeEach(() => {
  vi.clearAllMocks();
  redis.isOpen = true;
});

describe('releaseRankedAiLobbyMemberSafely Redis-key handoff safety (P2)', () => {
  it('does NOT delete the AI lobby key when the abort NO-OPs on a live/committed lobby', async () => {
    reservationService.abortLobby.mockResolvedValue({ aborted: false, botReleased: null, lobbyDeleted: false, removedMemberIds: [] });
    await releaseRankedAiLobbyMemberSafely('lobby-1', 'human-1');
    // The lobby is live; the AI lobby key is mid-handoff to the match key → keep it.
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('DOES delete the (now-stale) AI lobby key when the abort actually tore the lobby down', async () => {
    reservationService.abortLobby.mockResolvedValue({ aborted: true, botReleased: 'bot', lobbyDeleted: true, removedMemberIds: ['human-1', 'bot'] });
    await releaseRankedAiLobbyMemberSafely('lobby-1', 'human-1');
    expect(redis.del).toHaveBeenCalledWith(rankedAiLobbyKey('lobby-1'));
  });
});
