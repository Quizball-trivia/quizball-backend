import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { compare } from '../room/games/football-race/football-race.rules.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './football-race.constants.js';
import { createContentStore, type ContentIndex, type IndexedDay } from './football-race.content.js';
import { footballRaceCalendar, RANKED_START } from './football-race.days.js';
import { footballRaceRepo, type FootballRaceRepo } from './football-race.repo.js';
import * as rules from './football-race.rules.js';
import type { FootballRaceRunRow, LeaderboardEntry, Player, PublicRunState, ReviewResponse, RunState } from './football-race.types.js';

export type RunResponse = DailyRunResponse<PublicRunState>;
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

type Repo = Pick<FootballRaceRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard' | 'clock'>;

export interface FootballRaceDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * Football Horserace's daily race on the daily-game kit: the kit owns runs, ranking, corrections and guests; this game
 * owns its races. A stat's values leave the server only in the result of the pick that played it.
 */
export function createFootballRaceService(deps: FootballRaceDeps) {
  const core = createDailyService<RunState, FootballRaceRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    {
      ...deps,
      repo: {
        ...deps.repo,
        saveState: (tx, id, data) => deps.repo.saveState(tx, id, { ...data, completion: data.completion ? { score: data.completion.score, picks: data.completion.stat } : null }),
      },
    },
    {
      newState: rules.newState,
      project: (s) => s,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: s.res.length } : null),
      publicState: (s, run, day, _now, extra) => rules.publicState(s, run.day, day?.race ?? null, extra),
    },
    { calendar: footballRaceCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS },
  );

  return {
    start: (dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> => { return core.start(dayId, player, clientContentVersion); },
    pick(player: Player, runId: string, version: number, stat: string): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.pick(s, day.race, stat) }));
    },
    current: (player: Player, dayId: string | undefined) => { return core.current(player, dayId); },
    boards: (): Promise<BoardsResponse> => { return core.boards(); },
    /** Who led each stat of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const { racers, data } = day.race;
      const metricOf = new Map(data.metrics.map((m) => [m.id, m]));
      const leaders = Object.fromEntries(data.stats.map((x) => [x.id, compare(x, metricOf.get(x.metric)!, racers)?.leaders ?? []]));
      return { day: dayId, tournament: { id: data.tournament.id, label: data.tournament.label }, racers, leaders };
    },
    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => { return core.leaderboard(dayId, userId); },
  };
}

export const footballRaceContent = createContentStore(
  { fingerprint: () => footballRaceRepo.daysFingerprint(), load: () => footballRaceRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const footballRaceService = createFootballRaceService({
  repo: footballRaceRepo,
  content: () => footballRaceContent.get(),
  contentStale: () => footballRaceContent.invalidate(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. */
export function startFootballRaceReadinessCheck(): void {
  void footballRaceContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Football Horserace days loaded (football_race_days is empty)');
      else logger.info({ days: index.size }, 'Football Horserace days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Football Horserace days could not be loaded at boot'),
  );
}
