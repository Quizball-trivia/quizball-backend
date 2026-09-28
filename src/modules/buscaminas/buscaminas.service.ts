import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from './buscaminas.constants.js';
import { createContentStore, type ContentIndex, type IndexedDay } from './buscaminas.content.js';
import { boardDay, dayEndsAt, isArchiveDay, isPlayableDay, rankedDay } from './buscaminas.days.js';
import { contentChanged, dayOver, notYourRun, signInForToday, staleState } from './buscaminas.errors.js';
import { buscaminasRepo, type BuscaminasRepo } from './buscaminas.repo.js';
import * as rules from './buscaminas.rules.js';
import type { BuscaminasRunRow, LeaderboardEntry, Player, PublicBoard, PublicRunState, RunState } from './buscaminas.types.js';

export interface RunResponse {
  run: { id: string; version: number };
  state: PublicRunState;
}

export interface BoardResponse {
  board: PublicBoard;
  /** Still the current puzzle (not yet over in Buenos Aires). */
  live: boolean;
}

export interface LeaderboardResponse {
  day: string;
  players: number;
  top: LeaderboardEntry[];
  me: LeaderboardEntry | null;
}

type Repo = Pick<BuscaminasRepo, 'withTx' | 'insertRun' | 'lockOwnRun' | 'lockRun' | 'getRun' | 'saveState' | 'unrankClosedRun' | 'rankOf' | 'leaderboard'>;
type Tx = Parameters<Parameters<Repo['withTx']>[0]>[0];

export interface BuscaminasDeps {
  repo: Repo;
  content: () => Promise<ContentIndex>;
  now: () => Date;
}

type Step = (s: RunState, day: IndexedDay) => { state: RunState; extra?: { ok: boolean } };

const owns = (row: BuscaminasRunRow, player: Player): boolean =>
  player.kind === 'member' ? row.user_id === player.userId : row.guest_id === player.guestId;

/**
 * Every run, guest or member, is one buscaminas_runs row per player per day: row-locked and
 * version-checked on every move. A member's run of the live day is ranked; every other run is not.
 */
