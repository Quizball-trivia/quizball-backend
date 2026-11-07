import { createHash } from 'node:crypto';
import { rejected } from '../daily/daily.errors.js';
import { finish as finishSeason, newDraft, optionsFor, pick as engineSign, respin as engineRespin, signAcademy, slotsOf, type DraftMode, type DraftState, type RespinKind } from './draft.engine.js';
import {
  ACADEMY_RATING, BUDGET, FORMATIONS, FREE_RESPINS, RESPIN_COST, destination, predictSeason, priceOf, seasonStats, spentOn,
  type ClubSeason, type DraftPlayer, type Era, type FormationId, type Pick, type Prediction, type SeasonResult, type Variant,
} from './draft.rules.js';
import type { ServerUniverse } from './draft.universe.js';

/** What decides a draft's deal: same setup, same eleven spins, same luck. */
export interface RunSetup { release: string; leagueId: string; era: Era; formation: FormationId; variant: Variant; seed: string; respins?: number }

export interface RunResultStored {
  season: StoredSeason;
  prediction: Prediction;
  coinsEarned: number;
  /** What it was played on: a finished run still opens after its day's content was corrected. */
  setup: RunSetup;
  /** Feeds the goals and awards the client shows. Not the deal's seed: a finished player cannot work out anyone's spins from it. */
  goalSeed: string;
}
export type StoredSeason = Omit<SeasonResult, 'matches'> & { matches: Array<Omit<SeasonResult['matches'][number], 'opponent'> & { opponent: { id: string; name: string } }> };

interface Snapshot { picks: (Pick | null)[]; round: number; spinId: string; spinCount: number; usedClubs: string[]; phase: 'picking' | 'ready'; name: string }

/** What one run stores: everything a move needs, with the deal rebuilt from the setup each time. */
export interface RunState {
  /** Null until the first move: the day or setup decides the rest. */
  spinId: string | null;
  round: number;
  spinCount: number;
  usedClubs: string[] | null;
  respins: number | null;
  respinsUsed: number;
  /** The next squad exists but stays off the wire until the player presses Spin: that is what makes Undo safe. */
  armed: boolean;
  picks: (Pick | null)[];
  undo: Snapshot | null;
  notice: DraftState['notice'];
  phase: 'picking' | 'ready' | 'result';
  /** Worked out once when the XI is complete: reads never redo it. */
  forecast: Prediction | null;
  result: RunResultStored | null;
}

export const newRunState = (): RunState => ({ spinId: null, round: 0, spinCount: 0, usedClubs: null, respins: null, respinsUsed: 0, armed: true, picks: Array(11).fill(null), undo: null, notice: null, phase: 'picking', forecast: null, result: null });

/** The engine's full state for this run. The seat name is unused by every rule the server runs. */
export function thaw(u: ServerUniverse, mode: DraftMode, setup: RunSetup, st: RunState, coins = 0): DraftState {
  const base = newDraft(u, { mode, variant: setup.variant, leagueId: setup.leagueId, era: setup.era, formation: setup.formation, seed: setup.seed, respins: setup.respins, coins, seats: [{ name: 'p', avatar: null, bot: false }] });
  if (st.spinId === null) return base;
  const spin = u.clubSeason(st.spinId);
  if (!spin) throw rejected('content_changed');
  return {
    ...base, spin, round: st.round, spinCount: st.spinCount, usedClubs: st.usedClubs ?? base.usedClubs, respins: st.respins ?? base.respins, respinsUsed: st.respinsUsed, notice: st.notice,
    phase: st.phase === 'result' ? 'ready' : st.phase, seats: base.seats.map((seat) => ({ ...seat, picks: st.picks })),
  };
}

const freeze = (d: DraftState, st: RunState): RunState => ({
  ...st, spinId: d.spin.id, round: d.round, spinCount: d.spinCount, usedClubs: d.usedClubs, respins: d.respins, respinsUsed: d.respinsUsed, notice: d.notice,
  picks: d.seats[0].picks, phase: d.phase === 'ready' ? 'ready' : 'picking',
});

const needsPicking = (st: RunState): void => { if (st.phase !== 'picking') throw rejected('draft_over'); };

export interface RunContext { u: ServerUniverse; mode: DraftMode; setup: RunSetup; coins?: number }

export function spinMove(ctx: RunContext, st: RunState): RunState {
  needsPicking(st);
  if (!st.armed) return st;
  return { ...freeze(thaw(ctx.u, ctx.mode, ctx.setup, st), st), armed: false, undo: null };
}

