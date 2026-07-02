import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests the zero-interaction no-contest finalizer: a ghost ranked match where
// no human ever genuinely submitted an answer must be abandoned (no winner, no
// RP change) with every human's ranked ticket refunded.

const acquireLockMock = vi.fn();
const releaseLockMock = vi.fn();
const startLockHeartbeatMock = vi.fn();
const getMatchMock = vi.fn();
const setMatchStatePayloadMock = vi.fn();
const abandonMatchMock = vi.fn();
const completeMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getByIdsMock = vi.fn();
const refundRankedTicketsMock = vi.fn();
const deleteMatchCacheMock = vi.fn();
const getRedisClientMock = vi.fn();

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...a: unknown[]) => acquireLockMock(...a),
  releaseLock: (...a: unknown[]) => releaseLockMock(...a),
  startLockHeartbeat: (...a: unknown[]) => startLockHeartbeatMock(...a),
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...a: unknown[]) => getMatchMock(...a),
    setMatchStatePayload: (...a: unknown[]) => setMatchStatePayloadMock(...a),
  },
}));

vi.mock('../../src/modules/matches/matches.service.js', () => ({
  matchesService: {
    abandonMatch: (...a: unknown[]) => abandonMatchMock(...a),
    completeMatch: (...a: unknown[]) => completeMatchMock(...a),
  },
}));

vi.mock('../../src/modules/matches/match-players.repo.js', () => ({
  matchPlayersRepo: {
    listMatchPlayers: (...a: unknown[]) => listMatchPlayersMock(...a),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: (...a: unknown[]) => refundRankedTicketsMock(...a) },
}));

vi.mock('../../src/realtime/match-cache.js', () => ({
  deleteMatchCache: (...a: unknown[]) => deleteMatchCacheMock(...a),
}));

vi.mock('../../src/realtime/redis.js', () => ({
  getRedisClient: () => getRedisClientMock(),
}));

vi.mock('../../src/realtime/match-keys.js', () => ({
  lastMatchKey: (id: string) => `last-match:${id}`,
}));

const MATCH_ID = 'match-uuid';
const HUMAN_A = 'human-a';
const HUMAN_B = 'human-b';

describe('finalizeRankedMatchAsNoContest — zero human interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLockMock.mockResolvedValue({ acquired: true, token: 'lock-token' });
    releaseLockMock.mockResolvedValue(undefined);
    startLockHeartbeatMock.mockReturnValue({ stop: vi.fn() });
    getMatchMock.mockResolvedValue({
      id: MATCH_ID,
      mode: 'ranked',
      status: 'active',
      state_payload: { variant: 'ranked_sim' },
      current_q_index: 12,
    });
    setMatchStatePayloadMock.mockResolvedValue(undefined);
    abandonMatchMock.mockResolvedValue(undefined);
    deleteMatchCacheMock.mockResolvedValue(undefined);
    listMatchPlayersMock.mockResolvedValue([{ user_id: HUMAN_A }, { user_id: HUMAN_B }]);
    getByIdsMock.mockResolvedValue(new Map([
      [HUMAN_A, { id: HUMAN_A, is_ai: false }],
      [HUMAN_B, { id: HUMAN_B, is_ai: false }],
    ]));
    refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
    getRedisClientMock.mockReturnValue(null);
  });

  it('abandons the match and refunds both humans, never completing it (no winner/RP)', async () => {
    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(true);
    expect(abandonMatchMock).toHaveBeenCalledWith(MATCH_ID);
    expect(completeMatchMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).toHaveBeenCalledTimes(1);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN_A, HUMAN_B]);
    expect(setMatchStatePayloadMock).toHaveBeenCalledWith(
      MATCH_ID,
      expect.objectContaining({ cancelledNoContest: true })
    );
  });

  it('only refunds the human when the opponent is an AI', async () => {
    listMatchPlayersMock.mockResolvedValue([{ user_id: HUMAN_A }, { user_id: 'ai-bot' }]);
    getByIdsMock.mockResolvedValue(new Map([
      [HUMAN_A, { id: HUMAN_A, is_ai: false }],
      ['ai-bot', { id: 'ai-bot', is_ai: true }],
    ]));

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN_A]);
  });

  it('is a no-op when the match is no longer active (idempotent under lock races)', async () => {
    getMatchMock.mockResolvedValue({ id: MATCH_ID, status: 'completed' });

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(false);
    expect(abandonMatchMock).not.toHaveBeenCalled();
    expect(refundRankedTicketsMock).not.toHaveBeenCalled();
  });

  it('reports not completed when the completion lock is already held', async () => {
    acquireLockMock.mockResolvedValue({ acquired: false, token: null });

    const { finalizeRankedMatchAsNoContest } = await import(
      '../../src/realtime/services/ranked-no-contest.service.js'
    );

    const result = await finalizeRankedMatchAsNoContest({ matchId: MATCH_ID, roundsPlayed: 12 });

    expect(result.completed).toBe(false);
    expect(getMatchMock).not.toHaveBeenCalled();
  });
});
