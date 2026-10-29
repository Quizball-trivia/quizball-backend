import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
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
import { D501, entriesOf, finishes, fromRankScore, readDart } from '../darts501/darts501.rules.js';
import { darts501Calendar, RANKED_START } from './darts501-daily.days.js';
import * as rules from './darts501-daily.rules.js';

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

/** The kit's runs repo for darts501_runs / darts501_days; the whole board order is in `score` (see rankScore). */
export const darts501DailyRepo = createDailyRunsRepo<rules.RunState, D501RunRow, BoardRow, D501DayRow>(
  { runs: 'darts501_runs', days: 'darts501_days', payload: 'category', stat: 'darts' },
);

export function indexDay(row: D501DayRow): IndexedDay | null {
  const parsed = d501CategorySchema.safeParse(row.category);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, category: parsed.data } : null;
}

export const darts501DailyContent = createDailyContentStore(
  { fingerprint: () => darts501DailyRepo.daysFingerprint(), load: () => darts501DailyRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Darts 501' },
);

/**
 * The served days with each category's footballers and coverage attached (one load per release and coverage set); a
 * day whose names or coverage cannot be loaded is left out rather than judged against the wrong ones.
 */
export function withBoards(
  days: () => Promise<ReadonlyMap<string, IndexedDay>>,
  loadDirectory = tenableDirectories.get,
  loadCoverage = darts501Coverage.get,
): () => Promise<ReadonlyMap<string, ServedDay>> {
  let hydrated: { from: ReadonlyMap<string, IndexedDay>; index: ReadonlyMap<string, ServedDay> } | null = null;
  return async () => {
    const index = await days();
    if (hydrated?.from === index) return hydrated.index;
    const out = new Map<string, ServedDay>();
    for (const [id, day] of index) {
      const [directory, coverage] = await Promise.all([
        loadDirectory('player', day.category.release).catch(() => null),
        loadCoverage(day.category.coverage).catch(() => null),
      ]);
      if (directory && coverage) out.set(id, { ...day, directory, coverage });
    }
    if (out.size === index.size) hydrated = { from: index, index: out };
    return out;
  };
}

export interface Darts501DailyDeps {
  repo: typeof darts501DailyRepo;
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

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number, locale?: string): Promise<RunResponse> => core.start(dayId, player, clientContentVersion, { locale }),

    /** One answer. A finished run is never judged again (a retry gets the current state through the version check). */
    say(player: DailyPlayer, runId: string, version: number, text: string, pick: string | null): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.say(s, day, text, pick) }));
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
      const board = await core.leaderboard(dayId, userId);
      return { ...board, top: board.top.map(decode), me: board.me ? decode(board.me) : null };
    },
  };
}

export const darts501DailyService = createDarts501DailyService({
  repo: darts501DailyRepo,
  content: withBoards(() => darts501DailyContent.get()),
  contentStale: () => darts501DailyContent.invalidate(),
  now: () => new Date(),
  reports: wordgameReportsService,
});

/** Releases and coverage sets the enabled room categories and every live match use. */
export function darts501RoomPairs(): Promise<Array<{ release: string; coverage: string }>> {
  return sql<Array<{ release: string; coverage: string }>>`
    SELECT DISTINCT payload->>'release' AS release, payload->>'coverage' AS coverage FROM room_pool WHERE game = 'darts501' AND enabled
    UNION
    SELECT DISTINCT l->>'release', l->>'coverage'
    FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'legs') l
    WHERE m.game = 'darts501' AND m.status IN ('ready', 'active')`;
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
