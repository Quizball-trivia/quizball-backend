import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '../setup.js';

const listMembersWithUserMock = vi.fn();
const createMatchMock = vi.fn();
const insertMatchPlayersMock = vi.fn();
const getUserByIdMock = vi.fn();
const ensureProfileMock = vi.fn();
const buildAiMatchContextMock = vi.fn();
const markMatchCompletedMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const recordUserModeStatsMock = vi.fn();

/**
 * Stand-in for `sql.begin(cb)`. Just invokes the callback with a sentinel
 * `tx` value and resolves with whatever it returns — the repo mocks below
 * don't actually need a postgres transaction handle.
 */
const sqlBeginMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb('tx'));

vi.mock('../../src/db/index.js', () => ({
  sql: Object.assign((..._args: unknown[]) => undefined, {
    begin: (cb: (tx: unknown) => Promise<unknown>) => sqlBeginMock(cb),
  }),
}));

vi.mock('../../src/core/index.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/modules/lobbies/lobbies.repo.js', () => ({
  lobbiesRepo: {
    listMembersWithUser: (...args: unknown[]) => listMembersWithUserMock(...args),
  },
}));

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    createMatch: (...args: unknown[]) => createMatchMock(...args),
    insertMatchPlayers: (...args: unknown[]) => insertMatchPlayersMock(...args),
    markMatchCompleted: (...args: unknown[]) => markMatchCompletedMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
    recordUserModeStats: (...args: unknown[]) => recordUserModeStatsMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
  },
}));

vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: {
    ensureProfile: (...args: unknown[]) => ensureProfileMock(...args),
    buildAiMatchContext: (...args: unknown[]) => buildAiMatchContextMock(...args),
  },
}));

