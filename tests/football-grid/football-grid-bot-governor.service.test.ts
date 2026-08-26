import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: true,
  insertObservation: vi.fn(),
  ensureAndLockState: vi.fn(),
  updateState: vi.fn(),
  insertActionAudit: vi.fn(),
  runInTransaction: vi.fn(),
}));

vi.mock('../../src/core/config.js', () => ({
  config: {
    get FOOTBALL_GRID_BOT_GOVERNOR_ENABLED() { return mocks.enabled; },
  },
}));

vi.mock('../../src/modules/football-grid/football-grid-bot-governor.repo.js', () => ({
  footballGridBotGovernorRepo: {
    insertObservationInTx: (...args: unknown[]) => mocks.insertObservation(...args),
    ensureAndLockStateInTx: (...args: unknown[]) => mocks.ensureAndLockState(...args),
    updateStateInTx: (...args: unknown[]) => mocks.updateState(...args),
    insertActionAuditInTx: (...args: unknown[]) => mocks.insertActionAudit(...args),
    runInTransaction: (...args: unknown[]) => mocks.runInTransaction(...args),
  },
}));

import { footballGridBotGovernorService } from '../../src/modules/football-grid/football-grid-bot-governor.service.js';

const tx = {} as never;
const policy = { modelVersion: 2, configVersion: 1, botTier: 'Captain' };
const observation = {
  ...policy,
  matchId: 'match-1',
  pinnedStrengthAdjustment: -0.025,
  outcomeScore: 1 as const,
  completionReason: 'line' as const,
  now: new Date('2026-08-26T10:00:00.000Z'),
};

describe('Football Tic Tac Toe bot governor transaction orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = true;
    mocks.insertObservation.mockResolvedValue(true);
    mocks.ensureAndLockState.mockResolvedValue({
      strengthAdjustment: -0.025,
      scoreEma: 0.8,
      observationCount: 19,
      observationsAtAdjustment: 0,
      adjustmentUpdatedAt: null,
    });
    mocks.updateState.mockResolvedValue(undefined);
    mocks.runInTransaction.mockImplementation(async (fn: (input: unknown) => unknown) => fn(tx));
  });

  it('pins the locked tier adjustment and pins zero when the kill switch is off', async () => {
    await expect(footballGridBotGovernorService.pinStrengthAdjustmentInTx(tx, policy)).resolves.toBe(-0.025);
    expect(mocks.ensureAndLockState).toHaveBeenCalledOnce();

    mocks.enabled = false;
    await expect(footballGridBotGovernorService.pinStrengthAdjustmentInTx(tx, policy)).resolves.toBe(0);
    expect(mocks.ensureAndLockState).toHaveBeenCalledTimes(2);
  });

  it('does not fold a replay whose idempotent observation insert returned no row', async () => {
    mocks.insertObservation.mockResolvedValue(false);
    await expect(footballGridBotGovernorService.observeSettlementInTx(tx, observation)).resolves.toBeNull();
    expect(mocks.ensureAndLockState).not.toHaveBeenCalled();
    expect(mocks.updateState).not.toHaveBeenCalled();
  });

  it('inserts the observation before locking and updating shared tier state', async () => {
    const decision = await footballGridBotGovernorService.observeSettlementInTx(tx, observation);
    expect(decision?.trigger).toBe('high_score_nerf');
    expect(mocks.insertObservation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureAndLockState.mock.invocationCallOrder[0],
    );
    expect(mocks.ensureAndLockState.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateState.mock.invocationCallOrder[0],
    );
    expect(mocks.updateState).toHaveBeenCalledWith(tx, expect.objectContaining({
      state: expect.objectContaining({
        observationCount: 20,
        strengthAdjustment: -0.05,
        observationsAtAdjustment: 20,
      }),
    }));
  });

  it('continues folding while disabled and resets stored strength to zero', async () => {
    mocks.enabled = false;
    const decision = await footballGridBotGovernorService.observeSettlementInTx(tx, observation);
    expect(decision?.trigger).toBe('disabled_reset');
    expect(mocks.updateState).toHaveBeenCalledWith(tx, expect.objectContaining({
      state: expect.objectContaining({ strengthAdjustment: 0, observationCount: 20 }),
    }));
  });
});
