import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  begin: vi.fn(),
  unsafe: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  heartbeatStop: vi.fn(),
}));

vi.mock('../../src/core/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

vi.mock('../../src/db/index.js', () => ({
  sql: {
    begin: (...args: unknown[]) => state.begin(...args),
  },
}));

vi.mock('../../src/realtime/locks.js', () => ({
  acquireLock: (...args: unknown[]) => state.acquireLock(...args),
  releaseLock: (...args: unknown[]) => state.releaseLock(...args),
  startLockHeartbeat: vi.fn(() => ({ stop: state.heartbeatStop })),
}));

import { footballGridMaintenanceService } from '../../src/modules/football-grid/football-grid-maintenance.service.js';

describe('Football Grid retention maintenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.acquireLock.mockResolvedValue({ acquired: true, token: 'retention-token' });
    state.releaseLock.mockResolvedValue(true);
    state.unsafe.mockResolvedValue([]);
    state.begin.mockImplementation(async (work: (tx: { unsafe: typeof state.unsafe }) => Promise<unknown>) => (
      work({ unsafe: state.unsafe })
    ));
  });

  it('serializes replicas and commits every bounded retention class separately', async () => {
    await footballGridMaintenanceService.run();

    expect(state.acquireLock).toHaveBeenCalledWith('lock:football_grid:retention', 60_000);
    expect(state.begin).toHaveBeenCalledTimes(4);
    expect(state.unsafe.mock.calls.map(([statement]) => statement)).toEqual([
      expect.stringContaining('football_grid_missing_answer_reports'),
      expect.stringContaining('DELETE FROM football_grid_attempts'),
      expect.stringContaining('DELETE FROM football_grid_command_inbox'),
      expect.stringContaining('DELETE FROM football_grid_reward_risk_observations'),
    ]);
    expect(state.heartbeatStop).toHaveBeenCalledOnce();
    expect(state.releaseLock).toHaveBeenCalledWith('lock:football_grid:retention', 'retention-token');
  });

  it('does no database work when another replica owns the maintenance lock', async () => {
    state.acquireLock.mockResolvedValue({ acquired: false });

    await footballGridMaintenanceService.run();

    expect(state.begin).not.toHaveBeenCalled();
  });
});
