import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getMatchMock = vi.fn();
const listMatchPlayersMock = vi.fn();
const getUserByIdMock = vi.fn();
const runInTransactionMock = vi.fn();
const grantXpInTxMock = vi.fn();

vi.mock('../../src/modules/matches/matches.repo.js', () => ({
  matchesRepo: {
    getMatch: (...args: unknown[]) => getMatchMock(...args),
    listMatchPlayers: (...args: unknown[]) => listMatchPlayersMock(...args),
  },
}));

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getById: (...args: unknown[]) => getUserByIdMock(...args),
  },
}));

vi.mock('../../src/modules/progression/progression.repo.js', () => ({
  progressionRepo: {
    runInTransaction: (...args: unknown[]) => runInTransactionMock(...args),
    grantXpInTx: (...args: unknown[]) => grantXpInTxMock(...args),
  },
}));

describe('progressionService.awardCompletedMatchXp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runInTransactionMock.mockImplementation(async (callback: (tx: object) => Promise<unknown>) =>
      callback({ tx: true }),
    );
    grantXpInTxMock.mockResolvedValue({
      awarded: true,
      totalXp: 0,
    });
  });

  it('awards ranked win and loss XP for a completed match', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-1',
      mode: 'ranked',
      status: 'completed',
      is_dev: false,
      winner_user_id: 'user-1',
      state_payload: {
        winnerDecisionMethod: 'goals',
      },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'user-2' },
    ]);
    getUserByIdMock
      .mockResolvedValueOnce({ id: 'user-1', is_ai: false })
      .mockResolvedValueOnce({ id: 'user-2', is_ai: false });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-1');

    expect(grantXpInTxMock).toHaveBeenCalledTimes(2);
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      1,
      { tx: true },
      expect.objectContaining({
        userId: 'user-1',
        sourceType: 'match_result',
        sourceKey: 'match-1',
        xpDelta: 120,
        metadata: expect.objectContaining({
          matchId: 'match-1',
          mode: 'ranked',
          result: 'win',
          winnerDecisionMethod: 'goals',
        }),
      }),
    );
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      2,
      { tx: true },
      expect.objectContaining({
        userId: 'user-2',
        sourceType: 'match_result',
        sourceKey: 'match-1',
        xpDelta: 85,
        metadata: expect.objectContaining({
          result: 'loss',
        }),
      }),
    );
  });

  it('awards draw XP to both players', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-draw',
      mode: 'friendly',
      status: 'completed',
      is_dev: false,
      winner_user_id: null,
      state_payload: {
        winnerDecisionMethod: 'total_points',
      },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'user-2' },
    ]);
    getUserByIdMock
      .mockResolvedValueOnce({ id: 'user-1', is_ai: false })
      .mockResolvedValueOnce({ id: 'user-2', is_ai: false });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-draw');

    expect(grantXpInTxMock).toHaveBeenCalledTimes(2);
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      1,
      { tx: true },
      expect.objectContaining({ userId: 'user-1', xpDelta: 60 }),
    );
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      2,
      { tx: true },
      expect.objectContaining({ userId: 'user-2', xpDelta: 60 }),
    );
  });

  it('awards friendly win and loss XP for a completed match', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-friendly',
      mode: 'friendly',
      status: 'completed',
      is_dev: false,
      winner_user_id: 'user-1',
      state_payload: {
        winnerDecisionMethod: 'goals',
      },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'user-2' },
    ]);
    getUserByIdMock
      .mockResolvedValueOnce({ id: 'user-1', is_ai: false })
      .mockResolvedValueOnce({ id: 'user-2', is_ai: false });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-friendly');

    expect(grantXpInTxMock).toHaveBeenCalledTimes(2);
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      1,
      { tx: true },
      expect.objectContaining({
        userId: 'user-1',
        sourceKey: 'match-friendly',
        xpDelta: 70,
        metadata: expect.objectContaining({
          mode: 'friendly',
          result: 'win',
        }),
      }),
    );
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      2,
      { tx: true },
      expect.objectContaining({
        userId: 'user-2',
        sourceKey: 'match-friendly',
        xpDelta: 50,
        metadata: expect.objectContaining({
          mode: 'friendly',
          result: 'loss',
        }),
      }),
    );
  });

  it('uses reduced forfeit XP for the losing player', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-forfeit',
      mode: 'friendly',
      status: 'completed',
      is_dev: false,
      winner_user_id: 'user-1',
      state_payload: {
        winnerDecisionMethod: 'forfeit',
      },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'user-2' },
    ]);
    getUserByIdMock
      .mockResolvedValueOnce({ id: 'user-1', is_ai: false })
      .mockResolvedValueOnce({ id: 'user-2', is_ai: false });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-forfeit');

    expect(grantXpInTxMock).toHaveBeenCalledTimes(2);
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      1,
      { tx: true },
      expect.objectContaining({ userId: 'user-1', xpDelta: 70 }),
    );
    expect(grantXpInTxMock).toHaveBeenNthCalledWith(
      2,
      { tx: true },
      expect.objectContaining({ userId: 'user-2', xpDelta: 20 }),
    );
  });

  it('skips dev matches', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-dev',
      mode: 'ranked',
      status: 'completed',
      is_dev: true,
      winner_user_id: 'user-1',
      state_payload: { winnerDecisionMethod: 'goals' },
    });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-dev');

    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(runInTransactionMock).not.toHaveBeenCalled();
    expect(grantXpInTxMock).not.toHaveBeenCalled();
  });

  it('awards XP only to human players when AI is present', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-ai',
      mode: 'ranked',
      status: 'completed',
      is_dev: false,
      winner_user_id: 'user-1',
      state_payload: {
        winnerDecisionMethod: 'goals',
      },
    });
    listMatchPlayersMock.mockResolvedValue([
      { user_id: 'user-1' },
      { user_id: 'bot-1' },
    ]);
    getUserByIdMock
      .mockResolvedValueOnce({ id: 'user-1', is_ai: false })
      .mockResolvedValueOnce({ id: 'bot-1', is_ai: true });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-ai');

    expect(grantXpInTxMock).toHaveBeenCalledTimes(1);
    expect(grantXpInTxMock).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        userId: 'user-1',
        sourceKey: 'match-ai',
        xpDelta: 120,
      }),
    );
  });

  it('skips incomplete matches', async () => {
    getMatchMock.mockResolvedValue({
      id: 'match-active',
      mode: 'ranked',
      status: 'active',
      is_dev: false,
      winner_user_id: null,
      state_payload: null,
    });

    const { progressionService } = await import('../../src/modules/progression/progression.service.js');

    await progressionService.awardCompletedMatchXp('match-active');

    expect(listMatchPlayersMock).not.toHaveBeenCalled();
    expect(runInTransactionMock).not.toHaveBeenCalled();
    expect(grantXpInTxMock).not.toHaveBeenCalled();
  });
});
