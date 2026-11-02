import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { contentChanged, rejected, staleState } from '../daily/daily.errors.js';
import { footballGridRepo } from '../football-grid/football-grid.repo.js';
import { footballGridSoloService, type FootballGridSoloVerdict } from '../football-grid/football-grid-solo.service.js';
import type { FootballGridBoardView } from '../football-grid/football-grid.types.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP, REVIEW_SAMPLES_PER_CELL } from './grid-daily.constants.js';
import { createContentStore, isReservedDay, type ContentIndex, type IndexedDay } from './grid-daily.content.js';
import { gridDailyCalendar, RANKED_START } from './grid-daily.days.js';
import { gridDailyRepo, type GridDailyRepo } from './grid-daily.repo.js';
import * as rules from './grid-daily.rules.js';
import type { GridDailyRunRow, LeaderboardEntry, Player, PublicRunState, ReviewResponse, RunState } from './grid-daily.types.js';

/** `serverNow` is the clock the run's start and finish are stamped with, so the web can time the run by it. */
export type RunResponse = DailyRunResponse<PublicRunState> & { board: FootballGridBoardView | null; serverNow: number };
export type GuessResponse = RunResponse & { outcome: 'correct' | 'wrong' | 'ambiguous' | 'already_used' };
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

type Repo = Pick<GridDailyRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard' | 'clock'>;

export interface GridDailyDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  contentStale: () => void;
  now: () => Date;
  board: (boardId: string) => Promise<FootballGridBoardView>;
  judge: (input: { boardId: string; cellIndex: number; text: string; usedPlayerIds: string[] }) => Promise<FootballGridSoloVerdict>;
  samples: (boardId: string, perCell: number) => Promise<ReviewResponse['samples']>;
  /** What a refused name was, read the way the guess was judged; null when the square accepts it (nothing to report). */
  refusal: (input: { boardId: string; cellIndex: number; text: string }) => Promise<{ recognizedPlayerId: string | null } | null>;
  reports: Pick<typeof wordgameReportsService, 'file'>;
}

/**
 * The daily grid on the daily-game kit: the kit owns runs, ranking, corrections and guests; this game owns its
 * nine cells. A day's content is only which board it plays; the board's answers stay in the Tic Tac Toe content
 * and leave the server one judged guess at a time, or as the best-known answers of a day the clock has closed.
 */
