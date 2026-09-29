import type { TransactionSql } from '../../db/index.js';
import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { LeaderboardEntry, PistasDayRow, PistasRunRow, RunState } from './pistas.types.js';

const runs = createDailyRunsRepo<RunState, PistasRunRow, LeaderboardEntry, PistasDayRow>({
  runs: 'pistas_runs', days: 'pistas_days', payload: 'rounds', stat: 'solved',
});

/** The kit's runs repo for pistas_runs / pistas_days; a finished run's board stat is `solved`. */
export const pistasRepo = {
  ...runs,
  saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; solved: number } | null },
  ): Promise<PistasRunRow | null> {
    const c = data.completion;
    return runs.saveState(tx, id, { ...data, completion: c ? { score: c.score, stat: c.solved } : null });
  },
};

export type PistasRepo = typeof pistasRepo;
