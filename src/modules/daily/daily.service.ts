import { randomUUID } from 'node:crypto';
import { NotFoundError, type AppError } from '../../core/errors.js';
import type { TransactionSql } from '../../db/index.js';
import { dayEndsAt, isReleasedDay, releaseDay, type DailyCalendar } from './daily.calendar.js';
import { storedDaysOf } from './daily.content.js';
import { contentChanged, dayOver, notYourRun, signInForToday, staleState } from './daily.errors.js';
import type { DailyBoardEntryBase, DailyPlayer, DailyRunRowBase } from './daily.repo.js';

export interface RunResponse<Public> {
  run: { id: string; version: number };
  state: Public;
}

export interface BoardsResponse {
  /** Playable days → content version. Never any content. */
  days: Record<string, number>;
  rankedFrom: string;
}

export interface LeaderboardResponse<Entry> {
  day: string;
  players: number;
  top: Entry[];
  me: Entry | null;
}

/** The repo calls the service needs (the kit's runs repo, or a test double). */
export interface DailyServiceRepo<State, Row extends DailyRunRowBase<State>, Entry> {
  withTx<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T>;
  lockDay(tx: TransactionSql, day: string): Promise<number | null>;
  dayVersion(tx: TransactionSql, day: string): Promise<number | null>;
  insertRun(tx: TransactionSql, data: { id: string; player: DailyPlayer; day: string; ranked: boolean; contentVersion: number; state: State; closesAt: Date }): Promise<Row | null>;
  lockOwnRun(tx: TransactionSql, player: DailyPlayer, day: string): Promise<Row | null>;
  runDay(tx: TransactionSql, id: string): Promise<string | null>;
  lockRun(tx: TransactionSql, id: string): Promise<Row | null>;
  getRun(player: DailyPlayer, day: string): Promise<Row | null>;
  saveState(tx: TransactionSql, id: string, data: { state: State; stateVersion: number; contentVersion: number; completion: { score: number; stat: number } | null }, settledAt?: Date): Promise<Row | null>;
  /** Only for games with `clock: 'database'`. */
  clock?(tx?: TransactionSql): Promise<number>;
  unrankClosedRun(tx: TransactionSql, id: string): Promise<Row | null>;
  rebaseRun(tx: TransactionSql, id: string, contentVersion: number, state: State): Promise<Row | null>;
  isClosed(closesAt: Date): Promise<boolean>;
  rankOf(userId: string, day: string, tx?: TransactionSql): Promise<Entry | null>;
  leaderboard(day: string, limit: number): Promise<{ players: number; top: Entry[] }>;
}

/** What makes one daily game: its run state machine and what a player may see of it. */
export interface DailyRules<State, Day, Public> {
  newState(): State;
  /**
   * The run as of `now`. Games with a clock settle what ran out here, so every read and move sees it; return the
   * same object when nothing changed (games without a clock return `s`).
   */
  project(s: State, now: number): State;
  /** The state an unfinished run keeps when a correction moves it onto new content. */
  rebase(s: State): State;
  /** Score and board stat once the run is finished, else null. */
  completion(s: State): { score: number; stat: number } | null;
  publicState(s: State, run: { day: string }, day: Day | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number }): Public;
  /** When `project` settled something, the instant it happened (written after a day's close if it was before it). */
  settledAt?(stored: State, projected: State): number | null;
}

export interface DailyDeps<State, Row extends DailyRunRowBase<State>, Entry, Day> {
  repo: DailyServiceRepo<State, Row, Entry>;
  content: () => Promise<ReadonlyMap<string, Day>>;
  /** The served content turned out older than the database (a correction): re-check it on the next read. */
  contentStale: () => void;
  now: () => Date;
}

/** One move: `s` is the run projected to `now`; `stored` is the row's state as it was. */
export type DailyStep<State, Day, Extra> = (s: State, day: Day, now: number, stored: State) => {
  state: State;
  extra?: Extra;
  /** The move only records what the clock decided, at this instant (see saveState's settledAt). */
  settledAt?: number | null;
};

const owns = (row: DailyRunRowBase<unknown>, player: DailyPlayer): boolean =>
  player.kind === 'member' ? row.user_id === player.userId : row.guest_id === player.guestId;

