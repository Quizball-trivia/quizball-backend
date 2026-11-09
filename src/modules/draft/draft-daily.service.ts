import { logger } from '../../core/logger.js';
import { NotFoundError } from '../../core/errors.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, LoadFirst, type BoardsResponse, type LeaderboardResponse, type RunResponse } from '../daily/daily.service.js';
import { dayEndsAt, releaseDay } from '../daily/daily.calendar.js';
import { rejected } from '../daily/daily.errors.js';
import { storeRepo } from '../store/store.repo.js';
import { CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { draftDayContent, draftPacks, type IndexedDraftDay } from './draft.content.js';
import { draftCalendar, RANKED_START } from './draft-daily.days.js';
import { draftRepo } from './draft.repo.js';
import { academyMove, completionOf, finishMove, fromScore, newRunState, pickMove, publicRun, respinMove, spinMove, undoMove, type PublicRun, type RunContext, type RunSetup, type RunState } from './draft.run.js';
import type { RespinKind } from './draft.engine.js';
import type { Pick, Variant } from './draft.rules.js';
import type { ServerUniverse } from './draft.universe.js';

export type DraftDay = IndexedDraftDay & { universe: ServerUniverse };
export interface DraftRunRow extends DailyRunRowBase<RunState> { record: number | null }
interface BoardRow { rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null; country: string | null; tier: string | null; score: number; record: number }
export interface DraftBoardEntry extends Omit<BoardRow, 'record'> { w: number; d: number; l: number; points: number; gd: number; gf: number }

export type DailyPublic = PublicRun & { day: string; done: boolean; ranked: boolean; rank?: number; number: number | null };
export type DraftRunResponse = RunResponse<DailyPublic>;

/** Each version has its own deal: playing Classic must not give away what Ball Knowledge hides. */
const setupOf = (day: DraftDay, variant: Variant): RunSetup => ({ ...day.setup, variant, seed: `${day.setup.seed}|${variant}` });
export const setupForDay = setupOf;
const ctxOf = (day: DraftDay, variant: Variant): RunContext => ({ u: day.universe, mode: 'daily', setup: setupOf(day, variant) });

/** Served days with their squads attached; another day whose release cannot load is left out, today's is an error. */
function withPacks(days: () => Promise<ReadonlyMap<string, IndexedDraftDay>>): () => Promise<ReadonlyMap<string, DraftDay>> {
  let hydrated: { from: ReadonlyMap<string, IndexedDraftDay>; index: ReadonlyMap<string, DraftDay> } | null = null;
  return async () => {
    const index = await days();
    if (hydrated?.from === index) return hydrated.index;
    const releases = [...new Set([...index.values()].map((d) => d.setup.release))];
    const loaded = new Map(await Promise.all(releases.map(async (r) => [r, await draftPacks.get(r).catch(() => null)] as const)));
    const out = new Map<string, DraftDay>();
    for (const [id, day] of index) {
      const universe = loaded.get(day.setup.release);
      if (universe) out.set(id, { ...day, universe });
    }
    const today = releaseDay(new Date());
    if (index.has(today) && !out.has(today)) throw new Error('Football Draft squads could not be loaded');
    if (out.size === index.size) hydrated = { from: index, index: out };
    return out;
  };
}
const served = withPacks(() => draftDayContent.get());

function makeVariant(variant: Variant) {
  const repo = createDailyRunsRepo<RunState, DraftRunRow, BoardRow, unknown>({ runs: `draft_runs_${variant}`, days: 'draft_days', payload: 'setup', stat: 'record' });
  const decode = ({ record, ...row }: BoardRow): DraftBoardEntry => { const f = fromScore(row.score, record); return { ...row, w: f.w, d: f.d, l: f.l, points: f.points, gd: f.gd, gf: f.gf }; };

  const core = createDailyService<RunState, DraftRunRow, BoardRow, DraftDay, DailyPublic>(
    { repo, content: served, contentStale: () => draftDayContent.invalidate(), now: () => new Date() },
    {
      newState: () => newRunState(),
      project: (s) => s,
      rebase: () => newRunState(),
      completion: completionOf,
      publicState: (s, run, day, _now, extra) => {
        // A finished run whose day was corrected since keeps what it was played on.
        if (!day && s.result) {
          const u = draftPacks.ready(s.result.setup.release);
          if (!u) throw new LoadFirst(() => draftPacks.get(s.result!.setup.release));
          const old = publicRun({ u, mode: 'daily', setup: s.result.setup }, s);
          return { ...old, result: old.result && !extra.ranked ? { ...old.result, coinsEarned: 0 } : old.result, day: run.day, done: true, ranked: extra.ranked, rank: extra.rank, number: null };
        }
        if (!day) throw new NotFoundError('Day not available');
        // Only a ranked run pays: practice must not promise coins it will not give.
        const shown = publicRun(ctxOf(day, variant), s);
        return { ...shown, result: shown.result && !extra.ranked ? { ...shown.result, coinsEarned: 0 } : shown.result, day: run.day, done: s.phase === 'result', ranked: extra.ranked, rank: extra.rank, number: day.number };
      },
    },
    { calendar: draftCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS },
  );

  const move = (player: DailyPlayer, runId: string, version: number, step: (ctx: RunContext, s: RunState) => RunState): Promise<DraftRunResponse> =>
    core.mutate(player, runId, version, (s, day) => ({ state: step(ctxOf(day, variant), s) }));

  /** Coins for a finished daily, once per run; a failure here never takes the result away and the next read pays it. */
  async function payOnce(player: DailyPlayer, response: DraftRunResponse): Promise<void> {
    const coins = response.state.result?.coinsEarned ?? 0;
    if (player.kind !== 'member' || coins <= 0 || !response.state.ranked) return;
    try {
      await draftRepo.withTx(async (tx) => {
        const fresh = await draftRepo.recordAward(tx, { runId: response.run.id, userId: player.userId, day: response.state.day, source: 'daily', coins });
        if (fresh) await storeRepo.addCoinsInTx(tx, player.userId, coins);
      });
    } catch (error) {
      logger.warn({ err: error, runId: response.run.id }, 'Football Draft coins could not be paid yet');
    }
  }

  return {
    start: async (dayId: string, player: DailyPlayer, contentVersion?: number): Promise<DraftRunResponse> => {
      const response = await core.start(dayId, player, contentVersion);
      await payOnce(player, response);
      return response;
    },
    spin: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, spinMove),
    pick: (player: DailyPlayer, runId: string, version: number, playerId: string, slotId?: string) => move(player, runId, version, (ctx, s) => pickMove(ctx, s, playerId, slotId)),
    academy: (player: DailyPlayer, runId: string, version: number, slotId: string) => move(player, runId, version, (ctx, s) => academyMove(ctx, s, slotId)),
    /** The daily is equal for everyone: never paid. */
    respin: (player: DailyPlayer, runId: string, version: number, kind: RespinKind) => move(player, runId, version, (ctx, s) => respinMove(ctx, s, kind).state),
    undo: (player: DailyPlayer, runId: string, version: number) => move(player, runId, version, (_ctx, s) => undoMove(s)),
    finish: async (player: DailyPlayer, runId: string, version: number): Promise<DraftRunResponse> => {
      const response = await move(player, runId, version, finishMove);
      await payOnce(player, response);
      return response;
    },
    current: async (player: DailyPlayer, dayId: string | undefined) => {
      const response = await core.current(player, dayId);
      if (response && 'run' in response && response.run) await payOnce(player, response as DraftRunResponse);
      return response;
    },
    boards: (): Promise<BoardsResponse> => core.boards(),
    leaderboard: async (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse<DraftBoardEntry>> => {
      const board = await core.leaderboard(dayId, userId);
      return { ...board, top: board.top.map(decode), me: board.me ? decode(board.me) : null };
    },
    /** A finished run of that day, of a member or a guest. One from before a correction played another deal: it opens nothing of today's. */
    async finishedRun(player: DailyPlayer, dayId: string): Promise<DraftRunRow | null> {
      const row = await repo.getRun(player, dayId);
      if (!row || !row.done) return null;
      const day = (await served()).get(dayId);
      return day && row.content_version === day.contentVersion ? row : null;
    },
    closed: (dayId: string): boolean => draftCalendar.isClosedDay(dayId, new Date()),
    /** By the database clock too, the one the ranked write fence uses: a replica running ahead must not open a day early. */
    closedForSure: async (dayId: string): Promise<boolean> => draftCalendar.isClosedDay(dayId, new Date()) && repo.isClosed(dayEndsAt(dayId)),
    /** What the first screen shows: today's setup (never its seed), the player's own best, and whether today is done. */
    async today(player: DailyPlayer | null, requested?: string) {
      const now = new Date();
      const live = draftCalendar.rankedDay(now) ?? releaseDay(now);
      const days = await served();
      const dayId = requested && days.has(requested) && draftCalendar.isPlayableDay(requested, now) ? requested : live;
      const day = days.get(dayId);
      if (!day) throw new NotFoundError('Day not available');
      const league = day.universe.leagues.find((l) => l.id === day.setup.leagueId) ?? day.universe.leagues[0];
      const member = player?.kind === 'member';
      const practice = [...days.keys()].filter((d) => d < live && draftCalendar.isClosedDay(d, now)).sort().pop() ?? null;
      const played = player ? !!(await repo.getRun(player, dayId))?.done : false;
      const top = member ? await draftRepo.bestOf(variant, player.userId) : null;
      const best = top ? (({ w, d, l, points }) => ({ rec: `${w}–${d}–${l}`, points }))(fromScore(top.score, top.record)) : null;
      return { day: dayId, number: day.number, league, era: day.setup.era, formation: day.setup.formation, leagues: day.universe.leagues, best, played, guest: !member, live, practiceDay: practice };
    },
    async dayOf(dayId: string): Promise<DraftDay> {
      const day = (await served()).get(dayId);
      if (!day) throw new NotFoundError('Day not available');
      return day;
    },
  };
}

export const draftDaily: Record<Variant, ReturnType<typeof makeVariant>> = { budget: makeVariant('budget'), classic: makeVariant('classic'), knowledge: makeVariant('knowledge') };

const TEAM_SHAPE = (picks: (Pick | null)[]) => picks.map((p) => (p ? { slotId: p.slotId, club: p.club, season: p.season, offPosition: p.offPosition, penalty: p.penalty, academy: p.academy, price: p.price, round: p.round, player: { id: p.player.id, name: p.player.name, pos: p.player.pos, rating: p.player.rating, apps: p.player.apps, goals: p.player.goals, assists: p.player.assists, cleanSheets: p.player.cleanSheets, minutesShare: p.player.minutesShare } } : null));

/** Today's teams give today's draw away: only for someone who has finished that day and version, or once the day is closed. */
export async function boardTeam(variant: Variant, viewer: DailyPlayer | null, dayId: string, userId: string) {
  const game = draftDaily[variant];
  const closed = await game.closedForSure(dayId);
  if (!closed && !(viewer && (await game.finishedRun(viewer, dayId)))) throw rejected('play_first');
  const run = await game.finishedRun({ kind: 'member', userId }, dayId);
  if (!run || !run.ranked) throw new NotFoundError('Team not found');
  const day = await game.dayOf(dayId);
  return { formation: day.setup.formation, picks: TEAM_SHAPE(run.state.picks) };
}

export const teamShape = TEAM_SHAPE;

const KEEPER_MS = 5 * 60_000;
/** Called once at boot, never blocks startup: squads are in memory before anyone asks. */
export function startDraftReadinessCheck(): void {
  const keep = async () => { const days = await served(); if (days.size === 0) logger.warn('No Football Draft days loaded (draft_days is empty)'); return days.size; };
  void keep().then((days) => logger.info({ days }, 'Football Draft content loaded')).catch((error: unknown) => logger.warn({ err: error }, 'Football Draft content could not be loaded at boot'));
  setInterval(() => { void keep().catch((error: unknown) => logger.warn({ err: error }, 'Football Draft keeper failed')); }, KEEPER_MS).unref();
}
export { CONTENT_REFRESH_MS };