/** A hidden squad's ids and person ids are opaque: what a pack's order or a person's id could say about a rating stays on the server. */
export const maskId = (seed: string, id: string): string => createHash('sha256').update(`${seed}|mask|${id}`).digest('hex').slice(0, 16);

const leagueOf = (ctx: RunContext) => ctx.u.leagues.find((l) => l.id === ctx.setup.leagueId) ?? ctx.u.leagues[0];
const completed = (ctx: RunContext, st: RunState): RunState => (st.phase === 'ready' ? { ...st, forecast: predictSeason(FORMATIONS[ctx.setup.formation], st.picks, leagueOf(ctx), ctx.u.opponents(ctx.setup.leagueId, ctx.setup.seed), ctx.setup.seed) } : st);

const snapshot = (st: RunState, d: DraftState, name: string): Snapshot => ({ picks: st.picks, round: d.round, spinId: d.spin.id, spinCount: d.spinCount, usedClubs: d.usedClubs, phase: 'picking', name });

export function pickMove(ctx: RunContext, st: RunState, playerId: string, slotId?: string): RunState {
  needsPicking(st);
  if (st.armed) throw rejected('spin_first');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const player = ctx.setup.variant === 'knowledge' ? d.spin.players.find((p) => maskId(ctx.setup.seed, p.id) === playerId) : d.spin.players.find((p) => p.id === playerId);
  if (!player) throw rejected('invalid_pick');
  const next = engineSign(ctx.u, d, player.id, slotId);
  if (next === d) throw rejected('invalid_pick');
  return completed(ctx, { ...freeze(next, st), armed: true, undo: snapshot(st, d, player.name) });
}

export function academyMove(ctx: RunContext, st: RunState, slotId: string): RunState {
  needsPicking(st);
  if (st.armed) throw rejected('spin_first');
  if (ctx.setup.variant !== 'budget') throw rejected('invalid_pick');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const next = signAcademy(ctx.u, d, slotId);
  if (next === d) throw rejected('invalid_pick');
  return completed(ctx, { ...freeze(next, st), armed: true, undo: snapshot(st, d, '') });
}

/** `coinsSpent`: what this re-spin must take from the wallet (paid re-spins exist only in free play). */
export function respinMove(ctx: RunContext, st: RunState, kind: RespinKind): { state: RunState; coinsSpent: number } {
  needsPicking(st);
  if (st.armed) throw rejected('spin_first');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st, ctx.coins ?? 0);
  const next = engineRespin(ctx.u, d, kind);
  if (next === d) throw rejected('no_respins');
  const changed = next.spin.id !== d.spin.id;
  return { state: { ...freeze(next, st), undo: changed ? null : st.undo }, coinsSpent: d.coins - next.coins };
}

export function undoMove(st: RunState): RunState {
  if (st.phase === 'result' || !st.undo || !st.armed) throw rejected('nothing_to_undo');
  const u = st.undo;
  return { ...st, picks: u.picks, round: u.round, spinId: u.spinId, spinCount: u.spinCount, usedClubs: u.usedClubs, phase: 'picking', armed: false, undo: null, notice: null, forecast: null };
}

export function finishMove(ctx: RunContext, st: RunState): RunState {
  // Never saved twice: a second finish must not move a finished run on the board.
  if (st.phase === 'result') throw rejected('draft_over');
  if (st.phase !== 'ready') throw rejected('draft_not_finished');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const done = finishSeason(ctx.u, d);
  const season = done.seasons![0];
  const prediction = st.forecast ?? predictSeason(slotsOf(d), st.picks, leagueOf(ctx), ctx.u.opponents(ctx.setup.leagueId, ctx.setup.seed), ctx.setup.seed);
  return {
    ...st, phase: 'result', armed: false, undo: null, notice: null,
    result: {
      prediction, coinsEarned: done.coinsEarned, setup: ctx.setup, goalSeed: createHash('sha256').update(`${ctx.setup.seed}|goals`).digest('hex').slice(0, 24),
      season: { ...season, matches: season.matches.map((m) => ({ ...m, opponent: { id: m.opponent.id, name: m.opponent.name } })) },
    },
  };
}

/** Board order in one number: points, then goal difference, then goals scored. */
export const rankScore = (s: { points: number; gf: number; ga: number }): number => s.points * 1_000_000 + (s.gf - s.ga + 500) * 1000 + Math.min(999, s.gf);
/** The record on the board, in the runs table's second column. */
export const recordStat = (s: { w: number; d: number; l: number }): number => s.w * 10_000 + s.d * 100 + s.l;
export const fromScore = (score: number, stat: number) => ({ points: Math.floor(score / 1_000_000), gd: Math.floor((score % 1_000_000) / 1000) - 500, gf: score % 1000, w: Math.floor(stat / 10_000), d: Math.floor((stat % 10_000) / 100), l: stat % 100 });
export const completionOf = (st: RunState): { score: number; stat: number } | null => (st.phase === 'result' && st.result ? { score: rankScore(st.result.season), stat: recordStat(st.result.season) } : null);