/**
 * The shared core of every daily game (Pistas, Último en pie): one runs row per player per day, row-locked and
 * version-checked on every move. A member's run of the live ranked day is ranked; every other run is not. Guests
 * play closed days only. Content can be corrected under running games (runs move onto it, unranked). What a
 * player sees, and when answers are disclosed, is the game's `publicState` with `disclose` = the day is closed
 * by the database clock.
 */
export function createDailyService<State, Row extends DailyRunRowBase<State>, Entry extends DailyBoardEntryBase, Day extends { day: string; contentVersion: number }, Public extends { day: string; done: boolean; ranked: boolean }>(
  deps: DailyDeps<State, Row, Entry, Day>,
  rules: DailyRules<State, Day, Public>,
  config: {
    calendar: DailyCalendar; rankedFrom: string; leaderboardTop: number; leaderboardCacheMs: number;
    /** 'database': moves and reads are timed by the database clock (read after the row lock), the same on every replica. */
    clock?: 'app' | 'database';
  },
) {
  type Tx = TransactionSql;
  const { calendar } = config;
  const leaderboards = new Map<string, { at: number; players: number; top: Entry[] }>();
  /** Days the database clock has closed; once closed a day stays closed. */
  const closedDays = new Set<string>();
  /** The calendar's last day for each served content index (the index object changes only when the table does). */
  const lastDays = new WeakMap<ReadonlyMap<string, Day>, string | null>();
  function lastDayOf(content: ReadonlyMap<string, Day>): string | null {
    let last = lastDays.get(content);
    if (last === undefined) {
      last = calendar.lastDay(storedDaysOf(content));
      lastDays.set(content, last);
    }
    return last;
  }

  const nowMs = async (tx?: Tx): Promise<number> =>
    config.clock === 'database' && deps.repo.clock ? deps.repo.clock(tx) : deps.now().getTime();

  /** Writes what the clock already decided (`project`), if anything; the row as it then is. */
  async function recordProjection(tx: Tx, row: Row, at: number): Promise<Row> {
    const projected = rules.project(row.state, at);
    if (projected === row.state) return row;
    const settledAt = rules.settledAt?.(row.state, projected);
    const saved = await deps.repo.saveState(tx, row.id, {
      state: projected, stateVersion: row.state_version + 1, contentVersion: row.content_version, completion: rules.completion(projected),
    }, settledAt != null ? new Date(settledAt) : undefined);
    return saved ?? row;
  }

  /**
   * What the clock decided, written down; a ranked run whose window closed before its clock did (a write the ranked
   * fence refuses) goes on as practice, off the board, and is written down there.
   */
  async function recordOrUnrank(tx: Tx, row: Row, at: number): Promise<Row> {
    const saved = await recordProjection(tx, row, at);
    if (!saved.ranked || saved.done || rules.project(saved.state, at) === saved.state) return saved;
    const unranked = await deps.repo.unrankClosedRun(tx, saved.id);
    return unranked ? recordProjection(tx, unranked, at) : saved;
  }

  /** A future day and a day with no content are the same 404: nothing may hint at what is coming. */
  async function playableDay(day: string): Promise<{ day: Day; lastDay: string | null }> {
    const index = await deps.content();
    const content = index.get(day);
    const lastDay = lastDayOf(index);
    // Evaluate playability unconditionally so an unknown day and a future day take the same path.
    const playable = calendar.isPlayableDay(day, lastDay, deps.now());
    if (!content || !playable) throw new NotFoundError('Day not available');
    return { day: content, lastDay };
  }

  async function closedByDatabase(day: string): Promise<boolean> {
    if (closedDays.has(day)) return true;
    const closed = await deps.repo.isClosed(dayEndsAt(day));
    if (closed) closedDays.add(day);
    return closed;
  }

  /**
   * Holds the day's row FOR SHARE for the rest of the transaction and checks that the content this replica serves
   * (cached, up to the refresh interval old) is still the stored one. A correction therefore waits for this write,
   * and a move judged against superseded content never lands.
   */
  async function lockServedDay(tx: Tx, day: Day): Promise<void> {
    if ((await deps.repo.lockDay(tx, day.day)) !== day.contentVersion) throw otherContent();
  }

  /** A run UPDATE matched no row: the ranked cutoff passed, or the day's content changed under the run. */
  async function rejectedWrite(tx: Tx, dayId: string, contentVersion: number): Promise<AppError> {
    return (await deps.repo.dayVersion(tx, dayId)) === contentVersion ? dayOver() : otherContent();
  }

  /** The client, the run or the database disagrees with the served content: this replica may be the stale one, so it re-checks now. */
  function otherContent(): AppError {
    deps.contentStale();
    return contentChanged();
  }

  async function respond(row: Row, day: Day | null, now: number, tx?: Tx): Promise<RunResponse<Public>> {
    const state = rules.project(row.state, now);
    const rank = row.ranked && rules.completion(state) && row.user_id ? (await deps.repo.rankOf(row.user_id, row.day, tx))?.rank : undefined;
    // Content of another version cannot describe this run.
    const content = row.content_version === day?.contentVersion ? day : null;
    return {
      run: { id: row.id, version: row.state_version },
      state: rules.publicState(state, row, content, now, { ranked: row.ranked, rank, disclose: row.closed }),
    };
  }

  const settled = (response: RunResponse<Public>) => {
    if (response.state.done && response.state.ranked) leaderboards.delete(response.state.day);
    return response;
  };

  async function start(dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse<Public>> {
    const { day, lastDay } = await playableDay(dayId);
    const now = deps.now();
    // Guests play closed days only: an unranked run of today would probe it for a ranked one. Closed by the
    // database clock too, the ranked write fence's clock: a replica running ahead must not open the day early.
    if (player.kind === 'guest' && !(calendar.isClosedDay(dayId, now) && (await closedByDatabase(dayId)))) throw signInForToday();
    if (clientContentVersion !== undefined && clientContentVersion !== day.contentVersion) throw otherContent();
    const live = dayId === calendar.rankedDay(lastDay, now);
    return settled(await deps.repo.withTx(async (tx) => {
      await lockServedDay(tx, day);
      const inserted = await deps.repo.insertRun(tx, {
        id: randomUUID(), player, day: dayId, ranked: live && player.kind === 'member', contentVersion: day.contentVersion,
        state: rules.newState(), closesAt: dayEndsAt(dayId),
      });
      if (inserted) return respond(inserted, day, await nowMs(tx), tx);
      let row = await deps.repo.lockOwnRun(tx, player, dayId);
      if (!row) throw staleState();
      // What the clock settled before the day closed is recorded first, so a run finished in time keeps its rank;
      // what it settled after (the database clock decides, even when this request began before midnight) as practice.
      const at = await nowMs(tx);
      if (row.content_version === day.contentVersion) row = await recordOrUnrank(tx, row, at);
      // The ranked window closed before this run was finished: it goes on as practice, off the board.
      if (row.ranked && !row.done && !live) row = (await deps.repo.unrankClosedRun(tx, row.id)) ?? row;
      // A correction (which unranked the day's runs) replaced the content: an unfinished run moves onto it;
      // a finished one keeps its own and shows no content of the new one.
      if (row.content_version !== day.contentVersion && !row.done) {
        const rebased = await deps.repo.rebaseRun(tx, row.id, day.contentVersion, rules.rebase(row.state));
        if (!rebased) throw otherContent();
        row = rebased;
      }
      return respond(row, day, at, tx);
    }));
  }

  async function mutate<Extra extends object = object>(player: DailyPlayer, runId: string, version: number, step: DailyStep<State, Day, Extra>): Promise<RunResponse<Public> & Partial<Extra>> {
    const content = await deps.content();
    // Read before waiting on the row lock; the UPDATE itself re-checks the ranked cutoff at statement time.
    const now = deps.now();
    const today = calendar.rankedDay(lastDayOf(content), now);
    const response = await deps.repo.withTx(async (tx) => {
      const dayId = await deps.repo.runDay(tx, runId);
      if (!dayId) throw new NotFoundError('Run not found');
      const day = content.get(dayId);
      if (!day) throw otherContent();
      // A run of a day the calendar no longer reaches (stored beyond a hole) is not played on.
      if (!isReleasedDay(dayId, lastDayOf(content))) throw new NotFoundError('Day not available');
      // Day before run, the seed's order: a correction holding the day never waits on a run this move holds.
      await lockServedDay(tx, day);
      const row = await deps.repo.lockRun(tx, runId);
      if (!row) throw new NotFoundError('Run not found');
      if (!owns(row, player)) throw notYourRun();
      if (player.kind === 'guest' && !(calendar.isClosedDay(row.day, now) && row.closed)) throw signInForToday();
      if (row.ranked && row.day !== today) throw dayOver();
      // The row is authoritative: an older version (a retry, another tab) is stale and the client re-syncs via /start.
      if (row.state_version !== version) throw staleState();
      if (day.contentVersion !== row.content_version) throw otherContent();
      // A game clock is read after the row lock: a move judged is a move timed.
      const at = await nowMs(tx);
      const out = step(rules.project(row.state, at), day, at, row.state);
      const saved = await deps.repo.saveState(tx, row.id, {
        state: out.state, stateVersion: row.state_version + 1, contentVersion: row.content_version, completion: rules.completion(out.state),
      }, out.settledAt != null ? new Date(out.settledAt) : undefined);
      if (!saved) throw await rejectedWrite(tx, row.day, row.content_version);
      return { ...(await respond(saved, day, at, tx)), ...out.extra } as RunResponse<Public> & Partial<Extra>;
    });
    settled(response);
    return response;
  }

  return {
    start,
    mutate,

    /** The player's run of `dayId` (default: today); none until /start created it, or while /start must move it onto corrected content. */
    async current(player: DailyPlayer, dayId: string | undefined): Promise<RunResponse<Public> | { run: null }> {
      const content = await deps.content();
      const target = dayId ?? releaseDay(deps.now());
      if (!isReleasedDay(target, lastDayOf(content))) return { run: null };
      const row = await deps.repo.getRun(player, target);
      if (!row) return { run: null };
      const day = content.get(target) ?? null;
      if (row.content_version !== day?.contentVersion) return { run: null };
      const at = await nowMs();
      if (rules.project(row.state, at) === row.state) return respond(row, day, at);
      // The clock settled something since the last write: record it (locked like a move), so what this read shows
      // (a finished run included) is what the board has.
      return deps.repo.withTx(async (tx) => {
        await lockServedDay(tx, day);
        const locked = await deps.repo.lockRun(tx, row.id);
        if (!locked) return respond(row, day, at);
        const saved = await recordOrUnrank(tx, locked, await nowMs(tx));
        if (saved !== locked && rules.completion(saved.state) && saved.ranked) leaderboards.delete(saved.day);
        return respond(saved, day, await nowMs(tx), tx);
      });
    },

    /**
     * The settling sweep's step for one run: a clock that ran out with nobody coming back is written down, so a
     * finished run reaches the board. Row-locked like a move; a run another request already moved is left alone.
     */
    async settleExpired(runId: string): Promise<void> {
      const content = await deps.content();
      await deps.repo.withTx(async (tx) => {
        const dayId = await deps.repo.runDay(tx, runId);
        const day = dayId ? content.get(dayId) : undefined;
        if (!day || !isReleasedDay(day.day, lastDayOf(content))) return;
        await lockServedDay(tx, day);
        const row = await deps.repo.lockRun(tx, runId);
        if (!row || row.done || row.content_version !== day.contentVersion) return;
        const saved = await recordProjection(tx, row, await nowMs(tx));
        if (saved !== row && rules.completion(saved.state) && saved.ranked) leaderboards.delete(saved.day);
      });
    },

    async boards(): Promise<BoardsResponse> {
      const now = deps.now();
      const content = await deps.content();
      const lastDay = lastDayOf(content);
      const days: Record<string, number> = {};
      for (const [id, day] of content) if (calendar.isPlayableDay(id, lastDay, now)) days[id] = day.contentVersion;
      return { days, rankedFrom: config.rankedFrom };
    },

    /** A day the database clock has closed (for a review of its answers); anything else is the same 404 as a missing day. */
    async closedDay(dayId: string): Promise<Day> {
      const { day } = await playableDay(dayId);
      if (!calendar.isClosedDay(dayId, deps.now()) || !(await closedByDatabase(dayId))) throw new NotFoundError('Day not available');
      return day;
    },

    async leaderboard(dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse<Entry>> {
      const content = await deps.content();
      const day = dayId ?? calendar.boardDay(lastDayOf(content), deps.now());
      if (!content.has(day) || !isReleasedDay(day, lastDayOf(content))) return { day, players: 0, top: [], me: null };
      let cached = leaderboards.get(day);
      if (!cached || deps.now().getTime() - cached.at > config.leaderboardCacheMs) {
        cached = { at: deps.now().getTime(), ...(await deps.repo.leaderboard(day, config.leaderboardTop)) };
        leaderboards.set(day, cached);
      }
      const me = userId ? await deps.repo.rankOf(userId, day) : null;
      return { day, players: cached.players, top: cached.top, me };
    },
  };
}
