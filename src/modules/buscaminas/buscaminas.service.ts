import { randomUUID } from 'node:crypto';
import { AuthorizationError, NotFoundError } from '../../core/errors.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { LEADERBOARD_CACHE_MS, LEADERBOARD_TOP, RUN_TOKEN_TTL_SECONDS } from './buscaminas.constants.js';
import { createContentLoader, type ContentIndex, type IndexedDay } from './buscaminas.content.js';
import { boardDay, dayEndsAt, isArchiveDay, isPlayableDay, rankedDay, releaseDay } from './buscaminas.days.js';
import { contentChanged, dayOver, disabled, signInForToday, staleState, tooManyRuns } from './buscaminas.errors.js';
import { redisRunLedger, redisStartCounter, type RunLedger, type StartCounter } from './buscaminas.ledger.js';
import { checkBuscaminasReadiness, usableTokenSecret } from './buscaminas.readiness.js';
import { buscaminasRepo, type BuscaminasRepo } from './buscaminas.repo.js';
import * as rules from './buscaminas.rules.js';
import { signToken, verifyToken } from './buscaminas.token.js';
import type { BuscaminasRunRow, LeaderboardEntry, PublicBoard, PublicRunState, RunPayload } from './buscaminas.types.js';

export interface RunResponse {
  token: string;
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

type Repo = Pick<BuscaminasRepo, 'withTx' | 'insertRun' | 'lockRun' | 'getRun' | 'saveState' | 'rankOf' | 'leaderboard'>;

export interface BuscaminasDeps {
  repo: Repo;
  /** Unranked runs only; the ranked path never touches Redis. */
  ledger: RunLedger;
  starts: StartCounter;
  /** Whether guests may play the live ranked day (then capped per address by `liveStartsPerDay`). */
  guestsPlayLive: () => boolean;
  liveStartsPerDay: () => number;
  content: () => Promise<ContentIndex>;
  secret: () => string;
  now: () => Date;
}

type Step = (p: RunPayload, day: IndexedDay) => { payload: RunPayload; extra?: { ok: boolean } };

export function createBuscaminasService(deps: BuscaminasDeps) {
  const leaderboards = new Map<string, { at: number; players: number; top: LeaderboardEntry[] }>();
  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);

  /** `iat` marks an unranked token (it then expires); ranked tokens are checked against their row instead. */
  const issue = (payload: RunPayload, day: IndexedDay | null, extra: { ranked: boolean; rank?: number }, iat?: number): RunResponse => ({
    token: signToken(payload, deps.secret(), iat === undefined ? undefined : { iat, exp: iat + RUN_TOKEN_TTL_SECONDS }),
    state: rules.publicState(payload, day?.rounds[payload.r] ?? null, {
      ...extra,
      // A live day's answers stay hidden for every run, ranked or not, until Buenos Aires midnight.
      reveal: isArchiveDay(payload.d, deps.now()),
    }),
  });

  /** A future day and a day with no content are the same 404: nothing may hint at what is coming. */
  async function playableDay(day: string): Promise<IndexedDay> {
    const content = (await deps.content()).get(day);
    if (!content || !isPlayableDay(day, deps.now())) throw new NotFoundError('Day not available');
    return content;
  }

  async function responseForRow(row: BuscaminasRunRow, day: IndexedDay | null, tx?: Parameters<Parameters<Repo['withTx']>[0]>[0]): Promise<RunResponse> {
    const rank = row.done ? (await deps.repo.rankOf(row.user_id, row.day, tx))?.rank : undefined;
    return issue(row.state, row.content_version === day?.contentVersion ? day : null, { ranked: true, rank });
  }

  /** Fresh unranked runs of a day whose answers are still secret are the answer oracle; cap them per address across replicas. */
  async function admitLiveStart(client: string): Promise<void> {
    const count = await deps.starts.hit(`${releaseDay(deps.now())}:${client}`);
    if (count > deps.liveStartsPerDay()) throw tooManyRuns();
  }

  /** Unless guests may play live, no unranked run of the live ranked day exists: it would probe the mines for a ranked run. */
  const unrankedLiveBlocked = (dayId: string): boolean => !deps.guestsPlayLive() && dayId === rankedDay(deps.now());

  async function start(dayId: string, userId: string | null, clientContentVersion?: number, client = 'unknown'): Promise<RunResponse> {
    const day = await playableDay(dayId);
    const unranked = !userId || dayId !== rankedDay(deps.now());
    if (unranked && unrankedLiveBlocked(dayId)) throw signInForToday();
    if (clientContentVersion !== undefined && clientContentVersion !== day.contentVersion) throw contentChanged();
    if (unranked) {
      if (deps.guestsPlayLive() && !isArchiveDay(dayId, deps.now())) await admitLiveStart(client);
      return issue(rules.newPayload(randomUUID(), dayId, day.contentVersion, null), day, { ranked: false }, nowSeconds());
    }
    return deps.repo.withTx(async (tx) => {
      const id = randomUUID();
      const inserted = await deps.repo.insertRun(tx, {
        id, userId, day: dayId, contentVersion: day.contentVersion, state: rules.newPayload(id, dayId, day.contentVersion, userId),
      });
      if (inserted) return responseForRow(inserted, day, tx);
      const row = await deps.repo.lockRun(tx, userId, dayId);
      if (!row) throw staleState();
      if (!row.done && row.content_version !== day.contentVersion) {
        // During a rolling deploy old and new processes disagree; only a client that already loaded this content may restart the run.
        if (clientContentVersion !== day.contentVersion) throw contentChanged();
        const reset = rules.newPayload(row.id, dayId, day.contentVersion, userId, row.state_version + 1);
        const saved = await deps.repo.saveState(tx, row.id, { state: reset, contentVersion: day.contentVersion, completion: null, closesAt: dayEndsAt(dayId) });
        if (!saved) throw dayOver();
        return responseForRow(saved, day, tx);
      }
      return responseForRow(row, day, tx);
    });
  }

