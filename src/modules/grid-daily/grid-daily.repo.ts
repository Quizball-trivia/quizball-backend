import type { TransactionSql } from '../../db/index.js';
import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { GridDailyDayRow, GridDailyRunRow, LeaderboardEntry, RunState } from './grid-daily.types.js';

const runs = createDailyRunsRepo<RunState, GridDailyRunRow, LeaderboardEntry, GridDailyDayRow>(
  { runs: 'grid_daily_runs', days: 'grid_daily_days', payload: 'board', stat: 'speed' },
  // Equal scores: the faster run ranks higher, then the earlier finish.
  { statTiebreak: true },
);

/** The kit's runs repo for grid_daily_runs / grid_daily_days; a finished run's board stat is `speed`. */
export const gridDailyRepo = {
  ...runs,
  saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; speed: number } | null },
  ): Promise<GridDailyRunRow | null> {
    const c = data.completion;
    return runs.saveState(tx, id, { ...data, completion: c ? { score: c.score, stat: c.speed } : null });
  },
};

export type GridDailyRepo = typeof gridDailyRepo;
