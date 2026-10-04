import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './minuto.constants.js';
import { createContentStore, type ContentIndex, type IndexedDay } from './minuto.content.js';
import { minutoCalendar, RANKED_START } from './minuto.days.js';
import { contentChanged } from './minuto.errors.js';
import { publicGoal } from './minuto.goal.js';
import { minutoRepo, type MinutoRepo } from './minuto.repo.js';
import * as rules from './minuto.rules.js';
import type { LeaderboardEntry, MinutoRunRow, Player, PublicRunState, ReviewResponse, RunState } from './minuto.types.js';

export type RunResponse = DailyRunResponse<PublicRunState>;
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

type Repo = Pick<MinutoRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard'>;

export interface MinutoDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * "¿En qué minuto?" on the daily-game kit: the kit owns runs, ranking, corrections and guests; this game owns its
 * goals. A goal's minute leaves the server only in the result of the guess that settled it (the guess is stored in
 * the same write), or in the review of a day the database clock has closed.
 */
export function createMinutoService(deps: MinutoDeps) {
  const core = createDailyService<RunState, MinutoRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    {
      ...deps,
      repo: {
        ...deps.repo,
        // The kit speaks { score, stat }; this game's board stat is `exact`.
        saveState: (tx, id, data) => deps.repo.saveState(tx, id, { ...data, completion: data.completion ? { score: data.completion.score, exact: data.completion.stat } : null }),
      },
    },
    {
      newState: rules.newState,
      project: (s) => s,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.exactHits(s) } : null),
      publicState: (s, run, day, _now, extra) => rules.publicState(s, run.day, day?.goals ?? null, extra),
    },
    { calendar: minutoCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS },
  );

  return {
    start: (dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    guess(player: Player, runId: string, version: number, minute: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => {
        const goal = day.goals[s.r];
        if (!goal) throw contentChanged();
        return { state: rules.guess(s, goal, minute, day.goals.length) };
      });
    },

    next(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.next(s) }));
    },

    current: (player: Player, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** Every goal and minute of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      return {
        day: dayId,
        goals: day.goals.map((goal, i) => ({ number: i + 1, goal: publicGoal(goal), minute: { base: goal.minute.base, added: goal.minute.added } })),
      };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export type MinutoService = ReturnType<typeof createMinutoService>;

export const minutoContent = createContentStore(
  { fingerprint: () => minutoRepo.daysFingerprint(), load: () => minutoRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const minutoService = createMinutoService({
  repo: minutoRepo,
  content: () => minutoContent.get(),
  contentStale: () => minutoContent.invalidate(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startMinutoReadinessCheck(): void {
  void minutoContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Minuto days loaded (minuto_days is empty); run npm run minuto:seed');
      else logger.info({ days: index.size }, 'Minuto days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Minuto days could not be loaded at boot'),
  );
}
