import { createDailyRunsRepo } from '../daily/daily.repo.js';
import type { LeaderboardEntry, RunState, UltimoDayRow, UltimoRunRow } from './ultimo.types.js';

/** The kit's runs repo for ultimo_runs / ultimo_days; a finished run's board stat is `answers` (names said). */
export const ultimoRepo = createDailyRunsRepo<RunState, UltimoRunRow, LeaderboardEntry, UltimoDayRow>({
  runs: 'ultimo_runs', days: 'ultimo_days', payload: 'categories', stat: 'answers',
});

export type UltimoRepo = typeof ultimoRepo;
