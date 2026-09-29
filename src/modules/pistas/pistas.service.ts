import { randomUUID } from 'node:crypto';
import { NotFoundError, type AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './pistas.constants.js';
import { copyClue, copyText, createContentStore, type ContentIndex, type IndexedDay } from './pistas.content.js';
import { boardDay, dayEndsAt, isClosedDay, isPlayableDay, rankedDay, RANKED_START, releaseDay } from './pistas.days.js';
import { contentChanged, dayOver, notYourRun, signInForToday, staleState } from './pistas.errors.js';
import { pistasRepo, type PistasRepo } from './pistas.repo.js';
import * as rules from './pistas.rules.js';
import type { LeaderboardEntry, PistasRunRow, Player, PublicRunState, ReviewResponse, RunState } from './pistas.types.js';

export interface RunResponse {
  run: { id: string; version: number };
  state: PublicRunState;
}

export interface BoardsResponse {
  /** Playable days → content version. Never any content. */
  days: Record<string, number>;
  rankedFrom: string;
}

export interface LeaderboardResponse {
  day: string;
  players: number;
  top: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

type Repo = Pick<PistasRepo,
  'withTx' | 'lockDay' | 'dayVersion' | 'insertRun' | 'lockOwnRun' | 'runDay' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rebaseRun'
  | 'isClosed' | 'rankOf' | 'leaderboard'>;
type Tx = Parameters<Parameters<Repo['withTx']>[0]>[0];

export interface PistasDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  /** The served content turned out older than the database (a correction): re-check it on the next read. */
  contentStale: () => void;
  now: () => Date;
}

type Step = (s: RunState, day: IndexedDay) => { state: RunState; extra?: { correct: boolean } };

const owns = (row: PistasRunRow, player: Player): boolean =>
  player.kind === 'member' ? row.user_id === player.userId : row.guest_id === player.guestId;

/**
 * Every run, guest or member, is one pistas_runs row per player per day: row-locked and
 * version-checked on every move. A member's run of the live ranked day is ranked; every other run is not.
 * Clue texts leave the server only once revealed; answers only as the round and the day allow.
 */
export function createPistasService(deps: PistasDeps) {
  const leaderboards = new Map<string, { at: number; players: number; top: LeaderboardEntry[] }>();
  /** Days the database clock has closed; once closed a day stays closed. */
  const closedDays = new Set<string>();

  /** A future day and a day with no content are the same 404: nothing may hint at what is coming. */
  async function playableDay(day: string): Promise<IndexedDay> {
    const content = (await deps.content()).get(day);
    // Evaluate playability unconditionally so an unknown day and a future day take the same path.
    const playable = isPlayableDay(day, deps.now());
    if (!content || !playable) throw new NotFoundError('Day not available');
    return content;
  }

  async function closedByDatabase(day: string): Promise<boolean> {
    if (closedDays.has(day)) return true;
    const closed = await deps.repo.isClosed(dayEndsAt(day));
    if (closed) closedDays.add(day);
    return closed;
  }

  /**
   * Holds the day's row FOR SHARE for the rest of the transaction and checks that the content this
   * replica serves (cached, up to CONTENT_REFRESH_MS old) is still the stored one. A correction
   * therefore waits for this write, and a move judged against superseded content never lands.
   */
  async function lockServedDay(tx: Tx, day: IndexedDay): Promise<void> {
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

  async function respond(row: PistasRunRow, day: IndexedDay | null, tx?: Tx): Promise<RunResponse> {
    const rank = row.ranked && row.done && row.user_id ? (await deps.repo.rankOf(row.user_id, row.day, tx))?.rank : undefined;
    // Clues and answers of other content cannot describe this run.
    const content = row.content_version === day?.contentVersion ? day : null;
    return {
      run: { id: row.id, version: row.state_version },
      state: rules.publicState(row.state, row.day, content?.rounds[row.state.r] ?? null, {
        ranked: row.ranked,
        rank,
        // A missed round's answer waits for the database clock to close the day, for every run.
        disclose: row.closed,
      }),
    };
  }

  async function start(dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> {
    const day = await playableDay(dayId);
    const now = deps.now();
    // Guests play closed days only: an unranked run of today would probe it for a ranked one. Closed by the
    // database clock too, the ranked write fence's clock: a replica running ahead must not open the day early.
    if (player.kind === 'guest' && !(isClosedDay(dayId, now) && (await closedByDatabase(dayId)))) throw signInForToday();
    if (clientContentVersion !== undefined && clientContentVersion !== day.contentVersion) throw otherContent();
    const live = dayId === rankedDay(now);
    return deps.repo.withTx(async (tx) => {
      await lockServedDay(tx, day);
      const inserted = await deps.repo.insertRun(tx, {
        id: randomUUID(), player, day: dayId, ranked: live && player.kind === 'member', contentVersion: day.contentVersion,
        state: rules.newState(), closesAt: dayEndsAt(dayId),
      });
      if (inserted) return respond(inserted, day, tx);
      let row = await deps.repo.lockOwnRun(tx, player, dayId);
      if (!row) throw staleState();
      // The ranked window closed before this run was finished: it goes on as practice, off the board.
      if (row.ranked && !row.done && !live) row = (await deps.repo.unrankClosedRun(tx, row.id)) ?? row;
      // A correction (which unranked the day's runs) replaced the content: an unfinished run moves onto it;
      // a finished one keeps its own and shows no content of the new one.
      if (row.content_version !== day.contentVersion && !row.done) {
        const rebased = await deps.repo.rebaseRun(tx, row.id, day.contentVersion, rules.rebase(row.state));
        if (!rebased) throw otherContent();
        row = rebased;
      }
      return respond(row, day, tx);
    });
  }

  async function mutate(player: Player, runId: string, version: number, step: Step): Promise<RunResponse & { correct?: boolean }> {
    const content = await deps.content();
    // Read before waiting on the row lock; the UPDATE itself re-checks the ranked cutoff at statement time.
    const now = deps.now();
    const today = rankedDay(now);
    const response = await deps.repo.withTx(async (tx) => {
      const dayId = await deps.repo.runDay(tx, runId);
      if (!dayId) throw new NotFoundError('Run not found');
      const day = content.get(dayId);
      if (!day) throw otherContent();
      // Day before run, the seed's order: a correction holding the day never waits on a run this move holds.
      await lockServedDay(tx, day);
      const row = await deps.repo.lockRun(tx, runId);
      if (!row) throw new NotFoundError('Run not found');
      if (!owns(row, player)) throw notYourRun();
      if (player.kind === 'guest' && !(isClosedDay(row.day, now) && row.closed)) throw signInForToday();
      if (row.ranked && row.day !== today) throw dayOver();
      // The row is authoritative: an older version (a retry, another tab) is stale and the client re-syncs via /start.
      if (row.state_version !== version) throw staleState();
      if (day.contentVersion !== row.content_version) throw otherContent();
      const out = step(row.state, day);
      const completion = out.state.done ? { score: rules.score(out.state), solved: rules.solved(out.state) } : null;
      const saved = await deps.repo.saveState(tx, row.id, {
        state: out.state, stateVersion: row.state_version + 1, contentVersion: row.content_version, completion,
      });
      if (!saved) throw await rejectedWrite(tx, row.day, row.content_version);
      return { ...(await respond(saved, day, tx)), ...out.extra };
    });
    if (response.state.done && response.state.ranked) leaderboards.delete(response.state.day);
    return response;
  }

  const roundOf = (s: RunState, day: IndexedDay) => {
    const round = day.rounds[s.r];
    if (!round) throw contentChanged();
    return round;
  };

  return {
    start,

    reveal(player: Player, runId: string, version: number): Promise<RunResponse> {
      return mutate(player, runId, version, (s) => ({ state: rules.reveal(s) }));
    },

    guess(player: Player, runId: string, version: number, text: string): Promise<RunResponse & { correct?: boolean }> {
      return mutate(player, runId, version, (s, day) => {
        const result = rules.guess(s, roundOf(s, day), text, day.rounds.length);
        return { state: result.state, extra: { correct: result.correct } };
      });
    },

    giveUp(player: Player, runId: string, version: number): Promise<RunResponse> {
      return mutate(player, runId, version, (s, day) => ({ state: rules.giveUp(s, day.rounds.length) }));
    },

    next(player: Player, runId: string, version: number): Promise<RunResponse> {
      return mutate(player, runId, version, (s) => ({ state: rules.next(s) }));
    },

    /** The player's run of `dayId` (default: today); none until /start created it, or while /start must move it onto corrected content. */
    async current(player: Player, dayId: string | undefined): Promise<RunResponse | { run: null }> {
      const content = await deps.content();
      const target = dayId ?? releaseDay(deps.now());
      const row = await deps.repo.getRun(player, target);
      if (!row) return { run: null };
      const day = content.get(target) ?? null;
      if (row.content_version !== day?.contentVersion) return { run: null };
      return respond(row, day);
    },

    async boards(): Promise<BoardsResponse> {
      const now = deps.now();
      const days: Record<string, number> = {};
      for (const [id, day] of await deps.content()) if (isPlayableDay(id, now)) days[id] = day.contentVersion;
      return { days, rankedFrom: RANKED_START };
    },

    /** Every clue and answer of a day the database clock has closed; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await playableDay(dayId);
      if (!isClosedDay(dayId, deps.now()) || !(await closedByDatabase(dayId))) throw new NotFoundError('Day not available');
      return {
        day: dayId,
        rounds: day.rounds.map((round, i) => ({ number: i + 1, answer: { display: copyText(round.display) }, clues: round.clues.map(copyClue) })),
      };
    },

    async leaderboard(dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> {
      const day = dayId ?? boardDay(deps.now());
      if (!(await deps.content()).has(day)) return { day, players: 0, top: [], me: null };
      let cached = leaderboards.get(day);
      if (!cached || deps.now().getTime() - cached.at > LEADERBOARD_CACHE_MS) {
        cached = { at: deps.now().getTime(), ...(await deps.repo.leaderboard(day, LEADERBOARD_TOP)) };
        leaderboards.set(day, cached);
      }
      const me = userId ? await deps.repo.rankOf(userId, day) : null;
      return { day, players: cached.players, top: cached.top, me };
    },
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
