import { NotFoundError } from '../../core/errors.js';
import { contentGaps } from '../content-gaps/content-gaps.recorder.js';
import { safeGap, type GapSeen } from '../content-gaps/content-gaps.buffer.js';
import { nameChainGap } from '../footballers/footballers.gaps.js';
import { logger } from '../../core/logger.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { releaseDay } from '../daily/daily.calendar.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { activeGreekVersion, greekIndex, heldGreekIndex } from '../footballers/footballers.greek.js';
import { activeRussianVersion, heldRussianIndex, russianIndex } from '../footballers/footballers.russian.js';
import { rejected } from '../daily/daily.errors.js';
import type { Universe } from '../footballers/footballers.universe.js';
import { nameChainPackSchema } from '../room/games/name-chain/name-chain.engine.js';
import { draw, pickStart } from '../room/games/name-chain/name-chain.core.js';
import {
  ANSWER_GRACE_MS, CONTENT_REFRESH_MS, frozenUniverse, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP, overlaysForStart, withUniverses,
} from '../wordgame-daily/wordgame-daily.shared.js';
import { refusedName } from '../wordgame-reports/wordgame-reports.rules.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { nameChainCalendar, RANKED_START } from './name-chain-daily.days.js';
import { practiceStep, type PracticeFrozen, type PracticeRequest, type PracticeResponse } from './name-chain-daily.practice.js';
import * as rules from './name-chain-daily.rules.js';

const SETTLE_BATCH = 100;
const SETTLE_EVERY_MS = 30_000;
const GREEK_BOARD_TTL_MS = 60_000;

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
  { runs: 'name_chain_runs', days: 'name_chain_days', payload: 'chain', stat: 'longest' }, { statTiebreak: true, openClockIndex: true, boardPartition: 'al' },
);

/** The day as one run sees it: with the Russian and Greek names it froze, on the letters it plays with. */
async function dayForRun(day: ServedDay, s: rules.RunState, outsideTx = false): Promise<ServedDay> {
  if (!s.ov && !s.oe) return day;
  return { ...day, universe: await frozenUniverse(day.universe, s, rules.alphabetOf(s), outsideTx) };
}

/**
 * A version a practice chain froze, when this process can judge with it without loading an arbitrary one: held in
 * memory, or the active one. A chain whose version is gone (evicted, or another replica) must start again.
 */
async function practiceVersion(version: string | undefined, held: (v: string) => unknown, active: () => Promise<string | null>, load: (v: string) => Promise<unknown>): Promise<void> {
  if (!version || held(version)) return;
  if (version !== (await active().catch(() => null)) || !(await load(version).then(() => true, () => false))) throw rejected('practice_restart');
}

/** The run state a practice chain is judged as: frozen at its start, else (a chain from an older client) today's names. */
async function practiceState(input: PracticeRequest): Promise<rules.RunState> {
  const frozen = input.op === 'start' ? undefined : input.frozen;
  if (!frozen) return rules.newState({ locale: input.locale, ...(await overlaysForStart()) });
  await practiceVersion(frozen.ov, heldRussianIndex, () => activeRussianVersion(), russianIndex);
  await practiceVersion(frozen.oe, heldGreekIndex, () => activeGreekVersion(), greekIndex);
  return { ...rules.newState(), ...frozen };
}

