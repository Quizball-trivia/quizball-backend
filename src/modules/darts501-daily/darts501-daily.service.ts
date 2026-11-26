import { logger } from '../../core/logger.js';
import { contentGaps } from '../content-gaps/content-gaps.recorder.js';
import { safeGap, type GapSeen } from '../content-gaps/content-gaps.buffer.js';
import { dartsGap } from '../darts501/darts501.gaps.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { tenableDirectories } from '../tenable/tenable.directories.js';
import { shownName } from '../tenable/tenable.names.js';
import { oneAtATime } from '../tenable-daily/tenable-daily.service.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { asD501Locale, d501CategorySchema, textIn, type D501Category } from '../darts501/darts501.content.js';
import { darts501Coverage } from '../darts501/darts501.coverage.js';
import { CHECKOUT_MIN_SCORE, D501, entriesOf, finishes, fromRankScore, readDart } from '../darts501/darts501.rules.js';
import { d501CardSchema, type D501Card } from '../darts501/darts501.cards.js';
import { addDays, dayEndsAt, releaseDay } from '../daily/daily.calendar.js';
import { CONTENT_START, darts501Calendar, RANKED_START } from './darts501-daily.days.js';
import * as rules from './darts501-daily.rules.js';
import { D501_READ_DEADLINE_MS, D501ContentUnavailableError, darts501Reads, myRuns, withDeadline } from './darts501-daily.reads.js';

export interface D501DayRow { day: string; number: number; contentVersion: number; category: unknown }
export interface D501RunRow extends DailyRunRowBase<rules.RunState> { darts: number | null }
interface BoardRow {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; darts: number;
}
export interface LeaderboardEntry extends BoardRow { checkedOut: boolean; remaining: number }
interface IndexedDay { day: string; number: number; contentVersion: number; category: D501Category }
type ServedDay = IndexedDay & rules.Day;

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse {
  day: string;
  title: string;
  note: string | null;
  unit: D501Category['unit'];
  asOf: string;
  /** The biggest numbers of the category, and the finishes from a few classic scores. */
  top: Array<{ name: string; value: number }>;
  finishes: Array<{ from: number; players: Array<{ name: string; value: number }> }>;
}

/** A closed day on the calendar: what it was and how it went. */
export interface ClosedDayCard {
  day: string; number: number; tier: D501Category['tier']; closed: true;
  title: string; unit: D501Category['unit'];
  card: (Omit<D501Card, 'subject'> & { subject: string }) | null;
  stats: { players: number; checkouts: number; bestDarts: number | null } | null;
}
/** Today (or a day the database clock has not closed yet): its number and difficulty only, the category stays secret. */
export interface OpenDayCard { day: string; number: number; tier: D501Category['tier']; closed: false }

export interface DaysResponse {
  today: string;
  contentStart: string;
  rankedFrom: string;
  todaySeeded: boolean;
  tomorrowSeeded: boolean;
  /** The last day of the unbroken run of seeded days from today (null when today has none): the calendar's runway. */
  seededThrough: string | null;
  /** When tomorrow's board opens, if it is seeded. */
  nextOpensAt: string | null;
  /** Every seeded day up to today, oldest first. Never a future day. */
  days: Array<ClosedDayCard | OpenDayCard>;
}

export interface MyDay { done: boolean; checkedOut: boolean; gaveUp: boolean; darts: number; remaining: number; stale: boolean }
export interface MyDaysResponse { days: Record<string, MyDay> }

/** The kit's runs repo for darts501_runs / darts501_days; the whole board order is in `score` (see rankScore). */
export const darts501DailyRepo = createDailyRunsRepo<rules.RunState, D501RunRow, BoardRow, D501DayRow>(
  { runs: 'darts501_runs', days: 'darts501_days', payload: 'category', stat: 'darts' },
);

