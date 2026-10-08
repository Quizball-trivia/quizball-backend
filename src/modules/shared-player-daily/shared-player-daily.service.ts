import { logger } from '../../core/logger.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { contentChanged } from '../daily/daily.errors.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import type { Universe } from '../footballers/footballers.universe.js';
import { sharedPlayerPackSchema, type SharedPlayerItem } from '../room/games/shared-player/shared-player.engine.js';
import { ANSWER_GRACE_MS, CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP, withUniverses } from '../wordgame-daily/wordgame-daily.shared.js';
import { refusedForPair } from '../wordgame-reports/wordgame-reports.rules.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { RANKED_START, sharedPlayerCalendar } from './shared-player-daily.days.js';
import * as rules from './shared-player-daily.rules.js';

const SETTLE_BATCH = 100;
const SETTLE_EVERY_MS = 30_000;

export interface SharedPlayerDayRow { day: string; number: number; contentVersion: number; pairs: unknown }
export interface SharedPlayerRunRow extends DailyRunRowBase<rules.RunState> { speed: number | null }
export interface LeaderboardEntry {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; speed: number;
}
interface IndexedDay { day: string; number: number; contentVersion: number; release: string; pairs: SharedPlayerItem[] }
type ServedDay = IndexedDay & { universe: Universe };

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse { day: string; pairs: rules.PublicPairResult[] }

/** The kit's runs repo for shared_player_runs / shared_player_days; equal scores rank by `speed` (faster first). */
export const sharedPlayerDailyRepo = createDailyRunsRepo<rules.RunState, SharedPlayerRunRow, LeaderboardEntry, SharedPlayerDayRow>(
  { runs: 'shared_player_runs', days: 'shared_player_days', payload: 'pairs', stat: 'speed' }, { statTiebreak: true, openClockIndex: true },
);

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: SharedPlayerDayRow): IndexedDay | null {
  const parsed = sharedPlayerPackSchema.safeParse(row.pairs);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, release: parsed.data.release, pairs: parsed.data.pairs } : null;
}

export const sharedPlayerDailyContent = createDailyContentStore(
  { fingerprint: () => sharedPlayerDailyRepo.daysFingerprint(), load: () => sharedPlayerDailyRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Played for both' },
);

export interface SharedPlayerDailyDeps {
  repo: typeof sharedPlayerDailyRepo;
  content: () => Promise<ReadonlyMap<string, ServedDay>>;
  contentStale: () => void;
  now: () => Date;
  reports: Pick<typeof wordgameReportsService, 'file'>;
}

/**
 * "Played for both" on the daily-game kit. The pair clock is the server's (the database clock, read after the row
 * lock); the accepted footballers of a pair never leave the server before its day is closed.
 */
export function createSharedPlayerDailyService(deps: SharedPlayerDailyDeps) {
  const core = createDailyService<rules.RunState, SharedPlayerRunRow, LeaderboardEntry, ServedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.speed(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day?.pairs ?? null, day?.universe ?? null, now, extra),
      settledAt: rules.settledAt,
    },
    { calendar: sharedPlayerCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    /** Opens the first pair, or the next one after a settled pair. */
    next(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      // The last pair's clock ran out before this `next`: the run is finished by the clock; record that.
      return core.mutate(player, runId, version, (s, _day, now, stored) =>
        (s.done && !stored.done ? { state: s, settledAt: rules.settledAt(stored, s) } : { state: rules.next(s, now) }));
    },

    answer(player: DailyPlayer, runId: string, version: number, text: string): Promise<RunResponse & { result?: rules.AnswerResult }> {
      return core.mutate<{ result: rules.AnswerResult }>(player, runId, version, (s, day, now, stored) => {
        // The clock ran out before this answer arrived: the pair is over (written now) and the answer does not count.
        if (stored.open && !s.open) return { state: s, extra: { result: 'late' }, settledAt: rules.settledAt(stored, s) };
        const pair = day.pairs[s.r];
        if (!pair) throw contentChanged();
        const out = rules.answer(s, pair, day.universe, text, now);
        return { state: out.state, extra: { result: out.result } };
      });
    },

    /**
     * "That was right": a text refused on a pair the player's own run has finished with. Answers nothing (it is no
     * oracle); a text the pair accepts, a pair not played yet or a run on older content is simply dropped.
     */
    async report(player: DailyPlayer, dayId: string, pairIndex: number, text: string): Promise<void> {
      const day = (await deps.content()).get(dayId);
      const pair = day?.pairs[pairIndex];
      if (!day || !pair) return;
      const run = await deps.repo.getRun(player, dayId);
      if (!run || run.content_version !== day.contentVersion || pairIndex >= run.state.res.length) return;
      const refusal = refusedForPair(day.universe, pair, text);
      if (!refusal) return;
      await deps.reports.file({
        game: 'shared_player', source: 'daily', contextId: run.id, round: pairIndex,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, refusal, text);
    },

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** Every pair of a day the database clock has closed, with a few of its answers; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const shown = rules.publicState({ ...rules.newState(), res: day.pairs.map(() => ({ pid: null, left: 0 })), done: true }, dayId, day.pairs, day.universe, 0, { ranked: false, disclose: true });
      return { day: dayId, pairs: shown.results };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),

    /** One pass of the settling sweep: runs whose clock ran out with nobody coming back are settled (and finished, on the last pair). */
    async settleOverdue(): Promise<number> {
      const ids = await deps.repo.overdueRuns(await deps.repo.clock(), ANSWER_GRACE_MS, SETTLE_BATCH);
      for (const id of ids) await core.settleExpired(id).catch((error: unknown) => logger.warn({ err: error, runId: id }, 'Played for both settle failed'));
      return ids.length;
    },
  };
}

export const sharedPlayerDailyService = createSharedPlayerDailyService({
  repo: sharedPlayerDailyRepo,
  content: withUniverses(() => sharedPlayerDailyContent.get()),
  contentStale: () => sharedPlayerDailyContent.invalidate(),
  now: () => new Date(),
  reports: wordgameReportsService,
});

let settleTimer: NodeJS.Timeout | null = null;
let settling = false;

/** Every replica sweeps (row locks make it safe to overlap): a run left with an expired clock is settled even if the player never returns. */
export function startSharedPlayerDailySweep(): void {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    if (settling) return;
    settling = true;
    void sharedPlayerDailyService.settleOverdue()
      .catch((error: unknown) => logger.warn({ err: error }, 'Played for both settle sweep failed'))
      .finally(() => { settling = false; });
  }, SETTLE_EVERY_MS);
  settleTimer.unref?.();
}

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startSharedPlayerDailyReadinessCheck(): void {
  startSharedPlayerDailySweep();
  void sharedPlayerDailyContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No played-for-both days loaded (shared_player_days is empty)');
      else logger.info({ days: index.size }, 'Played for both days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Played for both days could not be loaded at boot'),
  );
}