  async function mutate(action: string, token: string, userId: string | null, input: string, step: Step): Promise<RunResponse> {
    const { payload, claims } = verifyToken(token, deps.secret());
    if (payload.u === null && !(claims && claims.exp > nowSeconds())) throw staleState();
    const day = (await deps.content()).get(payload.d);
    // Also a token issued while guests could play live, or a pre-launch preview carried past launch midnight.
    if (payload.u === null && unrankedLiveBlocked(payload.d)) throw signInForToday();
    if (!day || day.contentVersion !== payload.cv) throw contentChanged();

    if (payload.u === null) {
      // A live day's ledger fails closed if Redis lost the run; a past day's fails open, its answers being public already.
      const strict = !isArchiveDay(payload.d, deps.now());
      let out: ReturnType<Step>;
      try {
        out = step(payload, day);
      } catch (error) {
        if (await deps.ledger.consumed(payload.rid, payload.sv, strict)) throw staleState();
        throw error;
      }
      const next = { ...out.payload, sv: payload.sv + 1 };
      const issuedAt = nowSeconds();
      const claimed = await deps.ledger.claim(payload.rid, payload.sv, `${action}:${input}`, issuedAt, strict);
      if (claimed.kind === 'stale') throw staleState();
      // A retry of the consumed action rebuilds the same response (same state, same token) from the first issue time.
      return { ...issue(next, day, { ranked: false }, claimed.kind === 'replay' ? claimed.iat : issuedAt), ...out.extra };
    }

    if (payload.d !== rankedDay(deps.now())) throw dayOver();
    if (payload.u !== userId) throw new AuthorizationError('Sign in to continue this run');
    const owner = payload.u;
    const closesAt = dayEndsAt(payload.d);
    // The row is authoritative: an old token (a retry, another tab) is stale and the client re-syncs via /start.
    const response = await deps.repo.withTx(async (tx) => {
      const row = await deps.repo.lockRun(tx, owner, payload.d);
      if (!row || row.id !== payload.rid || row.state_version !== payload.sv) throw staleState();
      if (row.content_version !== payload.cv) throw contentChanged();
      const out = step(row.state, day);
      const next = { ...out.payload, sv: row.state_version + 1 };
      const completion = next.done ? { score: rules.score(next), perfects: rules.perfects(next.res) } : null;
      const saved = await deps.repo.saveState(tx, row.id, { state: next, contentVersion: row.content_version, completion, closesAt });
      // Under the row lock only the midnight cutoff can reject the update.
      if (!saved) throw dayOver();
      return { ...(await responseForRow(saved, day, tx)), ...out.extra };
    });
    if (response.state.done) leaderboards.delete(payload.d);
    return response;
  }

  const roundOf = (p: RunPayload, day: IndexedDay) => {
    const round = day.rounds[p.r];
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

    tap(token: string, cardId: string, userId: string | null): Promise<RunResponse & { ok?: boolean }> {
      return mutate('tap', token, userId, cardId, (p, day) => {
        const result = rules.tap(p, roundOf(p, day), cardId);
        return { payload: result.payload, extra: { ok: result.ok } };
      });
    },

    bank(token: string, userId: string | null): Promise<RunResponse> {
      return mutate('bank', token, userId, '', (p) => ({ payload: rules.bank(p) }));
    },

    next(token: string, userId: string | null): Promise<RunResponse> {
      return mutate('next', token, userId, '', (p, day) => ({ payload: rules.next(p, day.rounds.length) }));
    },

    async current(userId: string, dayId: string | undefined): Promise<RunResponse | { run: null }> {
      // Content first, so unusable content is a 503 here like on every other endpoint, even with no run to report.
      const content = await deps.content();
      const ranked = rankedDay(deps.now());
      const target = dayId ?? ranked;
      if (!target) return { run: null };
      if (target !== ranked) throw dayOver();
      const row = await deps.repo.getRun(userId, target);
      if (!row) return { run: null };
      const day = content.get(target) ?? null;
      // An unfinished run on other content is restarted by /start; report none so the client calls it.
      if (!row.done && row.content_version !== day?.contentVersion) return { run: null };
      return responseForRow(row, day);
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

export const buscaminasContent = createContentLoader({
  sealed: () => import('./content/content.enc.js').then((m) => m.BUSCAMINAS_SEALED_CONTENT),
  key: () => config.BUSCAMINAS_CONTENT_KEY,
});

export const buscaminasService = createBuscaminasService({
  repo: buscaminasRepo,
  ledger: redisRunLedger,
  starts: redisStartCounter,
  guestsPlayLive: () => config.BUSCAMINAS_GUESTS_PLAY_LIVE,
  liveStartsPerDay: () => config.BUSCAMINAS_GUEST_LIVE_STARTS_PER_DAY,
  content: () => buscaminasContent.load(),
  secret: () => {
    const secret = usableTokenSecret(config.BUSCAMINAS_TOKEN_SECRET);
    if (!secret) throw disabled();
    return secret;
  },
  now: () => new Date(),
});

/** Called once at boot; never blocks startup and never throws. */
export function startBuscaminasReadinessCheck(): void {
  if (!config.BUSCAMINAS_ENABLED) return;
  try {
    void checkBuscaminasReadiness({
      enabled: config.BUSCAMINAS_ENABLED,
      tokenSecret: config.BUSCAMINAS_TOKEN_SECRET,
      content: buscaminasContent,
      log: logger,
    }).catch(() => undefined);
  } catch {
    // Readiness is diagnostics only; it must never take the process down.
  }
}