export function indexDay(row: D501DayRow): IndexedDay | null {
  const parsed = d501CategorySchema.safeParse(row.category);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, category: parsed.data } : null;
}

// Bounded reads (see darts501-daily.reads): a stuck one must not hold the one shared refresh, and every request, forever.
export const darts501DailyContent = createDailyContentStore(
  { fingerprint: () => darts501Reads.daysFingerprint(), load: () => darts501Reads.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Darts 501' },
);

/**
 * The served days with each category's footballers and coverage attached (one load per release and coverage set). Days
 * are hydrated together and each load is waited for at most `deadlineMs`. Another day whose names or coverage cannot be
 * loaded is left out (never judged against the wrong ones); today's is a retryable 503 instead, because an index without
 * today reached players as a cacheable 200 /boards (the game showed "coming soon") and a 404 run, neither retried.
 * The loaders bound their own database work (tenableDirectories' LOAD_DEADLINE_MS, the coverage pages' statement
 * bound), so a stuck load fails, its cached promise is dropped and a later call loads it.
 */
export function withBoards(
  days: () => Promise<ReadonlyMap<string, IndexedDay>>,
  loadDirectory = tenableDirectories.get,
  loadCoverage = darts501Coverage.get,
  deadlineMs = D501_READ_DEADLINE_MS,
  today: () => string = () => releaseDay(new Date()),
): () => Promise<ReadonlyMap<string, ServedDay>> {
  let hydrated: { from: ReadonlyMap<string, IndexedDay>; index: ReadonlyMap<string, ServedDay> } | null = null;
  return async () => {
    const index = await days();
    if (hydrated?.from === index) return hydrated.index;
    const served = await Promise.all([...index].map(async ([id, day]) => {
      const [directory, coverage] = await Promise.all([
        withDeadline(loadDirectory('player', day.category.release), deadlineMs, 'directory').catch(() => null),
        withDeadline(loadCoverage(day.category.coverage), deadlineMs, 'coverage').catch(() => null),
      ]);
      return directory && coverage ? ([id, { ...day, directory, coverage }] as const) : null;
    }));
    const out = new Map<string, ServedDay>(served.filter((entry) => entry !== null));
    if (out.size === index.size) {
      hydrated = { from: index, index: out };
      return out;
    }
    const day = today();
    logger.warn({ days: index.size, served: out.size, todayMissing: index.has(day) && !out.has(day) }, 'Darts 501 days left out: their footballers or coverage could not be loaded');
    if (index.has(day) && !out.has(day)) throw new D501ContentUnavailableError('today');
    return out;
  };
}

/** What the days calendar reads besides the served content (each failure-tolerant: the calendar shows less, play is untouched). */
export interface D501CalendarReads {
  clock(): Promise<number>;
  cards(): Promise<Array<{ categoryId: string; card: unknown }>>;
  dayStats(before: string, checkoutMin: number): Promise<Array<{ day: string; players: number; checkouts: number; bestDarts: number | null }>>;
  myRuns: typeof myRuns;
}

/** One value per key for `ms`, with one load in flight; a failed load is kept for `failMs` (no retry storm on a slow read). */
function memo<T>(ms: number, failMs: number, now: () => number, load: (key: string) => Promise<T>) {
  let held: { key: string; at: number; ttl: number; value: Promise<T> } | null = null;
  return (key: string): Promise<T> => {
    if (held && held.key === key && now() - held.at < held.ttl) return held.value;
    const value = load(key);
    const entry = { key, at: now(), ttl: ms, value };
    held = entry;
    value.catch(() => { entry.ttl = failMs; entry.at = now(); });
    return value;
  };
}

const CARDS_CACHE_MS = 5 * 60_000;
const STATS_CACHE_MS = 10 * 60_000;
const READ_FAILED_RETRY_MS = 60_000;
const CLOCK_OFFSET_MS = 60_000;

export interface Darts501DailyDeps {
  repo: typeof darts501DailyRepo;
  calendar?: D501CalendarReads;
  /** The seeded days without their footballers (the calendar's view; default: `content`): a directory outage is not a gap. */
  index?: () => Promise<ReadonlyMap<string, IndexedDay>>;
  content: () => Promise<ReadonlyMap<string, ServedDay>>;
  contentStale: () => void;
  now: () => Date;
  reports: Pick<typeof wordgameReportsService, 'file'>;
}

/** Scores a review shows the finishes from. */
const REVIEW_FROM = [40, 60, 100, 141, 170] as const;
const REVIEW_TOP = 10;

export function createDarts501DailyService(deps: Darts501DailyDeps) {
  const core = createDailyService<rules.RunState, D501RunRow, BoardRow, ServedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: rules.completion,
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day, now, extra),
    },
    { calendar: darts501Calendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  const decode = (row: BoardRow): LeaderboardEntry => ({ ...row, ...fromRankScore(row.score, row.darts) });

  const calendarReads = deps.calendar ?? { clock: darts501Reads.clock, cards: darts501Reads.cards, dayStats: darts501Reads.dayStats, myRuns };
  const calendarIndex = deps.index ?? deps.content;
  const clockMs = () => deps.now().getTime();
  const cards = memo(CARDS_CACHE_MS, READ_FAILED_RETRY_MS, clockMs, async () => {
    const out = new Map<string, D501Card>();
    for (const row of await calendarReads.cards()) {
      const parsed = d501CardSchema.safeParse(row.card);
      if (parsed.success) out.set(row.categoryId, parsed.data);
      else logger.warn({ categoryId: row.categoryId }, 'Darts 501 card is not valid; the day shows without it');
    }
    return out;
  });
  const stats = memo(STATS_CACHE_MS, READ_FAILED_RETRY_MS, clockMs, async (before) =>
    new Map((await calendarReads.dayStats(before, CHECKOUT_MIN_SCORE)).map((r) => [r.day, { players: r.players, checkouts: r.checkouts, bestDarts: r.bestDarts }])));
  /**
   * Today by the earlier of the app and database clocks. The database is asked only in the minutes after Buenos Aires
   * midnight, where a replica running ahead could otherwise open the next day before the database has.
   */
  async function effectiveToday(): Promise<string> {
    const now = deps.now().getTime();
    const offset = await dbOffset('clock').catch(() => 0);
    return releaseDay(new Date(Math.min(now, now + offset)));
  }

  /**
   * The default board: the newest served day up to today (a day without a board shows the one before it). Served, not
   * just seeded: the board of a day whose footballers failed to load could not be read at all.
   */
  async function defaultBoardDay(): Promise<string> {
    const today = await effectiveToday();
    let latest: string | null = null;
    for (const id of (await deps.content()).keys()) if (id <= today && id >= RANKED_START && (latest === null || id > latest)) latest = id;
    return latest ?? (today < RANKED_START ? RANKED_START : today);
  }

  /** How far the database clock is ahead of this replica's (ms), measured once a minute. */
  const dbOffset = memo(CLOCK_OFFSET_MS, CLOCK_OFFSET_MS, clockMs, async () => (await calendarReads.clock()) - deps.now().getTime());

  const optional = <T>(what: string, read: Promise<T>): Promise<T | null> =>
    read.catch((error: unknown) => { logger.warn({ err: error, what }, 'Darts 501 calendar read failed; the days show without it'); return null; });

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number, locale?: string): Promise<RunResponse> => core.start(dayId, player, clientContentVersion, { locale }),

    /** One answer. A finished run is never judged again (a retry gets the current state through the version check). */
    async say(player: DailyPlayer, runId: string, version: number, text: string, pick: string | null): Promise<RunResponse> {
      // What this answer revealed, kept from the step that committed (a retried step replaces it) and recorded after.
      const seen: { gap: GapSeen | null; locale: string | null } = { gap: null, locale: null };
      const response = await core.mutate(player, runId, version, (s, day) => {
        const next = rules.say(s, day, text, pick);
        seen.gap = safeGap(() => (next.k > s.k && next.last ? dartsGap(next.last.v, next.last.t, next.last.e, day.category, day.directory) : null));
        seen.locale = next.lc;
        return { state: next };
      });
      if (seen.gap) contentGaps.record({ ...seen.gap, mode: 'daily', locale: seen.locale });
      return response;
    },

    giveUp(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.giveUp(s) }));
    },

    /**
     * "That was right", for a closed day only: before the day is over the category is today's ranked secret, so nothing
     * is looked up (the same 204 and the same work either way). Then: the player's own run of that day on the content it
     * played, and a text the category does not score.
     */
    async report(player: DailyPlayer, dayId: string, text: string): Promise<void> {
      const day = await core.closedDay(dayId).catch(() => null);
      if (!day) return;
      const run = await deps.repo.getRun(player, dayId);
      if (!run || run.content_version !== day.contentVersion || run.state.k === 0) return;
      const read = readDart({ directory: day.directory, coverage: day.coverage, entries: entriesOf(day.category) }, new Set(), D501.start, text, null);
      if (!read.free && read.value !== null) return;
      await deps.reports.file({
        game: 'darts501', source: 'daily', contextId: run.id, round: 0,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, { release: day.category.release, subject: day.category.id, resolvedPid: read.eid }, text);
    },

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),

    /**
     * The days calendar: every seeded day up to today, and how far the seeded run goes. A day is shown (title, type,
     * card, stats) only once both clocks have closed it, the review's rule, so today's category stays the ranked secret
     * on a replica whose clock runs ahead. Never a future day's content.
     */
    async days(locale?: string): Promise<{ response: DaysResponse; partial: boolean }> {
      const index = await calendarIndex();
      const now = deps.now();
      const dbNow = await calendarReads.clock();
      // The earlier of the two clocks: a replica running ahead must not open tomorrow (or close today) before the database does.
      const today = releaseDay(new Date(Math.min(now.getTime(), dbNow)));
      const lc = asD501Locale(locale);
      const [cardMap, statMap] = await Promise.all([optional('cards', cards('all')), optional('stats', stats(today))]);
      const days: DaysResponse['days'] = [];
      for (const d of [...index.values()].sort((a, b) => (a.day < b.day ? -1 : 1))) {
        if (d.day < CONTENT_START || d.day > today) continue;
        const closed = d.day < today && dayEndsAt(d.day).getTime() <= dbNow;
        if (!closed) {
          days.push({ day: d.day, number: d.number, tier: d.category.tier, closed: false });
          continue;
        }
        const card = cardMap?.get(d.category.id);
        days.push({
          day: d.day, number: d.number, tier: d.category.tier, closed: true,
          title: textIn(d.category, lc).title, unit: d.category.unit,
          card: card ? { ...card, subject: card.subject[lc] ?? card.subject.en } : null,
          stats: statMap?.get(d.day) ?? (statMap ? { players: 0, checkouts: 0, bestDarts: null } : null),
        });
      }
      const tomorrow = addDays(today, 1);
      let seededThrough: string | null = null;
      if (index.has(today)) {
        seededThrough = today;
        while (index.has(addDays(seededThrough, 1))) seededThrough = addDays(seededThrough, 1);
      }
      return {
        response: {
          today, contentStart: CONTENT_START, rankedFrom: RANKED_START,
          todaySeeded: index.has(today), tomorrowSeeded: index.has(tomorrow), seededThrough,
          nextOpensAt: index.has(tomorrow) ? dayEndsAt(today).toISOString() : null,
          days,
        },
        partial: cardMap === null || statMap === null,
      };
    },

    /** The player's own runs by day. `stale`: a correction replaced that day's content after the run (it shows its own result). */
    async myDays(player: DailyPlayer): Promise<MyDaysResponse> {
      const index = await calendarIndex();
      const days: Record<string, MyDay> = {};
      for (const row of await calendarReads.myRuns(player)) {
        const day = index.get(row.day);
        if (!day) continue;
        days[row.day] = {
          done: row.done, checkedOut: row.end === 'checkout', gaveUp: row.end === 'gaveUp',
          darts: row.done && row.darts !== null ? row.darts : row.thrown, remaining: row.remaining,
          stale: row.contentVersion !== day.contentVersion,
        };
      }
      return { days };
    },
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** A closed day's category; anything else is the same 404 as a missing day. */
    async review(dayId: string, locale?: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const lc = asD501Locale(locale);
      const entries = entriesOf(day.category);
      const named = (eid: string, value: number) => ({ name: shownName(day.directory, eid, lc) ?? '?', value });
      const none = new Set<string>();
      const text = textIn(day.category, lc);
      return {
        day: dayId,
        title: text.title,
        note: text.note,
        unit: day.category.unit,
        asOf: day.category.asOf,
        top: [...day.category.entries].sort((a, b) => b.value - a.value || (a.eid < b.eid ? -1 : 1)).slice(0, REVIEW_TOP).map((e) => named(e.eid, e.value)),
        finishes: REVIEW_FROM.map((from) => ({ from, players: finishes(entries, none, from, 3).map((f) => named(f.eid, f.value)) })),
      };
    },

    async leaderboard(dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> {
      const board = await core.leaderboard(dayId ?? (await defaultBoardDay()), userId);
      return { ...board, top: board.top.map(decode), me: board.me ? decode(board.me) : null };
    },
  };
}

