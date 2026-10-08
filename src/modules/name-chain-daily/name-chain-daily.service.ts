import { logger } from '../../core/logger.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import type { Universe } from '../footballers/footballers.universe.js';
import { nameChainPackSchema } from '../room/games/name-chain/name-chain.engine.js';
import { draw, pickStart } from '../room/games/name-chain/name-chain.core.js';
import { ANSWER_GRACE_MS, CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP, withUniverses } from '../wordgame-daily/wordgame-daily.shared.js';
import { refusedName } from '../wordgame-reports/wordgame-reports.rules.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { nameChainCalendar, RANKED_START } from './name-chain-daily.days.js';
import * as rules from './name-chain-daily.rules.js';

const SETTLE_BATCH = 100;
const SETTLE_EVERY_MS = 30_000;

export interface NameChainDayRow { day: string; number: number; contentVersion: number; chain: unknown }
export interface NameChainRunRow extends DailyRunRowBase<rules.RunState> { longest: number | null }
export interface LeaderboardEntry {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; longest: number;
}
interface IndexedDay { day: string; number: number; contentVersion: number; release: string; seed: number }
type ServedDay = IndexedDay & { universe: Universe };

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse { day: string; starts: string[] }

/** The kit's runs repo for name_chain_runs / name_chain_days; equal scores rank by the longest chain. */
export const nameChainDailyRepo = createDailyRunsRepo<rules.RunState, NameChainRunRow, LeaderboardEntry, NameChainDayRow>(
  { runs: 'name_chain_runs', days: 'name_chain_days', payload: 'chain', stat: 'longest' }, { statTiebreak: true, openClockIndex: true },
);

/** A stored day in serving form; null when the row is malformed. */
export function indexDay(row: NameChainDayRow): IndexedDay | null {
  const parsed = nameChainPackSchema.safeParse(row.chain);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, release: parsed.data.release, seed: parsed.data.seed } : null;
}

export const nameChainDailyContent = createDailyContentStore(
  { fingerprint: () => nameChainDailyRepo.daysFingerprint(), load: () => nameChainDailyRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Name chain' },
);

export interface NameChainDailyDeps {
  repo: typeof nameChainDailyRepo;
  content: () => Promise<ReadonlyMap<string, ServedDay>>;
  contentStale: () => void;
  now: () => Date;
  reports: Pick<typeof wordgameReportsService, 'file'>;
}

/** The name chain on the daily-game kit. The turn clock is the server's (the database clock, read after the row lock). */
export function createNameChainDailyService(deps: NameChainDailyDeps) {
  const core = createDailyService<rules.RunState, NameChainRunRow, LeaderboardEntry, ServedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.longest(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day?.universe ?? null, now, extra),
      settledAt: rules.settledAt,
    },
    { calendar: nameChainCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    /** Starts the first chain, or the next one after a chain ended. */
    next(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      // The last chain's clock ran out before this `next`: the run is finished by the clock; record that.
      return core.mutate(player, runId, version, (s, day, now, stored) =>
        (s.done && !stored.done ? { state: s, settledAt: rules.settledAt(stored, s) } : { state: rules.next(s, day.universe, day.seed, now) }));
    },

    answer(player: DailyPlayer, runId: string, version: number, text: string): Promise<RunResponse & { result?: rules.AnswerResult }> {
      return core.mutate<{ result: rules.AnswerResult }>(player, runId, version, (s, day, now, stored) => {
        // The clock ran out before this answer arrived: the chain is over (written now) and the answer does not count.
        if (stored.open && !s.open) return { state: s, extra: { result: 'late' }, settledAt: rules.settledAt(stored, s) };
        const out = rules.answer(s, day.universe, day.seed, text, now);
        return { state: out.state, extra: { result: out.result } };
      });
    },

    pass(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, _day, _now, stored) =>
        (stored.open && !s.open ? { state: s, settledAt: rules.settledAt(stored, s) } : { state: rules.pass(s) }));
    },

    /**
     * "That was right": a name the release does not know, from a player whose own run of the day has opened a
     * chain. Answers nothing; a name the release knows (refused for its letter or as a repeat) is dropped.
     */
    async report(player: DailyPlayer, dayId: string, text: string): Promise<void> {
      const day = (await deps.content()).get(dayId);
      if (!day) return;
      const refusal = refusedName(day.universe, text);
      if (!refusal) return;
      const run = await deps.repo.getRun(player, dayId);
      if (!run || run.content_version !== day.contentVersion || (run.state.ch.length === 0 && run.state.n.length === 0)) return;
      await deps.reports.file({
        game: 'name_chain', source: 'daily', contextId: run.id, round: 0,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, refusal, text);
    },

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /**
     * The name a closed day's first chain started from: the one start every player shared. Later chains start from a
     * name that depends on what each player had already used, so they are not part of the day's review. Anything else
     * is the same 404 as a missing day.
     */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const pid = pickStart(day.universe, new Set<string>(), 0, draw(day.seed, 0));
      const name = pid ? day.universe.player(pid)?.name ?? null : null;
      return { day: dayId, starts: name ? [name] : [] };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),

    /** One pass of the settling sweep: chains whose clock ran out with nobody coming back are ended (and the run finished, on the last one). */
    async settleOverdue(): Promise<number> {
      const ids = await deps.repo.overdueRuns(await deps.repo.clock(), ANSWER_GRACE_MS, SETTLE_BATCH);
      for (const id of ids) await core.settleExpired(id).catch((error: unknown) => logger.warn({ err: error, runId: id }, 'Name chain settle failed'));
      return ids.length;
    },
  };
}

export const nameChainDailyService = createNameChainDailyService({
  repo: nameChainDailyRepo,
  content: withUniverses(() => nameChainDailyContent.get()),
  contentStale: () => nameChainDailyContent.invalidate(),
  now: () => new Date(),
  reports: wordgameReportsService,
});

let settleTimer: NodeJS.Timeout | null = null;
let settling = false;

/** Every replica sweeps (row locks make it safe to overlap): a chain left with an expired clock is ended even if the player never returns. */
export function startNameChainDailySweep(): void {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    if (settling) return;
    settling = true;
    void nameChainDailyService.settleOverdue()
      .catch((error: unknown) => logger.warn({ err: error }, 'Name chain settle sweep failed'))
      .finally(() => { settling = false; });
  }, SETTLE_EVERY_MS);
  settleTimer.unref?.();
}

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startNameChainDailyReadinessCheck(): void {
  startNameChainDailySweep();
  void nameChainDailyContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No name chain days loaded (name_chain_days is empty)');
      else logger.info({ days: index.size }, 'Name chain days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Name chain days could not be loaded at boot'),
  );
}