export function createBuscaminasService(deps: BuscaminasDeps) {
  const leaderboards = new Map<string, { at: number; players: number; top: LeaderboardEntry[] }>();

  /** A future day and a day with no content are the same 404: nothing may hint at what is coming. */
  async function playableDay(day: string): Promise<IndexedDay> {
    const content = (await deps.content()).get(day);
    // Evaluate playability unconditionally so an unknown day and a future day take the same path.
    const playable = isPlayableDay(day, deps.now());
    if (!content || !playable) throw new NotFoundError('Day not available');
    return content;
  }

  async function respond(row: BuscaminasRunRow, day: IndexedDay | null, tx?: Tx): Promise<RunResponse> {
    const rank = row.ranked && row.done && row.user_id ? (await deps.repo.rankOf(row.user_id, row.day, tx))?.rank : undefined;
    // Answers of other content cannot describe this run's cards.
    const content = row.content_version === day?.contentVersion ? day : null;
    return {
      run: { id: row.id, version: row.state_version },
      state: rules.publicState(row.state, row.day, content?.rounds[row.state.r] ?? null, {
        ranked: row.ranked,
        rank,
        // A live day's answers stay hidden for every run, ranked or not, until Buenos Aires midnight.
        reveal: isArchiveDay(row.day, deps.now()),
      }),
    };
  }

  async function start(dayId: string, player: Player, clientContentVersion?: number): Promise<RunResponse> {
    const day = await playableDay(dayId);
    const live = dayId === rankedDay(deps.now());
    // Guests never see the live day's mines: an unranked run of it would probe them for a ranked one.
    if (live && player.kind === 'guest') throw signInForToday();
    if (clientContentVersion !== undefined && clientContentVersion !== day.contentVersion) throw contentChanged();
    const closesAt = dayEndsAt(dayId);
    return deps.repo.withTx(async (tx) => {
      const inserted = await deps.repo.insertRun(tx, {
        id: randomUUID(), player, day: dayId, ranked: live && player.kind === 'member', contentVersion: day.contentVersion, state: rules.newState(),
      });
      if (inserted) return respond(inserted, day, tx);
      let row = await deps.repo.lockOwnRun(tx, player, dayId);
      if (!row) throw staleState();
      // The ranked window closed before this run was finished: it goes on as practice, off the board.
      if (row.ranked && !row.done && !live) row = (await deps.repo.unrankClosedRun(tx, row.id, closesAt)) ?? row;
      if (!row.done && row.content_version !== day.contentVersion) {
        // During a rolling deploy or a correction, only a client that already loaded this content may restart the run.
        if (clientContentVersion !== day.contentVersion) throw contentChanged();
        const saved = await deps.repo.saveState(tx, row.id, {
          state: rules.newState(), stateVersion: row.state_version + 1, contentVersion: day.contentVersion, completion: null, closesAt,
        });
        if (!saved) throw dayOver();
        return respond(saved, day, tx);
      }
      return respond(row, day, tx);
    });
  }

  async function mutate(player: Player, runId: string, version: number, step: Step): Promise<RunResponse & { ok?: boolean }> {
    const content = await deps.content();
    // Read before waiting on the row lock; the UPDATE itself re-checks the ranked cutoff at statement time.
    const today = rankedDay(deps.now());
    const response = await deps.repo.withTx(async (tx) => {
      const row = await deps.repo.lockRun(tx, runId);
      if (!row) throw new NotFoundError('Run not found');
      if (!owns(row, player)) throw notYourRun();
      // Only a pre-launch preview run can be an unranked run of the live day; its guest may not carry it on.
      if (!row.ranked && player.kind === 'guest' && row.day === today) throw signInForToday();
      if (row.ranked && row.day !== today) throw dayOver();
      // The row is authoritative: an older version (a retry, another tab) is stale and the client re-syncs via /start.
      if (row.state_version !== version) throw staleState();
      const day = content.get(row.day);
      if (!day || day.contentVersion !== row.content_version) throw contentChanged();
      const out = step(row.state, day);
      const completion = out.state.done ? { score: rules.score(out.state), perfects: rules.perfects(out.state.res) } : null;
      const saved = await deps.repo.saveState(tx, row.id, {
        state: out.state, stateVersion: row.state_version + 1, contentVersion: row.content_version, completion, closesAt: dayEndsAt(row.day),
      });
      // Under the row lock only the ranked midnight cutoff can reject the update.
      if (!saved) throw dayOver();
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

    async board(dayId: string): Promise<BoardResponse> {
      const day = await playableDay(dayId);
      return { board: day.board, live: !isArchiveDay(dayId, deps.now()) };
    },

    async boards(): Promise<{ days: Record<string, number> }> {
      const now = deps.now();
      const days: Record<string, number> = {};
      for (const [id, day] of await deps.content()) if (isPlayableDay(id, now)) days[id] = day.contentVersion;
      return { days };
    },

    tap(player: Player, runId: string, version: number, cardId: string): Promise<RunResponse & { ok?: boolean }> {
      return mutate(player, runId, version, (s, day) => {
        const result = rules.tap(s, roundOf(s, day), cardId);
        return { state: result.state, extra: { ok: result.ok } };
      });
    },

    bank(player: Player, runId: string, version: number): Promise<RunResponse> {
      return mutate(player, runId, version, (s) => ({ state: rules.bank(s) }));
    },

    next(player: Player, runId: string, version: number): Promise<RunResponse> {
      return mutate(player, runId, version, (s, day) => ({ state: rules.next(s, day.rounds.length) }));
    },

    /** The player's run of `dayId` (default: the live day); none until /start created it. */
    async current(player: Player, dayId: string | undefined): Promise<RunResponse | { run: null }> {
      const content = await deps.content();
      const target = dayId ?? rankedDay(deps.now());
      if (!target) return { run: null };
      const row = await deps.repo.getRun(player, target);
      if (!row) return { run: null };
      const day = content.get(target) ?? null;
      // An unfinished run on other content is restarted by /start; report none so the client calls it.
      if (!row.done && row.content_version !== day?.contentVersion) return { run: null };
      return respond(row, day);
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

export type BuscaminasService = ReturnType<typeof createBuscaminasService>;

export const buscaminasContent = createContentStore(
  { fingerprint: () => buscaminasRepo.daysFingerprint(), load: () => buscaminasRepo.loadDays() },
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger },
);

export const buscaminasService = createBuscaminasService({
  repo: buscaminasRepo,
  content: () => buscaminasContent.get(),
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startBuscaminasReadinessCheck(): void {
  void buscaminasContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Buscaminas days loaded (buscaminas_days is empty); run npm run buscaminas:seed');
      else logger.info({ days: index.size }, 'Buscaminas days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Buscaminas days could not be loaded at boot'),
  );
}
