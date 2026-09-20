import { afterEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { footballGridRepo } from '../../src/modules/football-grid/football-grid.repo.js';
import { footballGridService } from '../../src/modules/football-grid/football-grid.service.js';
import { createFootballGridState } from '../../src/modules/football-grid/football-grid.engine.js';

describe('Grid cancellation rechecks activity under the state lock', () => {
  afterEach(() => vi.restoreAllMocks());
  function fixture(stale: boolean) {
    const criterion = (id: string) => ({ id, key: id, family: 'club' as const, labelEn: id, labelKa: id, assetKey: null, difficulty: 'normal' as const });
    const state = createFootballGridState({
      matchId: 'stale-recheck',
      board: { boardId: 'board', boardVersion: 1, checksum: 'checksum', rows: [criterion('a'), criterion('b'), criterion('c')], columns: [criterion('d'), criterion('e'), criterion('f')] },
      players: [{ userId: 'u1', seat: 1 }, { userId: 'u2', seat: 2 }], openerUserId: 'u1', nowMs: 1000,
    });
    const tx = {} as never;
    vi.spyOn(footballGridRepo, 'runInTransaction').mockImplementation(async work => work(tx));
    const load = vi.spyOn(footballGridRepo, 'loadStateForUpdate').mockResolvedValue(state);
    const recheck = vi.spyOn(footballGridRepo, 'isStaleInTransaction').mockResolvedValue(stale);
    vi.spyOn(footballGridRepo, 'databaseNowMs').mockResolvedValue(1000000);
    const save = vi.spyOn(footballGridRepo, 'persistStateInTx').mockResolvedValue(undefined);
    return { state, tx, load, recheck, save };
  }
  it('preserves a match that received an action after the initial stale lookup', async () => {
    const { state, tx, load, recheck, save } = fixture(false);
    expect(await footballGridService.cancelAdministratively(state.matchId, { olderThanMs: 900000 })).toBe(state);
    expect(recheck).toHaveBeenCalledWith(tx, state.matchId, 900000);
    expect(load.mock.invocationCallOrder[0]).toBeLessThan(recheck.mock.invocationCallOrder[0]);
    expect(save).not.toHaveBeenCalled();
  });
  it('cancels an actually stale match through the normal state transition', async () => {
    const { state, save } = fixture(true);
    const result = await footballGridService.cancelAdministratively(state.matchId, { olderThanMs: 900000 });
    expect(result.phase).toBe('terminal');
    expect(save).toHaveBeenCalledOnce();
  });
});
