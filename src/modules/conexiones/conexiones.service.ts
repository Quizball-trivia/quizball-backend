import { logger } from '../../core/logger.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import { conexionesCalendar, RANKED_START } from './conexiones.days.js';
import * as rules from './conexiones.rules.js';

export interface ConexionesDayRow { day: string; number: number; contentVersion: number; board: unknown }
export interface ConexionesRunRow extends DailyRunRowBase<rules.RunState> { secs: number | null }
export interface LeaderboardEntry {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; secs: number;
}
export interface IndexedDay { day: string; number: number; contentVersion: number; board: rules.DayBoard['board'] }

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse { day: string; groups: rules.PublicRunState['groups'] }

/** The kit's runs repo for conexiones_runs / conexiones_days; equal scores rank by fewer seconds, then the earlier finish. */
export const conexionesRepo = createDailyRunsRepo<rules.RunState, ConexionesRunRow, LeaderboardEntry, ConexionesDayRow>(
  { runs: 'conexiones_runs', days: 'conexiones_days', payload: 'board', stat: 'secs' }, { statTiebreak: true, statOrder: 'asc' },
);

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: ConexionesDayRow): IndexedDay | null {
  const parsed = rules.dayBoardSchema.safeParse(row.board);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, board: parsed.data.board } : null;
}

export const conexionesContent = createDailyContentStore(
  { fingerprint: () => conexionesRepo.daysFingerprint(), load: () => conexionesRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Conexiones futboleras' },
);

export interface ConexionesDeps {
  repo: typeof conexionesRepo;
  content: () => Promise<ReadonlyMap<string, IndexedDay>>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * Conexiones futboleras on the daily-game kit. The time is the database clock's (read after the row lock), from
 * opening the board to the last guess; an unsolved group leaves the server once the run is over, the whole board
 * once the day is closed.
 */
export function createConexionesService(deps: ConexionesDeps) {
  const core = createDailyService<rules.RunState, ConexionesRunRow, LeaderboardEntry, IndexedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.secs(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day ? { board: day.board } : null, now, extra),
    },
    { calendar: conexionesCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),
    open: (player: DailyPlayer, runId: string, version: number): Promise<RunResponse> =>
      core.mutate(player, runId, version, (s, _day, now) => ({ state: rules.open(s, now) })),
    guess: (player: DailyPlayer, runId: string, version: number, ids: readonly string[]): Promise<RunResponse> =>
      core.mutate(player, runId, version, (s, day, now) => ({ state: rules.guess(s, day.board, ids, now) })),
    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** The whole board of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const shown = rules.publicState({ ...rules.newState(), done: true }, dayId, { board: day.board }, 0, { ranked: false, disclose: true });
      return { day: dayId, groups: shown.groups };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export const conexionesService = createConexionesService({
  repo: conexionesRepo,
  content: () => conexionesContent.get(),
  contentStale: () => conexionesContent.invalidate(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startConexionesReadinessCheck(): void {
  void conexionesContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Conexiones days loaded (conexiones_days is empty)');
      else logger.info({ days: index.size }, 'Conexiones days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Conexiones days could not be loaded at boot'),
  );
}
