import { logger } from '../../core/logger.js';
import { createDailyService, type BoardsResponse, type DailyServiceRepo, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import type { TransactionSql } from '../../db/index.js';
import { ANSWER_GRACE_MS, CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './ultimo.constants.js';

const SETTLE_BATCH = 100;
const SETTLE_EVERY_MS = 30_000;
import { createContentStore, type ContentIndex, type IndexedDay } from './ultimo.content.js';
import { RANKED_START, ultimoCalendar } from './ultimo.days.js';
import { contentChanged } from './ultimo.errors.js';
import { copyText } from './ultimo.match.js';
import { ultimoRepo } from './ultimo.repo.js';
import * as rules from './ultimo.rules.js';
import type { LeaderboardEntry, Player, PublicRunState, ReviewResponse, RunState, UltimoRunRow } from './ultimo.types.js';

export type RunResponse = DailyRunResponse<PublicRunState>;
export type { BoardsResponse };
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;

export interface UltimoDeps {
  repo: DailyServiceRepo<RunState, UltimoRunRow, LeaderboardEntry> & {
    clock(tx?: TransactionSql): Promise<number>;
    overdueRuns(beforeMs: number, limit: number): Promise<string[]>;
  };
  content: () => Promise<ContentIndex>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * Último en pie on the daily-game kit (shared with Pistas). The answer clock is the server's: the kit hands every
 * move and read the run projected to now, so an expired clock is the category lost to time. A category's list
 * leaves the server only as its names are said, and the rest only once the day is closed by the database clock.
 */
export function createUltimoService(deps: UltimoDeps) {
  const core = createDailyService<RunState, UltimoRunRow, LeaderboardEntry, IndexedDay, PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.answers(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day?.categories[s.c] ?? null, now, extra, day?.categories ?? []),
      settledAt: rules.settledAt,
    },
    { calendar: ultimoCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  const categoryOf = (s: RunState, day: IndexedDay) => {
    const category = day.categories[s.c];
    if (!category) throw contentChanged();
    return category;
  };

  return {
    start: (dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    begin(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, _day, now) => ({ state: rules.begin(s, now) }));
    },

    answer(player: Player, runId: string, version: number, text: string): Promise<RunResponse & { result?: rules.AnswerResult }> {
      return core.mutate<{ result: rules.AnswerResult }>(player, runId, version, (s, day, now, stored) => {
        // The clock ran out before this answer arrived: the category is over (written now) and the answer does not count.
        if (stored.open && !s.open) return { state: s, extra: { result: 'late' } };
        const out = rules.answer(s, categoryOf(s, day), text, now);
        return { state: out.state, extra: { result: out.result } };
      });
    },

    next(player: Player, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.next(s) }));
    },

    current: (player: Player, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** Every category and answer of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      return {
        day: dayId,
        categories: day.categories.map((c, i) => ({
          number: i + 1, title: copyText(c.title), hint: copyText(c.hint), answers: c.answers.map((a) => copyText(a.display)),
        })),
      };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),

    /** One pass of the settling sweep: runs whose clock ran out with nobody coming back are finished. */
    async settleOverdue(): Promise<number> {
      const ids = await deps.repo.overdueRuns((await deps.repo.clock()) - ANSWER_GRACE_MS, SETTLE_BATCH);
      for (const id of ids) await core.settleExpired(id).catch((error: unknown) => logger.warn({ err: error, runId: id }, 'Último en pie settle failed'));
      return ids.length;
    },
  };
}

export type UltimoService = ReturnType<typeof createUltimoService>;

export const ultimoContent = createContentStore(
  { fingerprint: () => ultimoRepo.daysFingerprint(), load: () => ultimoRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const ultimoService = createUltimoService({
  repo: ultimoRepo,
  content: () => ultimoContent.get(),
  contentStale: () => ultimoContent.invalidate(),
  now: () => new Date(),
});

let settleTimer: NodeJS.Timeout | null = null;
let settling = false;

/**
 * Every replica sweeps (row locks make it safe to overlap): a run left with an expired clock — the tab closed on
 * the last category — is finished and reaches the board even if the player never returns.
 */
export function startUltimoSettleSweep(): void {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    if (settling) return;
    settling = true;
    void ultimoService.settleOverdue()
      .catch((error: unknown) => logger.warn({ err: error }, 'Último en pie settle sweep failed'))
      .finally(() => { settling = false; });
  }, SETTLE_EVERY_MS);
  settleTimer.unref?.();
}

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startUltimoReadinessCheck(): void {
  startUltimoSettleSweep();
  void ultimoContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Último en pie days loaded (ultimo_days is empty); run npm run ultimo:seed');
      else logger.info({ days: index.size }, 'Último en pie days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Último en pie days could not be loaded at boot'),
  );
}
