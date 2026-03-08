import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import '../setup.js';

const listMembersWithUserMock = vi.fn();
const createMatchMock = vi.fn();
const insertMatchPlayersMock = vi.fn();
const getUserByIdMock = vi.fn();
const ensureProfileMock = vi.fn();
const isPlacementRequiredMock = vi.fn();
const buildPlacementAiContextMock = vi.fn();

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
    isPlacementRequired: (...args: unknown[]) => isPlacementRequiredMock(...args),
    buildPlacementAiContext: (...args: unknown[]) => buildPlacementAiContextMock(...args),
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
    isPlacementRequiredMock.mockReturnValue(false);
    buildPlacementAiContextMock.mockReturnValue(null);
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