export const darts501DailyService = createDarts501DailyService({
  repo: darts501DailyRepo,
  index: () => darts501DailyContent.get(),
  content: withBoards(() => darts501DailyContent.get()),
  contentStale: () => darts501DailyContent.invalidate(),
  now: () => new Date(),
  reports: wordgameReportsService,
});

/** Releases and coverage sets the enabled room categories and every live match use. */
export function darts501RoomPairs(): Promise<Array<{ release: string; coverage: string }>> {
  return darts501Reads.roomPairs();
}

const KEEPER_MS = 60_000;

/**
 * Called once at boot; never blocks startup and never throws. Pins and warms the footballer releases and coverage sets
 * every served day, enabled room category and live match names, then again every KEEPER_MS, so neither an answer nor a
 * room's deal waits on a cold load.
 */
export function startDarts501ReadinessCheck(): void {
  const keep = async () => {
    const index = await darts501DailyContent.get();
    const rooms = await darts501RoomPairs();
    const used = [...[...index.values()].map((d) => ({ release: d.category.release, coverage: d.category.coverage })), ...rooms];
    const releases = [...new Set(used.map((u) => u.release))].map((release) => ({ kind: 'player' as const, release }));
    tenableDirectories.pin(releases, 'darts501');
    await tenableDirectories.warm(releases);
    await Promise.all([...new Set(used.map((u) => u.coverage))].map((id) => darts501Coverage.get(id).catch((error: unknown) => logger.error({ err: error, coverage: id }, 'Darts 501 coverage warm-up failed'))));
    return { days: index.size, roomPairs: rooms.length };
  };
  const run = oneAtATime(keep);
  void run()
    ?.then(({ days, roomPairs }) => {
      if (days === 0) logger.warn('No Darts 501 days loaded (darts501_days is empty)');
      logger.info({ days, roomPairs }, 'Darts 501 content loaded');
    })
    .catch((error: unknown) => logger.warn({ err: error }, 'Darts 501 content could not be loaded at boot'));
  setInterval(() => { void run()?.catch((error: unknown) => logger.warn({ err: error }, 'Darts 501 keeper failed')); }, KEEPER_MS).unref();
}
