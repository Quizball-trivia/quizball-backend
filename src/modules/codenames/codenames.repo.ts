import type { TransactionSql } from '../../db/index.js';
import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { CodenamesDayRow, CodenamesRunRow, LeaderboardEntry, RunState } from './codenames.types.js';

// The score already orders fewer misses first; equal scores go by the earlier finish.
const runs = createDailyRunsRepo<RunState, CodenamesRunRow, LeaderboardEntry, CodenamesDayRow>(
  { runs: 'codenames_runs', days: 'codenames_days', payload: 'board', stat: 'misses' },
  { statTiebreak: false },
);

/** The kit's runs repo for codenames_runs / codenames_days; a finished run's board stat is `misses`. */
export const codenamesRepo = {
  ...runs,
  saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; misses: number } | null },
  ): Promise<CodenamesRunRow | null> {
    const c = data.completion;
    return runs.saveState(tx, id, { ...data, completion: c ? { score: c.score, stat: c.misses } : null });
  },
};
export type CodenamesRepo = typeof codenamesRepo;
