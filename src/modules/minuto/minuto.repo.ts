import type { TransactionSql } from '../../db/index.js';
import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { LeaderboardEntry, MinutoDayRow, MinutoRunRow, RunState } from './minuto.types.js';

const runs = createDailyRunsRepo<RunState, MinutoRunRow, LeaderboardEntry, MinutoDayRow>(
  { runs: 'minuto_runs', days: 'minuto_days', payload: 'goals', stat: 'exact' },
  // Equal scores: more exact minutes ranks higher, then the earlier finish.
  { statTiebreak: true },
);

/** The kit's runs repo for minuto_runs / minuto_days; a finished run's board stat is `exact` (exact minutes). */
export const minutoRepo = {
  ...runs,
  saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; exact: number } | null },
  ): Promise<MinutoRunRow | null> {
    const c = data.completion;
    return runs.saveState(tx, id, { ...data, completion: c ? { score: c.score, stat: c.exact } : null });
  },
};

export type MinutoRepo = typeof minutoRepo;