const frozenOf = (s: rules.RunState): PracticeFrozen => ({ ...(s.ov ? { ov: s.ov } : {}), ...(s.oe ? { oe: s.oe } : {}), ...(s.al ? { al: s.al } : {}) });

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
  /** One draw in [0, 1) for a practice chain's start name (practice is not seeded: every chain can differ). */
  random?: () => number;
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
      dayFor: dayForRun,
      // Russian- and Greek-letter runs play a different chain: each ranks on its own board.
      boardPartition: (s) => s.al ?? '',
    },
    { calendar: nameChainCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  /** Whether a day has Greek-letter runs, re-read at most once a minute per day (a guest's board needs no run lookup). */
  const greekBoards = new Map<string, { partition: string; at: number }>();
  async function greekBoardOf(day: string): Promise<string> {
    const now = Date.now();
    const known = greekBoards.get(day);
    if (known && now - known.at < GREEK_BOARD_TTL_MS) return known.partition;
    const partition = (await deps.repo.commonStateValue(day, 'oe', { key: 'al', value: 'gr' }).catch(() => null)) ? 'gr' : '';
    if (greekBoards.size > 64) greekBoards.clear();
    greekBoards.set(day, { partition, at: now });
    return partition;
  }

  return {
    /** A run freezes the Russian and Greek names switched on now (Latin runs too: a name typed in Cyrillic or Greek is read with them). */
    async start(dayId: string, player: DailyPlayer, clientContentVersion?: number, locale?: string): Promise<RunResponse> {
      // Loaded here, before the run's transaction; a version that cannot be loaded now is not frozen.
      return core.start(dayId, player, clientContentVersion, { locale, ...(await overlaysForStart()) });
    },

    /** Starts the first chain, or the next one after a chain ended. */
    next(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      // The last chain's clock ran out before this `next`: the run is finished by the clock; record that.
      return core.mutate(player, runId, version, (s, day, now, stored) =>
        (s.done && !stored.done ? { state: s, settledAt: rules.settledAt(stored, s) } : { state: rules.next(s, day.universe, day.seed, now) }));
    },

    async answer(player: DailyPlayer, runId: string, version: number, text: string): Promise<RunResponse & { result?: rules.AnswerResult }> {
      const seen: { gap: GapSeen | null } = { gap: null };
      const response = await core.mutate<{ result: rules.AnswerResult }>(player, runId, version, (s, day, now, stored) => {
        seen.gap = null;
        // The clock ran out before this answer arrived: the chain is over (written now) and the answer does not count.
        if (stored.open && !s.open) return { state: s, extra: { result: 'late' }, settledAt: rules.settledAt(stored, s) };
        const out = rules.answer(s, day.universe, day.seed, text, now);
        if (out.result === 'unknown') seen.gap = safeGap(() => nameChainGap(day.universe, text, s.ov, s.oe));
        return { state: out.state, extra: { result: out.result } };
      });
      if (seen.gap) contentGaps.record({ ...seen.gap, mode: 'daily' });
      return response;
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
      const served = (await deps.content()).get(dayId);
      if (!served) return;
      const run = await deps.repo.getRun(player, dayId);
      if (!run || run.content_version !== served.contentVersion || (run.state.ch.length === 0 && run.state.n.length === 0)) return;
      // Judged as the run was: with the names it froze.
      const day = await dayForRun(served, run.state, true);
      const refusal = refusedName(day.universe, text);
      if (!refusal) return;
      await deps.reports.file({
        game: 'name_chain', source: 'daily', contextId: run.id, round: 0,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, refusal, text);
    },

    /**
     * Relaxed practice: one step of an untimed chain the browser holds. No run row, no clock, no score and no
     * leaderboard; judged on the release of the newest served day, with the Russian and Greek names switched on now (a
     * Russian interface plays Russian letters and a Greek one Greek letters, as their daily does). A chain keeps the
     * names and letters its start froze (`frozen`, echoed by the client).
     */
    async practice(input: PracticeRequest): Promise<PracticeResponse> {
      const served = await deps.content();
      const today = releaseDay(deps.now());
      const newest = [...served.keys()].filter((id) => id <= today).sort().at(-1);
      if (newest === undefined) throw new NotFoundError('No name chain day to practise on');
      const s = await practiceState(input);
      const day = await dayForRun(served.get(newest)!, s, true);
      return { ...practiceStep(day.universe, rules.alphabetOf(s), input, (deps.random ?? Math.random)()), frozen: frozenOf(s) };
    },

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /**
     * The name a closed day's first chain started from: the one start every player shared. Later chains start from a
     * name that depends on what each player had already used, so they are not part of the day's review. Anything else
     * is the same 404 as a missing day.
     */
    async review(dayId: string, locale?: string): Promise<ReviewResponse> {
      const closed = await core.closedDay(dayId);
      // The names the day's Russian runs played with (a later version could change the start or a spelling); else today's.
      const version = locale === 'ru'
        ? (await deps.repo.commonStateValue(dayId, 'ov', { key: 'al', value: 'cy' }).catch(() => null)) ?? (await activeRussianVersion().catch(() => null))
        : null;
      // Greek letters only for a day that had Greek-letter runs (as its leaderboard): otherwise its Greek players played
      // the Latin start, and that is the one they shared.
      const greekVersion = locale === 'el'
        ? await deps.repo.commonStateValue(dayId, 'oe', { key: 'al', value: 'gr' }).catch(() => null)
        : null;
      const day = version || greekVersion ? await dayForRun(closed, rules.newState({ locale, russianVersion: version, greekVersion }), true) : closed;
      const pid = pickStart(day.universe, new Set<string>(), 0, draw(day.seed, 0));
      const name = pid ? day.universe.player(pid)?.name ?? null : null;
      return { day: dayId, starts: name ? [name] : [] };
    },

    /**
     * Russian players see the Russian-letter board. Greek players see the board their own run of the day ranks on (a run
     * started while Greek names were off plays Latin letters); without a run, the Greek-letter board once the day has
     * Greek-letter runs, else the Latin one.
     */
    async leaderboard(dayId: string | undefined, userId: string | null, locale?: string): Promise<LeaderboardResponse> {
      if (locale !== 'el') return core.leaderboard(dayId, userId, locale === 'ru' ? 'cy' : '');
      const day = dayId ?? nameChainCalendar.boardDay(deps.now());
      const own = userId ? await deps.repo.getRun({ kind: 'member', userId }, day).catch(() => null) : null;
      return core.leaderboard(day, userId, own ? own.state.al ?? '' : await greekBoardOf(day));
    },

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