// ── What a player sees ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PublicPlayer extends Omit<DraftPlayer, 'personId'> { personId?: string; price?: number }
export interface PublicSpin { id: string; club: string; season: string; legend: boolean; finish: number; players: PublicPlayer[] }
export type PublicPick = Omit<Pick, 'player'> & { player: PublicPlayer };

const hide = (seed: string, p: DraftPlayer): PublicPlayer => ({ id: maskId(seed, p.id), personId: maskId(seed, p.personId ?? p.id), name: p.name, pos: p.pos, alt: p.alt, role: p.role, rating: 0, apps: 0, goals: 0, assists: null, cleanSheets: 0, minutesShare: 0 });
const show = (p: DraftPlayer, budget: boolean): PublicPlayer => ({ ...p, ...(budget ? { price: priceOf(p) } : {}) });

export interface PublicRun {
  variant: Variant;
  league: { id: string; name: string; short: string; teams: number; games: number };
  era: Era;
  formation: FormationId;
  phase: RunState['phase'];
  armed: boolean;
  round: number;
  picks: (PublicPick | null)[];
  /** Null until Spin is pressed: a squad not yet revealed is not on the wire. */
  spin: PublicSpin | null;
  /** League names the reels roll through while spinning: says nothing about the deal. */
  pool: string[];
  respins: number;
  respinCost: number | null;
  budget: number | null;
  spent: number;
  notice: RunState['notice'];
  undoName: string | null;
  canUndo: boolean;
  prediction: Prediction | null;
  result: (Omit<RunResultStored, 'setup'> & { stats: ReturnType<typeof seasonStats> }) | null;
}

export function publicRun(ctx: RunContext, st: RunState): PublicRun {
  const { setup, u } = ctx;
  const hidden = setup.variant === 'knowledge' && st.phase !== 'result';
  const budget = setup.variant === 'budget';
  const d = thaw(u, ctx.mode, setup, st);
  const league = u.leagues.find((l) => l.id === setup.leagueId) ?? u.leagues[0];
  const slots = FORMATIONS[setup.formation];
  const picks = st.picks.map((p): PublicPick | null => {
    if (!p) return null;
    if (hidden) { const { best: _best, ...rest } = p; return { ...rest, player: p.academy ? { ...p.player, rating: 0 } : hide(setup.seed, p.player) }; }
    return { ...p, player: show(p.player, budget) };
  });
  const squad = (c: ClubSeason): PublicPlayer[] => (hidden ? c.players.map((p) => hide(setup.seed, p)).sort((a, b) => a.name.localeCompare(b.name)) : c.players.map((p) => show(p, budget)));
  const spin = st.armed || st.phase !== 'picking' ? null : { id: hidden ? maskId(setup.seed, d.spin.id) : d.spin.id, club: d.spin.club, season: d.spin.season, legend: d.spin.legend, finish: hidden ? 0 : d.spin.finish, players: squad(d.spin) };
  // Before the season a forecast is only for those who can already see the ratings.
  const prediction = st.result?.prediction ?? (st.phase === 'ready' && !hidden ? st.forecast : null);
  return {
    variant: setup.variant, league: { id: league.id, name: league.name, short: league.short, teams: league.teams, games: league.games }, era: setup.era, formation: setup.formation,
    phase: st.phase, armed: st.armed, round: st.round, picks, spin, pool: u.opponents(setup.leagueId, setup.seed).map((o) => o.name).sort((a, b) => a.localeCompare(b)), respins: st.respins ?? setup.respins ?? FREE_RESPINS, respinCost: ctx.mode === 'free' ? RESPIN_COST : null,
    budget: budget ? d.budget : null, spent: spentOn(st.picks), notice: st.notice, undoName: st.undo?.name ?? null, canUndo: !!st.undo && st.armed, prediction,
    result: st.result ? (({ setup: _setup, ...shown }) => ({ ...shown, stats: seasonStats(st.result!.goalSeed, st.result!.season, slots, st.picks) }))(st.result) : null,
  };
}

export const publicConstants = { budget: BUDGET.total, academy: ACADEMY_RATING, respinCost: RESPIN_COST };
export { destination, optionsFor };
