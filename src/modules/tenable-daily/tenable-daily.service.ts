import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import { tenableListSchema, type TenableList } from '../tenable/tenable.content.js';
import { tenableDirectories } from '../tenable/tenable.directories.js';
import { judge, type Directory, type EntityKind } from '../tenable/tenable.identify.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import { wordgameReportsService } from '../wordgame-reports/wordgame-reports.service.js';
import { RANKED_START, tenableCalendar } from './tenable-daily.days.js';
import * as rules from './tenable-daily.rules.js';

export interface TenableDayRow { day: string; number: number; contentVersion: number; list: unknown }
export interface TenableRunRow extends DailyRunRowBase<rules.RunState> { lives: number | null }
export interface LeaderboardEntry {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; lives: number;
}
interface IndexedDay { day: string; number: number; contentVersion: number; list: TenableList }
type ServedDay = IndexedDay & { directory: Directory };

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse { day: string; list: TenableList['title']; slots: Array<{ rank: number; name: string; figure: TenableList['slots'][number]['figure'] }> }

/** The kit's runs repo for tenable_runs / tenable_days; equal scores rank by lives left (fewer misses first). */
export const tenableDailyRepo = createDailyRunsRepo<rules.RunState, TenableRunRow, LeaderboardEntry, TenableDayRow>(
  { runs: 'tenable_runs', days: 'tenable_days', payload: 'list', stat: 'lives' }, { statTiebreak: true },
);

/** A stored day in serving form; null when the row is malformed (it is then not served). */
export function indexDay(row: TenableDayRow): IndexedDay | null {
  const parsed = tenableListSchema.safeParse(row.list);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, list: parsed.data } : null;
}

export const tenableDailyContent = createDailyContentStore(
  { fingerprint: () => tenableDailyRepo.daysFingerprint(), load: () => tenableDailyRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Tenable' },
);

/**
 * The served days with each list's directory attached (loaded once per process, before the days are handed out); a
 * day whose directory cannot be loaded is left out rather than judged against the wrong names.
 */
export function withDirectories(days: () => Promise<ReadonlyMap<string, IndexedDay>>, load = tenableDirectories.get): () => Promise<ReadonlyMap<string, ServedDay>> {
  let hydrated: { from: ReadonlyMap<string, IndexedDay>; index: ReadonlyMap<string, ServedDay> } | null = null;
  return async () => {
    const index = await days();
    if (hydrated?.from === index) return hydrated.index;
    const out = new Map<string, ServedDay>();
    // One load per (kind, release), not one per day: most days share a release, and a failing one must not be asked
    // for again by every day on every request.
    const loads = new Map<string, Promise<Directory | null>>();
    for (const [id, day] of index) {
      const key = `${day.list.kind}:${day.list.release}`;
      let loading = loads.get(key);
      if (!loading) loads.set(key, (loading = load(day.list.kind, day.list.release).catch(() => null)));
      const directory = await loading;
      if (directory) out.set(id, { ...day, directory });
    }
    if (out.size === index.size) hydrated = { from: index, index: out };
    return out;
  };
}

export interface TenableDailyDeps {
  repo: typeof tenableDailyRepo;
  content: () => Promise<ReadonlyMap<string, ServedDay>>;
  contentStale: () => void;
  now: () => Date;
  reports: Pick<typeof wordgameReportsService, 'file'>;
}

export function createTenableDailyService(deps: TenableDailyDeps) {
  const core = createDailyService<rules.RunState, TenableRunRow, LeaderboardEntry, ServedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: rules.completion,
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day ? { list: day.list, directory: day.directory } : null, now, extra),
    },
    { calendar: tenableCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    /** One answer. A finished run is never judged again (a retry gets the current state through the version check). */
    say(player: DailyPlayer, runId: string, version: number, text: string, pick: string | null): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s, day) => ({ state: rules.say(s, day.list, day.directory, text, pick) }));
    },

    giveUp(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      return core.mutate(player, runId, version, (s) => ({ state: rules.giveUp(s) }));
    },

    /**
     * "That was right", for a closed day only: before the day is over the list is today's ranked secret, so nothing is
     * looked up (the same 204 and the same work either way). Then: the player's own run of that day on the content it
     * played, and a text the list does not accept.
     */
    async report(player: DailyPlayer, dayId: string, text: string): Promise<void> {
      const day = await core.closedDay(dayId).catch(() => null);
      if (!day) return;
      const run = await deps.repo.getRun(player, dayId);
      if (!run || run.content_version !== day.contentVersion || run.state.k === 0) return;
      const verdict = judge(day.directory, day.list.slots.map((slot) => slot.eid), new Set(), text);
      if (verdict.kind === 'right') return;
      await deps.reports.file({
        game: 'tenable', source: 'daily', contextId: run.id, round: 0,
        reporter: player.kind === 'member' ? { userId: player.userId } : { guestId: player.guestId },
      }, { release: day.list.release, subject: day.list.id, resolvedPid: verdict.kind === 'wrong' ? verdict.eid : null }, text);
    },

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** A closed day's whole list; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      return {
        day: dayId,
        list: day.list.title,
        slots: day.list.slots.map((slot, i) => ({ rank: i + 1, name: day.directory.entity(slot.eid)?.name ?? '?', figure: slot.figure })),
      };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),
  };
}

export const tenableDailyService = createTenableDailyService({
  repo: tenableDailyRepo,
  content: withDirectories(() => tenableDailyContent.get()),
  contentStale: () => tenableDailyContent.invalidate(),
  now: () => new Date(),
  reports: wordgameReportsService,
});

/**
 * Called once at boot; never blocks startup and never throws. Loads the days and warms every directory a served day,
 * an enabled room list or a live match names, so neither a daily answer nor a room's first move waits on a cold load (a room
 * hydrates under its match lock).
 */
export function startTenableDailyReadinessCheck(): void {
  void (async () => {
    const index = await tenableDailyContent.get();
    // Enabled room lists, and every list of a live match (its list may have left the pool since it was dealt).
    const pool = await sql<Array<{ kind: EntityKind; release: string }>>`
      SELECT DISTINCT payload->>'kind' AS kind, payload->>'release' AS release FROM room_pool WHERE game = 'tenable' AND enabled
      UNION
      SELECT DISTINCT l->>'kind', l->>'release'
      FROM room_matches m JOIN room_match_content c ON c.match_id = m.id CROSS JOIN jsonb_array_elements(c.content->'lists') l
      WHERE m.game = 'tenable' AND m.status IN ('ready', 'active')`;
    await tenableDirectories.warm([...[...index.values()].map((d) => ({ kind: d.list.kind, release: d.list.release })), ...pool]);
    if (index.size === 0) logger.warn('No Tenable days loaded (tenable_days is empty)');
    logger.info({ days: index.size, roomReleases: pool.length }, 'Tenable content loaded');
  })().catch((error: unknown) => logger.warn({ err: error }, 'Tenable content could not be loaded at boot'));
}
