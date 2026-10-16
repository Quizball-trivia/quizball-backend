import type { TransactionSql } from '../../db/index.js';
import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { FootballRaceDayRow, FootballRaceRunRow, LeaderboardEntry, RunState } from './football-race.types.js';

// The score already orders fewer picks first; equal scores go by the earlier finish.
const runs = createDailyRunsRepo<RunState, FootballRaceRunRow, LeaderboardEntry, FootballRaceDayRow>(
  { runs: 'football_race_runs', days: 'football_race_days', payload: 'race', stat: 'picks' },
  { statTiebreak: false },
);

/** The kit's runs repo for football_race_runs / football_race_days; a finished run's board stat is `picks`. */
export const footballRaceRepo = {
  ...runs,
  saveState(
    tx: TransactionSql,
    id: string,
    data: { state: RunState; stateVersion: number; contentVersion: number; completion: { score: number; picks: number } | null },
  ): Promise<FootballRaceRunRow | null> {
    const c = data.completion;
    return runs.saveState(tx, id, { ...data, completion: c ? { score: c.score, stat: c.picks } : null });
  },
};
export type FootballRaceRepo = typeof footballRaceRepo;
