import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './codenames.constants.js';
import { createContentStore, type ContentIndex, type IndexedDay } from './codenames.content.js';
import { codenamesCalendar, RANKED_START } from './codenames.days.js';
import { codenamesRepo, type CodenamesRepo } from './codenames.repo.js';
import * as rules from './codenames.rules.js';
import type { CodenamesRunRow, LeaderboardEntry, Player, PublicRunState, ReviewResponse, RunState } from './codenames.types.js';

export type RunResponse = DailyRunResponse<PublicRunState>;
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

type Repo = Pick<CodenamesRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard' | 'clock'>;

export interface CodenamesDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * Football Codenames' daily board on the daily-game kit: the kit owns runs, ranking, corrections and guests; this game
 * owns its board. A card's kind leaves the server when it is flipped; the key, when the run is over.
 */
export function createCodenamesService(deps: CodenamesDeps) {
  const core = createDailyService<RunState, CodenamesRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    {
      ...deps,
      repo: {
        ...deps.repo,
        saveState: (tx, id, data) => deps.repo.saveState(tx, id, { ...data, completion: data.completion ? { score: data.completion.score, misses: data.completion.stat } : null }),
      },
    },
    {
      newState: rules.newState,
      project: (s) => s,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.misses(s) } : null),
      publicState: (s, run, day, _now, extra) => rules.publicState(s, run.day, day?.board ?? null, extra),
    },
    { calendar: codenamesCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS },
  );

  return {
    start: (dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),
    flip(player: Player, runId: string, version: number, card: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.flip(s, day.board, card) }));
    },
    stop(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.stop(s, day.board) }));
    },
    current: (player: Player, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),
    /** The whole board of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      return { day: dayId, cards: day.board.cards, clues: day.board.clues };
    },
    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export const codenamesContent = createContentStore(
  { fingerprint: () => codenamesRepo.daysFingerprint(), load: () => codenamesRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const codenamesService = createCodenamesService({
  repo: codenamesRepo,
  content: () => codenamesContent.get(),
  contentStale: () => codenamesContent.invalidate(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. */
export function startCodenamesReadinessCheck(): void {
  void codenamesContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Football Codenames days loaded (codenames_days is empty)');
      else logger.info({ days: index.size }, 'Football Codenames days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Football Codenames days could not be loaded at boot'),
  );
}