describe('matches.service friendly-party-quiz variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMembersWithUserMock.mockResolvedValue([]);
    createMatchMock.mockResolvedValue({ id: 'match-1' });
    insertMatchPlayersMock.mockResolvedValue(undefined);
    getUserByIdMock.mockResolvedValue({ id: 'user-1', is_ai: false });
    ensureProfileMock.mockResolvedValue({ placementStatus: 'placed' });
    buildAiMatchContextMock.mockReturnValue(null);
  });

  it('creates the initial party quiz state with the default v1 question count', async () => {
    const {
      PARTY_QUIZ_TOTAL_QUESTIONS,
      createInitialPartyQuizState,
    } = await import('../../src/modules/matches/matches.service.js');

    expect(createInitialPartyQuizState()).toEqual({
      version: 1,
      variant: 'friendly_party_quiz',
      totalQuestions: PARTY_QUIZ_TOTAL_QUESTIONS,
      currentQuestion: null,
      answeredUserIds: [],
      winnerDecisionMethod: null,
      stateVersionCounter: 0,
    });
  });

  it('resolves explicit and fallback match variants correctly', async () => {
    const { resolveMatchVariant } = await import('../../src/modules/matches/matches.service.js');

    expect(resolveMatchVariant({ variant: 'friendly_party_quiz' }, 'friendly')).toBe('friendly_party_quiz');
    expect(resolveMatchVariant({ variant: 'friendly_possession' }, 'friendly')).toBe('friendly_possession');
    expect(resolveMatchVariant(null, 'friendly')).toBe('friendly_possession');
    expect(resolveMatchVariant(null, 'ranked')).toBe('ranked_sim');
  });

  it('creates party quiz matches with host-first player ordering and sequential seats', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'guest-a' },
      { user_id: 'host-user' },
      { user_id: 'guest-b' },
      { user_id: 'guest-c' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-party',
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'host-user',
      categoryAId: 'cat-party',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-party',
      mode: 'friendly',
      categoryAId: 'cat-party',
      categoryBId: null,
      totalQuestions: 10,
      statePayload: expect.objectContaining({
        variant: 'friendly_party_quiz',
        totalQuestions: 10,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
      { userId: 'guest-b', seat: 3 },
      { userId: 'guest-c', seat: 4 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a', 'guest-b', 'guest-c']);
    expect(result.variant).toBe('friendly_party_quiz');
  });

  it('creates 2-player party quiz matches when the host selects that variant', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
      { user_id: 'guest-a' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-party-duel',
      mode: 'friendly',
      variant: 'friendly_party_quiz',
      hostUserId: 'host-user',
      categoryAId: 'cat-party',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-party-duel',
      mode: 'friendly',
      categoryAId: 'cat-party',
      categoryBId: null,
      totalQuestions: 10,
      statePayload: expect.objectContaining({
        variant: 'friendly_party_quiz',
        totalQuestions: 10,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a']);
    expect(result.variant).toBe('friendly_party_quiz');
  });

  it('rejects party quiz creation when the lobby has fewer than 2 members', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(
      matchesService.createMatchFromLobby({
        lobbyId: 'lobby-too-small',
        mode: 'friendly',
        variant: 'friendly_party_quiz',
        hostUserId: 'host-user',
        categoryAId: 'cat-party',
        categoryBId: null,
      })
    ).rejects.toMatchObject({
      message: 'Party quiz requires between 2 and 6 members',
    });
    expect(createMatchMock).not.toHaveBeenCalled();
  });

  // ── completeMatch tests are in their own describe block below ──

  it('keeps two-player friendly creation on the possession variant', async () => {
    listMembersWithUserMock.mockResolvedValue([
      { user_id: 'host-user' },
      { user_id: 'guest-a' },
    ]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    const result = await matchesService.createMatchFromLobby({
      lobbyId: 'lobby-duel',
      mode: 'friendly',
      variant: 'friendly_possession',
      hostUserId: 'host-user',
      categoryAId: 'cat-duel',
      categoryBId: null,
    });

    expect(createMatchMock).toHaveBeenCalledWith({
      lobbyId: 'lobby-duel',
      mode: 'friendly',
      categoryAId: 'cat-duel',
      categoryBId: null,
      totalQuestions: 12,
      statePayload: expect.objectContaining({
        variant: 'friendly_possession',
        normalQuestionsPerHalf: 6,
      }),
      rankedContext: null,
      isDev: undefined,
    });
    expect(insertMatchPlayersMock).toHaveBeenCalledWith('match-1', [
      { userId: 'host-user', seat: 1 },
      { userId: 'guest-a', seat: 2 },
    ]);
    expect(result.playerIds).toEqual(['host-user', 'guest-a']);
    expect(result.variant).toBe('friendly_possession');
  });
});

describe('matches.service completeMatch', () => {
  const matchId = 'match-99';
  const userA = 'user-a';
  const userB = 'user-b';

  beforeEach(() => {
    vi.clearAllMocks();
    sqlBeginMock.mockImplementation(async (cb) => cb('tx'));
    markMatchCompletedMock.mockResolvedValue({
      id: matchId,
      mode: 'friendly',
      ended_at: '2026-01-01T00:00:00.000Z',
      is_dev: false,
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: userA, seat: 1 },
      { user_id: userB, seat: 2 },
    ]);
    recordUserModeStatsMock.mockResolvedValue(undefined);
  });

  it('increments wins/losses for the winning player and their opponent', async () => {
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledWith('tx', matchId, userA);
    expect(listMatchPlayersMock).toHaveBeenCalledWith(matchId, 'tx');
    expect(recordUserModeStatsMock).toHaveBeenCalledTimes(1);
    const [, statRows] = (recordUserModeStatsMock.mock.calls[0] as [unknown, Array<Record<string, unknown>>]);
    expect(statRows).toEqual([
      { userId: userA, mode: 'friendly', wins: 1, losses: 0, draws: 0, lastMatchAt: '2026-01-01T00:00:00.000Z' },
      { userId: userB, mode: 'friendly', wins: 0, losses: 1, draws: 0, lastMatchAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('increments draws for both players when winnerId is null', async () => {
    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, null);

    expect(markMatchCompletedMock).toHaveBeenCalledWith('tx', matchId, null);
    const [, statRows] = (recordUserModeStatsMock.mock.calls[0] as [unknown, Array<Record<string, unknown>>]);
    expect(statRows).toEqual([
      { userId: userA, mode: 'friendly', wins: 0, losses: 0, draws: 1, lastMatchAt: '2026-01-01T00:00:00.000Z' },
      { userId: userB, mode: 'friendly', wins: 0, losses: 0, draws: 1, lastMatchAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('skips the stats upsert entirely on dev matches', async () => {
    markMatchCompletedMock.mockResolvedValue({
      id: matchId,
      mode: 'friendly',
      ended_at: '2026-01-01T00:00:00.000Z',
      is_dev: true,
    });

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledOnce();
    // Crucially: no roster read, no stats write — dev matches don't pollute
    // aggregate stats.
    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(recordUserModeStatsMock).not.toHaveBeenCalled();
  });

  it('is idempotent on a double-call (markMatchCompleted returns null the second time)', async () => {
    markMatchCompletedMock
      .mockResolvedValueOnce({
        id: matchId,
        mode: 'friendly',
        ended_at: '2026-01-01T00:00:00.000Z',
        is_dev: false,
      })
      .mockResolvedValueOnce(null); // 2nd call hits the `WHERE status = 'active'` guard

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await matchesService.completeMatch(matchId, userA);
    await matchesService.completeMatch(matchId, userA);

    expect(markMatchCompletedMock).toHaveBeenCalledTimes(2);
    expect(recordUserModeStatsMock).toHaveBeenCalledTimes(1); // not twice
  });

  it('does not write stats when the roster is empty (defensive guard)', async () => {
    listMatchPlayersMock.mockResolvedValue([]);

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');
    await matchesService.completeMatch(matchId, userA);

    expect(recordUserModeStatsMock).not.toHaveBeenCalled();
  });

  it('rolls the whole transaction back when the stats upsert throws', async () => {
    // Atomicity smoke: when the repo's stats upsert throws, completeMatch
    // should propagate the error (which causes sql.begin to roll back the
    // markMatchCompleted UPDATE in production — the match stays 'active'
    // and a retry will work).
    recordUserModeStatsMock.mockRejectedValueOnce(new Error('boom'));

    const { matchesService } = await import('../../src/modules/matches/matches.service.js');

    await expect(matchesService.completeMatch(matchId, userA)).rejects.toThrow('boom');
    expect(markMatchCompletedMock).toHaveBeenCalledOnce();
  });
});
