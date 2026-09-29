import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './pistas.constants.js';
import { copyClue, copyText, createContentStore, type ContentIndex, type IndexedDay } from './pistas.content.js';
import { pistasCalendar, RANKED_START } from './pistas.days.js';
import { contentChanged } from './pistas.errors.js';
import { pistasRepo, type PistasRepo } from './pistas.repo.js';
import * as rules from './pistas.rules.js';
import type { LeaderboardEntry, PistasRunRow, Player, PublicRunState, ReviewResponse, RunState } from './pistas.types.js';

export type RunResponse = DailyRunResponse<PublicRunState>;
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

type Repo = Pick<PistasRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard'>;

export interface PistasDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  /** The served content turned out older than the database (a correction): re-check it on the next read. */
  contentStale: () => void;
  now: () => Date;
}

/**
 * Pistas on the daily-game kit (shared with Último en pie): the kit owns runs, ranking, corrections and guests;
 * Pistas owns its rounds. Clue texts leave the server only once revealed; answers only as the round and the day allow.
 */
export function createPistasService(deps: PistasDeps) {
  const core = createDailyService<RunState, PistasRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    {
      ...deps,
      repo: {
        ...deps.repo,
        // The kit speaks { score, stat }; Pistas' board stat is `solved`.
        saveState: (tx, id, data) => deps.repo.saveState(tx, id, { ...data, completion: data.completion ? { score: data.completion.score, solved: data.completion.stat } : null }),
      },
    },
    {
      newState: rules.newState,
      project: (s) => s,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.solved(s) } : null),
      // A missed round's answer waits for the database clock to close the day, for every run.
      publicState: (s, run, day, _now, extra) => rules.publicState(s, run.day, day?.rounds[s.r] ?? null, extra),
    },
    { calendar: pistasCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS },
  );

  const roundOf = (s: RunState, day: IndexedDay) => {
    const round = day.rounds[s.r];
    if (!round) throw contentChanged();
    return round;
  };

  return {
    start: (dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    reveal(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.reveal(s) }));
    },

    guess(player: Player, runId: string, version: number, text: string): Promise<RunResponse & { correct?: boolean }> {
      return core.mutate<{ correct: boolean }>(player, runId, version, (s, day) => {
        const result = rules.guess(s, roundOf(s, day), text, day.rounds.length);
        return { state: result.state, extra: { correct: result.correct } };
      });
    },

    giveUp(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.giveUp(s, day.rounds.length) }));
    },

    next(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.next(s) }));
    },

    current: (player: Player, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** Every clue and answer of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      return {
        day: dayId,
        rounds: day.rounds.map((round, i) => ({ number: i + 1, answer: { display: copyText(round.display) }, clues: round.clues.map(copyClue) })),
      };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export type PistasService = ReturnType<typeof createPistasService>;

export const pistasContent = createContentStore(
  { fingerprint: () => pistasRepo.daysFingerprint(), load: () => pistasRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const pistasService = createPistasService({
  repo: pistasRepo,
  content: () => pistasContent.get(),
  contentStale: () => pistasContent.invalidate(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startPistasReadinessCheck(): void {
  void pistasContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Pistas days loaded (pistas_days is empty); run npm run pistas:seed');
      else logger.info({ days: index.size }, 'Pistas days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Pistas days could not be loaded at boot'),
  );
}