export function createGridDailyService(deps: GridDailyDeps) {
  const core = createDailyService<RunState, GridDailyRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    {
      ...deps,
      repo: {
        ...deps.repo,
        // The kit speaks { score, stat }; this game's board stat is `speed`.
        saveState: (tx, id, data) => deps.repo.saveState(tx, id, { ...data, completion: data.completion ? { score: data.completion.score, speed: data.completion.stat } : null }),
      },
    },
    {
      newState: rules.newState,
      project: (s) => s,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.speed(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day, { ...extra, serverNow: now }),
    },
    { calendar: gridDailyCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  async function withBoard<T extends DailyRunResponse<PublicRunState>>(response: T): Promise<T & { board: FootballGridBoardView | null; serverNow: number }> {
    // The squares stay hidden until the player kicks off: the clock and the first look at the board start together.
    // That covers the board's id too, which someone may know from an online game.
    const shown = response.state.startedAt !== null || response.state.done;
    return {
      ...response,
      state: shown ? response.state : { ...response.state, boardId: null },
      board: shown && response.state.boardId ? await deps.board(response.state.boardId) : null,
      // The same clock the run's start and finish are stamped with, so the web's timer cannot disagree with them.
      serverNow: response.state.serverNow,
    };
  }

  return {
    async start(dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> {
      return withBoard(await core.start(dayId, player, clientContentVersion));
    },

    /**
     * One guess: a footballer's name for an empty cell. The name is judged against the run as the caller last saw
     * it; the write then requires that very version, so a guess is never judged against one state and spent on
     * another. A name that could be several footballers is not a guess: nothing is spent.
     */
    async guess(player: Player, input: { day: string; runId: string; version: number; cellIndex: number; text: string }): Promise<GuessResponse> {
      const current = await core.current(player, input.day);
      if (!current.run || !('state' in current) || current.run.id !== input.runId || current.run.version !== input.version) throw staleState();
      const state = current.state;
      if (state.done) throw rejected('run_done');
      if (state.startedAt === null) throw rejected('not_started');
      if (state.cells[input.cellIndex]) throw rejected('cell_filled');
      const boardId = state.boardId;
      if (!boardId) throw contentChanged();
      const verdict = await deps.judge({
        boardId,
        cellIndex: input.cellIndex,
        text: input.text,
        usedPlayerIds: state.cells.flatMap((cell) => (cell ? [cell.playerId] : [])),
      });
      if (verdict.outcome === 'ambiguous') return { ...(await withBoard(current)), outcome: 'ambiguous' };
      const response = await core.mutate(player, input.runId, input.version, (s, day, now) => {
        if (day.boardId !== boardId) throw contentChanged();
        return { state: verdict.outcome === 'correct' ? rules.fill(s, input.cellIndex, verdict.player, now) : rules.miss(s, input.cellIndex, now) };
      });
      return { ...(await withBoard(response)), outcome: verdict.outcome };
    },

    /**
     * A name the square refused that the player says fits both clues: kept privately for the content review (the
     * square's two clue keys, the board, the text and the footballer it names on the board, if any). It is not a move:
     * no guess is spent or given back, the run is untouched, and it can be sent mid-run or after the finish. A name
     * the square accepts (a correction published since) or one that could be several footballers is not stored.
     * Never throws for a report it drops: a report is a favour from the player.
     */
    async report(player: Player, input: { day: string; cellIndex: number; text: string }): Promise<void> {
      const current = await core.current(player, input.day);
      if (!current.run || !('state' in current)) return;
      const state = current.state;
      // Only a square the player has seen: the board is shown from the kick-off on.
      if (!state.boardId || (state.startedAt === null && !state.done)) return;
      const refusal = await deps.refusal({ boardId: state.boardId, cellIndex: input.cellIndex, text: input.text });
      if (!refusal) return;
      const board = await deps.board(state.boardId);
      const row = board.rows[Math.floor(input.cellIndex / 3)];
      const column = board.columns[input.cellIndex % 3];
      if (!row || !column) return;
      await deps.reports.file({
        game: 'grid_daily', source: 'daily', contextId: current.run.id, round: input.cellIndex,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, {
        // The board pins its release; the subject is the square's claim, "row clue|column clue".
        release: state.boardId,
        subject: `${row.key}|${column.key}`,
        resolvedPid: refusal.recognizedPlayerId,
      }, input.text);
    },

    /** Shows the board and starts the clock. */
    async kickOff(player: Player, runId: string, version: number): Promise<RunResponse> {
      return withBoard(await core.mutate(player, runId, version, (s, _day, now) => ({ state: rules.kickOff(s, now) })));
    },

    async finish(player: Player, runId: string, version: number): Promise<RunResponse> {
      return withBoard(await core.mutate(player, runId, version, (s, _day, now) => ({ state: rules.finish(s, now) })));
    },

    async current(player: Player, dayId: string | undefined): Promise<RunResponse | { run: null }> {
      const current = await core.current(player, dayId);
      return current.run && 'state' in current ? withBoard(current) : { run: null };
    },

    boards: (): Promise<BoardsResponse> => core.boards(),

    /** The board and the best-known answers of a day the database clock has closed; anything else is a 404. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const [board, samples] = await Promise.all([deps.board(day.boardId), deps.samples(day.boardId, REVIEW_SAMPLES_PER_CELL)]);
      return { day: dayId, board, samples };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export type GridDailyService = ReturnType<typeof createGridDailyService>;

export const gridDailyContent = createContentStore(
  {
    fingerprint: () => gridDailyRepo.daysFingerprint(),
    // A day the seed script has reserved but not yet published is not served (see scripts/grid-daily-seed-days.ts).
    load: async () => (await gridDailyRepo.loadDays()).filter((row) => !isReservedDay(row)),
  },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const gridDailyService = createGridDailyService({
  repo: gridDailyRepo,
  content: () => gridDailyContent.get(),
  contentStale: () => gridDailyContent.invalidate(),
  now: () => new Date(),
  board: (boardId) => footballGridRepo.getBoardView(boardId),
  judge: (input) => footballGridSoloService.judge(input),
  samples: (boardId, perCell) => footballGridSoloService.samples(boardId, perCell),
  refusal: (input) => footballGridSoloService.refusal(input),
  reports: wordgameReportsService,
});

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startGridDailyReadinessCheck(): void {
  void gridDailyContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No daily grid days loaded (grid_daily_days is empty); run scripts/grid-daily-seed-days.ts');
      else logger.info({ days: index.size }, 'Daily grid days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Daily grid days could not be loaded at boot'),
  );
}
