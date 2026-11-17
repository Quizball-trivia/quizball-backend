import { createHash } from 'node:crypto';
import { rejected } from '../daily/daily.errors.js';
import { finish as finishSeason, newDraft, optionsFor, pick as engineSign, respin as engineRespin, roundsOf, signAcademy, slotsOf, type DealOptions, type DraftMode, type DraftState, type RespinKind } from './draft.engine.js';
import {
  ACADEMY_RATING, BUDGET, CUP_STAGES, EUROPE_PLACES, EUROPE_STAGES, FORMATIONS, FREE_RESPINS, RESPIN_COST, RULES_V2, XI, boostOf, coinsFor, cupCoins, destination, fitPenalty, inXi, lines, momentsOf, offeredTactics, playCup,
  playSeasonPlan, priceOf, seasonStats, spentOn, wallet,
  type ChemLink, type ClubSeason, type CupRun, type DraftPlayer, type Era, type FormationId, type Honour, type MomentView, type Pick, type Prediction, type SeasonPlan, type SeasonResult, type TacticId, type Variant,
} from './draft.rules.js';
import type { ServerUniverse } from './draft.universe.js';

/**
 * What decides a draft's deal: same setup, same eleven spins, same luck. `hidden`: a Budget draft whose squads show
 * names and prices only; each rating appears when that player is signed.
 */
export interface RunSetup { release: string; leagueId: string; era: Era; formation: FormationId; variant: Variant; seed: string; respins?: number; hidden?: boolean; draw?: DealOptions; rules?: number }
export const isV2 = (setup: { rules?: number }) => setup.rules === RULES_V2;

/** Ratings, stats and real ids of the squad on offer stay on the server. */
export const squadHidden = (setup: Pick2<RunSetup, 'variant' | 'hidden'>): boolean => setup.variant === 'knowledge' || !!setup.hidden;
/** Ball Knowledge also keeps the signed players' ratings back until the season is played. */
export const picksHidden = (setup: Pick2<RunSetup, 'variant'>, phase: 'picking' | 'ready' | 'half' | 'result' | 'over' | 'cancelled'): boolean => setup.variant === 'knowledge' && phase !== 'result' && phase !== 'over';
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

export interface RunResultStored {
  season: StoredSeason;
  /** Older runs only: forecasts are no longer worked out. */
  prediction?: Prediction | null;
  coinsEarned: number;
  /** What it was played on: a finished run still opens after its day's content was corrected. */
  setup: RunSetup;
  /** Feeds the goals and awards the client shows. Not the deal's seed: a finished player cannot work out anyone's spins from it. */
  goalSeed: string;
  /** Rules v2: what happened besides the league. */
  extra?: SeasonExtra;
}

/** Rules v2: the cups, the moments, chemistry, the captain and tactics, and the real top scorer to measure against. */
export interface SeasonExtra {
  cup: CupRun; europe: CupRun | null; moments: MomentView[]; derby: string | null; links: ChemLink[]; captain: string | null; tactic: TacticId | null; tactic2: TacticId | null;
  realTop: { name: string; club: string; goals: number; season: string } | null; cupCoins: number; half: number;
  /** The January signing, if there was one: who came in where, and who went. */
  january: { slotId: string; in: string; out: string | null } | null;
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
  /** `half` (rules v2): the first half is played and the season waits on the January window. */
  phase: 'picking' | 'ready' | 'half' | 'result';
  /** Older runs only: forecasts are no longer worked out. */
  forecast?: Prediction | null;
  result: RunResultStored | null;
  /** Rules v2: the armband (a place of the XI) and the tactics, before and after January. */
  captain?: string | null;
  tactic?: TacticId | null;
  tactic2?: TacticId | null;
  /** Rules v2, during `half`: the January window. `first` is the squad that played the first half. */
  january?: JanuaryWindow | null;
  /** The places free academy kids took on their own at the last move (nobody was affordable). */
  forced?: string[];
}

export interface JanuaryWindow {
  spinId: string | null;
  spins: number;
  first: (Pick | null)[];
  /** One signing at most: the place, who left (sold for half his price), and the money that sale lost. */
  signing: { slotId: string; out: Pick | null; refund: number } | null;
}
/** A first look and one re-spin. */
export const JANUARY_SPINS = 2;

export const newRunState = (rounds = XI): RunState => ({ spinId: null, round: 0, spinCount: 0, usedClubs: null, respins: null, respinsUsed: 0, armed: true, picks: Array(rounds).fill(null), undo: null, notice: null, phase: 'picking', result: null });

/** The engine's full state for this run. The seat name is unused by every rule the server runs. */
export function thaw(u: ServerUniverse, mode: DraftMode, setup: RunSetup, st: RunState, coins = 0): DraftState {
  const base = newDraft(u, { mode, variant: setup.variant, leagueId: setup.leagueId, era: setup.era, formation: setup.formation, seed: setup.seed, respins: setup.respins, coins, draw: setup.draw, rules: setup.rules, seats: [{ name: 'p', avatar: null, bot: false }] });
  if (st.spinId === null) return base;
  const spin = u.clubSeason(st.spinId);
  if (!spin) throw rejected('content_changed');
  return {
    ...base, spin, round: st.round, spinCount: st.spinCount, usedClubs: st.usedClubs ?? base.usedClubs, respins: st.respins ?? base.respins, respinsUsed: st.respinsUsed, notice: st.notice, forced: st.forced ?? [],
    phase: st.phase === 'result' || st.phase === 'half' ? 'ready' : st.phase, seats: base.seats.map((seat) => ({ ...seat, picks: st.picks })),
  };
}

const freeze = (d: DraftState, st: RunState): RunState => ({
  ...st, spinId: d.spin.id, round: d.round, spinCount: d.spinCount, usedClubs: d.usedClubs, respins: d.respins, respinsUsed: d.respinsUsed, notice: d.notice,
  picks: d.seats[0].picks, phase: d.phase === 'ready' ? 'ready' : 'picking', forced: d.forced ?? [],
});

const needsPicking = (st: RunState): void => { if (st.phase !== 'picking') throw rejected('draft_over'); };

export interface RunContext { u: ServerUniverse; mode: DraftMode; setup: RunSetup; coins?: number }

export function spinMove(ctx: RunContext, st: RunState): RunState {
  // Academy kids the next squads forced in may have finished the XI: Spin is what reveals that.
  if (st.phase === 'ready' && st.armed) return completed(ctx, { ...st, armed: false, undo: null });
  needsPicking(st);
  if (!st.armed) return st;
  return { ...freeze(thaw(ctx.u, ctx.mode, ctx.setup, st), st), armed: false, undo: null };
}

/** A hidden squad's ids and person ids are opaque: what a pack's order or a person's id could say about a rating stays on the server. */
export const maskId = (seed: string, id: string): string => createHash('sha256').update(`${seed}|mask|${id}`).digest('hex').slice(0, 16);

/** Nothing more is worked out when the XI is complete: there is no forecast, the season itself is the reveal. */
const completed = (_ctx: RunContext, st: RunState): RunState => st;

const snapshot = (st: RunState, d: DraftState, name: string): Snapshot => ({ picks: st.picks, round: d.round, spinId: d.spin.id, spinCount: d.spinCount, usedClubs: d.usedClubs, phase: 'picking', name });

export function pickMove(ctx: RunContext, st: RunState, playerId: string, slotId?: string): RunState {
  // Armed first: the real phase may hold what the next squads forced, which the player has not seen yet.
  if (st.armed && st.phase !== 'result') throw rejected('spin_first');
  needsPicking(st);
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const player = squadHidden(ctx.setup) ? d.spin.players.find((p) => maskId(ctx.setup.seed, p.id) === playerId) : d.spin.players.find((p) => p.id === playerId);
  if (!player) throw rejected('invalid_pick');
  const next = engineSign(ctx.u, d, player.id, slotId);
  if (next === d) throw rejected('invalid_pick');
  // A signing that shows its rating cannot be taken back: undo would let a player try squads on for size.
  return completed(ctx, { ...freeze(next, st), armed: true, undo: ctx.setup.hidden ? null : snapshot(st, d, player.name) });
}

export function academyMove(ctx: RunContext, st: RunState, slotId: string): RunState {
  if (st.armed && st.phase !== 'result') throw rejected('spin_first');
  needsPicking(st);
  if (ctx.setup.variant !== 'budget') throw rejected('invalid_pick');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const next = signAcademy(ctx.u, d, slotId);
  if (next === d) throw rejected('invalid_pick');
  return completed(ctx, { ...freeze(next, st), armed: true, undo: ctx.setup.hidden ? null : snapshot(st, d, '') });
}

/** `coinsSpent`: what this re-spin must take from the wallet (paid re-spins exist only in free play). */
export function respinMove(ctx: RunContext, st: RunState, kind: RespinKind): { state: RunState; coinsSpent: number } {
  if (st.armed && st.phase !== 'result') throw rejected('spin_first');
  needsPicking(st);
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st, ctx.coins ?? 0);
  const next = engineRespin(ctx.u, d, kind);
  if (next === d) throw rejected('no_respins');
  const changed = next.spin.id !== d.spin.id;
  return { state: { ...freeze(next, st), undo: changed ? null : st.undo }, coinsSpent: d.coins - next.coins };
}

export function undoMove(st: RunState): RunState {
  if (st.phase === 'result' || !st.undo || !st.armed) throw rejected('nothing_to_undo');
  const u = st.undo;
  return { ...st, picks: u.picks, round: u.round, spinId: u.spinId, spinCount: u.spinCount, usedClubs: u.usedClubs, phase: 'picking', armed: false, undo: null, notice: null, forced: [] };
}

export function finishMove(ctx: RunContext, st: RunState): RunState {
  // Never saved twice: a second finish must not move a finished run on the board.
  if (st.phase === 'result') throw rejected('draft_over');
  if (isV2(ctx.setup)) return st.phase === 'half' ? secondHalf(ctx, st) : firstHalf(ctx, st);
  if (veiled(st).phase !== 'ready') throw rejected('draft_not_finished');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, st);
  const done = finishSeason(ctx.u, d);
  const season = done.seasons![0];
  return {
    ...st, phase: 'result', armed: false, undo: null, notice: null,
    result: {
      coinsEarned: done.coinsEarned, setup: ctx.setup, goalSeed: createHash('sha256').update(`${ctx.setup.seed}|goals`).digest('hex').slice(0, 24),
      season: { ...season, matches: season.matches.map((m) => ({ ...m, opponent: { id: m.opponent.id, name: m.opponent.name } })) },
    },
  };
}

// ── Rules v2: the team talk, two halves and the January window ─────────────────────────────────────────────────────

const runLeague = (ctx: RunContext) => ctx.u.leagues.find((l) => l.id === ctx.setup.leagueId) ?? ctx.u.leagues[0];
const runOpponents = (ctx: RunContext) => (ctx.setup.draw ? ctx.u.opponents(ctx.setup.leagueId, ctx.setup.seed, ctx.setup.draw) : ctx.u.opponents(ctx.setup.leagueId, ctx.setup.seed));
const togetherIn = (u: ServerUniverse) => (a: DraftPlayer, b: DraftPlayer) => u.together(a.personId ?? a.id, b.personId ?? b.id);
/** The last round before the January window. */
export const halfOf = (games: number) => Math.floor(games / 2);

const needsV2 = (ctx: RunContext) => { if (!isV2(ctx.setup)) throw rejected('invalid_move'); };
/** The XI (and bench) are complete and the season has not started: the team talk. */
const needsTeamTalk = (st: RunState) => { if (veiled(st).phase !== 'ready') throw rejected('draft_not_finished'); };

/** The armband for one of the XI (never an academy kid). */
export function captainMove(ctx: RunContext, st: RunState, slotId: string): RunState {
  needsV2(ctx);
  needsTeamTalk(st);
  const i = FORMATIONS[ctx.setup.formation].findIndex((x) => x.id === slotId);
  if (i < 0 || !st.picks[i] || st.picks[i]!.academy) throw rejected('invalid_pick');
  return { ...st, captain: slotId };
}

/** One of the three tactics on offer: before the season, or (during `half`) for the second half. */
export function tacticMove(ctx: RunContext, st: RunState, tactic: TacticId): RunState {
  needsV2(ctx);
  if (!offeredTactics(ctx.setup.seed).includes(tactic)) throw rejected('invalid_pick');
  if (st.phase === 'half') return { ...st, tactic2: tactic };
  needsTeamTalk(st);
  return { ...st, tactic };
}

/** The season as it stands: the first half's squad, and from January the squad now (if the window has closed). */
export function planOf(ctx: RunContext, st: RunState, withSecond: boolean): SeasonPlan {
  const slots = FORMATIONS[ctx.setup.formation];
  const league = runLeague(ctx);
  const together = togetherIn(ctx.u);
  const first = st.january?.first ?? st.picks;
  const half = (picks: (Pick | null)[], tactic: TacticId | null) => ({ picks: picks.slice(0, XI), bench: picks.slice(XI), boost: boostOf(slots, picks.slice(0, XI), together, st.captain ?? null, tactic) });
  return {
    slots, first: half(first, st.tactic ?? null), ...(withSecond ? { second: half(st.picks, st.tactic2 ?? st.tactic ?? null) } : {}),
    half: halfOf(league.games), moments: momentsOf(ctx.setup.seed, slots, league.games, runOpponents(ctx)),
  };
}

function firstHalf(_ctx: RunContext, st: RunState): RunState {
  needsTeamTalk(st);
  return { ...st, phase: 'half', armed: false, undo: null, notice: null, january: { spinId: null, spins: 0, first: st.picks, signing: null } };
}

const needsWindow = (st: RunState): JanuaryWindow => {
  if (st.phase !== 'half' || !st.january) throw rejected('invalid_move');
  return st.january;
};

/** January: a squad to buy from (a first look, then one re-spin), never one of the clubs already dealt. */
export function januarySpinMove(ctx: RunContext, st: RunState): RunState {
  needsV2(ctx);
  const w = needsWindow(st);
  if (w.signing || w.spins >= JANUARY_SPINS) throw rejected('no_respins');
  const d = thaw(ctx.u, ctx.mode, ctx.setup, { ...st, phase: 'ready' });
  const spin = ctx.u.spin(ctx.setup.leagueId, ctx.setup.era, `${ctx.setup.seed}|january|${w.spins}`, d.usedClubs, ctx.setup.draw);
  return { ...st, january: { ...w, spinId: spin.id, spins: w.spins + 1 } };
}

/** What January has left to spend: the budget, less the squad now, less what a sale lost (a player goes for half his price). */
export function januaryMoney(ctx: RunContext, st: RunState): number {
  const loss = st.january?.signing ? (st.january.signing.out?.price ?? 0) - st.january.signing.refund : 0;
  return wallet(st.picks, runBudget(ctx)).left - loss;
}
const runBudget = (ctx: RunContext) => thaw(ctx.u, ctx.mode, ctx.setup, newRunState(roundsOf(ctx.setup))).budget;

/** The one January signing: he takes a place in the XI or on the bench, and whoever was there is sold for half his price. */
export function januarySignMove(ctx: RunContext, st: RunState, playerId: string, slotId: string): RunState {
  needsV2(ctx);
  const w = needsWindow(st);
  if (w.signing || !w.spinId) throw rejected('invalid_pick');
  const spin = ctx.u.clubSeason(w.spinId);
  if (!spin) throw rejected('content_changed');
  const player = squadHidden(ctx.setup) ? spin.players.find((p) => maskId(ctx.setup.seed, p.id) === playerId) : spin.players.find((p) => p.id === playerId);
  const slots = slotsOf({ formation: ctx.setup.formation, rules: ctx.setup.rules });
  const i = slots.findIndex((x) => x.id === slotId);
  if (!player || i < 0) throw rejected('invalid_pick');
  const penalty = fitPenalty(player, slots[i]);
  if (penalty === null || inXi(player, st.picks.map((p, k) => (k === i ? null : p)))) throw rejected('invalid_pick');
  const out = st.picks[i];
  const refund = out && !out.academy ? Math.floor((out.price ?? 0) / 2) : 0;
  const price = priceOf(player);
  const picks = st.picks.slice();
  picks[i] = { slotId, player, club: spin.club, season: spin.season, offPosition: penalty > 0, penalty, price, round: roundsOf(ctx.setup) };
  const next: RunState = { ...st, picks, january: { ...w, signing: { slotId, out, refund } } };
  if (januaryMoney(ctx, next) < 0) throw rejected('no_money');
  return next;
}

function secondHalf(ctx: RunContext, st: RunState): RunState {
  needsWindow(st);
  const plan = planOf(ctx, st, true);
  const league = runLeague(ctx);
  const { moments, derby, ...season } = playSeasonPlan(plan, league, runOpponents(ctx), ctx.setup.seed);
  const end = lines(plan.slots, plan.second!.picks, plan.second!.boost);
  const cup = playCup('cup', end, runOpponents(ctx), ctx.setup.seed, CUP_STAGES);
  const europe = season.position <= EUROPE_PLACES ? playCup('europe', end, ctx.u.europeField(ctx.setup.leagueId, ctx.setup.seed), ctx.setup.seed, EUROPE_STAGES) : null;
  const year = ctx.u.rivalYear(ctx.setup.leagueId, ctx.setup.seed, ctx.setup.draw);
  const top = year === null ? null : ctx.u.topScorer(ctx.setup.leagueId, year);
  const extraCoins = cupCoins(season, cup, europe);
  const w = st.january!;
  const signed = w.signing ? st.picks[slotsOf({ formation: ctx.setup.formation, rules: ctx.setup.rules }).findIndex((x) => x.id === w.signing!.slotId)] : null;
  const extra: SeasonExtra = {
    cup, europe, moments, derby: derby ? runOpponents(ctx).find((o) => o.id === derby)?.name ?? null : null, links: (plan.second!.boost as { links?: ChemLink[] }).links ?? [],
    captain: st.captain ?? null, tactic: st.tactic ?? null, tactic2: st.tactic2 ?? null, cupCoins: extraCoins, half: plan.half,
    realTop: top && year !== null ? { ...top, season: `${year}/${String((year + 1) % 100).padStart(2, '0')}` } : null,
    january: w.signing && signed ? { slotId: w.signing.slotId, in: signed.player.name, out: w.signing.out && !w.signing.out.academy ? w.signing.out.player.name : null } : null,
  };
  return {
    ...st, phase: 'result', armed: false, undo: null, notice: null,
    result: {
      coinsEarned: coinsFor(season, ctx.setup.variant) + extraCoins, setup: ctx.setup, goalSeed: createHash('sha256').update(`${ctx.setup.seed}|goals`).digest('hex').slice(0, 24),
      season: { ...season, matches: season.matches.map((m) => ({ ...m, opponent: { id: m.opponent.id, name: m.opponent.name } })) }, extra,
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
export interface PublicSpin { id: string; club: string; season: string; legend: boolean; finish: number; honour?: Honour; players: PublicPlayer[] }
export type PublicPick = Omit<Pick, 'player'> & { player: PublicPlayer };

/** A player as a hidden squad shows him: name, where he plays and, in Budget, his price. Nothing the rating is made of. */
export const hidePlayer = (seed: string, p: DraftPlayer, budget: boolean): PublicPlayer => ({
  id: maskId(seed, p.id), personId: maskId(seed, p.personId ?? p.id), name: p.name, pos: p.pos, alt: p.alt, role: p.role, rating: 0, apps: 0, goals: 0, assists: null, cleanSheets: 0, minutesShare: 0,
  ...(budget ? { price: priceOf(p) } : {}),
});
/** Everything about him, minus the reputation (the price already says what it says). */
export const showPlayer = (p: DraftPlayer, budget: boolean): PublicPlayer => { const { reputation: _reputation, ...rest } = p; return { ...rest, ...(budget ? { price: priceOf(p) } : {}) }; };
/** A signing in a hidden squad: his rating and stats are out, his ids stay masked so they still match the squad on screen. */
export const revealPlayer = (seed: string, p: DraftPlayer, budget: boolean): PublicPlayer => ({ ...showPlayer(p, budget), id: maskId(seed, p.id), personId: maskId(seed, p.personId ?? p.id) });

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
  /** Always null: there is no forecast any more (kept for clients from before). */
  prediction: null;
  /** The squad on offer shows names (and prices) only. */
  hideSquad: boolean;
  /** Signed players keep their ratings hidden too (Ball Knowledge, until the result). */
  hidePicks: boolean;
  /** The places free academy kids just took on their own. */
  forced: string[];
  result: (Omit<RunResultStored, 'setup' | 'prediction'> & { stats: ReturnType<typeof seasonStats> }) | null;
  /** The season rules (2: bench, team talk, two halves, cups). */
  rules: number;
  /** Rules v2: the armband, the tactics on offer and chosen, and the former teammates in the XI so far. */
  captain: string | null;
  tactic: TacticId | null;
  tactic2: TacticId | null;
  tactics: TacticId[] | null;
  links: ChemLink[] | null;
  /** Rules v2, at the turn of the year: the first half as played, and the January window. */
  half: PublicHalf | null;
}

export interface PublicHalf {
  half: number;
  matches: Array<{ round: number; home: boolean; gf: number; ga: number; opponent: string }>;
  position: number;
  gap: number;
  leader: string;
  moments: MomentView[];
  window: { spin: PublicSpin | null; spinsLeft: number; money: number; signing: { slotId: string; in: string; out: string | null; refund: number } | null };
}

/**
 * After a signing the next squad is already checked for a fit: that can leave a notice, place academy kids and skip
 * rounds. Shown before Spin, it would tell a player about squads they have not seen, then Undo would let them use it.
 */
export function veiled(st: RunState): RunState {
  if (!st.armed || !st.undo || st.phase === 'result') return st;
  const signed = st.undo.round;
  const forced = (p: Pick | null) => !!p?.academy && (p.round ?? 0) > signed;
  if (!st.picks.some(forced)) return { ...st, notice: null };
  return { ...st, notice: null, phase: 'picking', round: signed + 1, picks: st.picks.map((p) => (forced(p) ? null : p)) };
}

export function publicRun(ctx: RunContext, real: RunState): PublicRun {
  const { setup, u } = ctx;
  const st = veiled(real);
  const hideSquad = squadHidden(setup) && st.phase !== 'result';
  const hidePicks = picksHidden(setup, st.phase);
  const budget = setup.variant === 'budget';
  const d = thaw(u, ctx.mode, setup, st);
  const league = u.leagues.find((l) => l.id === setup.leagueId) ?? u.leagues[0];
  const slots = FORMATIONS[setup.formation];
  const picks = st.picks.map((p): PublicPick | null => {
    if (!p) return null;
    if (hidePicks) { const { best: _best, ...rest } = p; return { ...rest, player: p.academy ? { ...p.player, rating: 0 } : hidePlayer(setup.seed, p.player, budget) }; }
    // Who was best on offer is the reveal at the end, not a hint along the way.
    if (hideSquad) { const { best: _best, ...rest } = p; return { ...rest, player: p.academy ? p.player : revealPlayer(setup.seed, p.player, budget) }; }
    return { ...p, player: showPlayer(p.player, budget) };
  });
  const squad = (c: ClubSeason): PublicPlayer[] => (hideSquad ? c.players.map((p) => hidePlayer(setup.seed, p, budget)).sort((a, b) => a.name.localeCompare(b.name)) : c.players.map((p) => showPlayer(p, budget)));
  const spin = st.armed || st.phase !== 'picking' ? null : {
    id: hideSquad ? maskId(setup.seed, d.spin.id) : d.spin.id, club: d.spin.club, season: d.spin.season, legend: d.spin.legend, finish: hideSquad ? 0 : d.spin.finish, ...(d.spin.honour ? { honour: d.spin.honour } : {}), players: squad(d.spin),
  };
  return {
    variant: setup.variant, league: { id: league.id, name: league.name, short: league.short, teams: league.teams, games: league.games }, era: setup.era, formation: setup.formation,
    phase: st.phase, armed: st.armed, round: st.round, picks, spin, pool: (setup.draw ? u.opponents(setup.leagueId, setup.seed, setup.draw) : u.opponents(setup.leagueId, setup.seed)).map((o) => o.name).sort((a, b) => a.localeCompare(b)), respins: st.respins ?? setup.respins ?? FREE_RESPINS, respinCost: ctx.mode === 'free' ? RESPIN_COST : null,
    budget: budget ? d.budget : null, spent: spentOn(st.picks), notice: st.notice, undoName: st.undo?.name ?? null, canUndo: !!st.undo && st.armed, prediction: null, hideSquad, hidePicks,
    rules: setup.rules ?? 1, captain: st.captain ?? null, tactic: st.tactic ?? null, tactic2: st.tactic2 ?? null, tactics: isV2(setup) ? offeredTactics(setup.seed) : null,
    links: isV2(setup) && !hidePicks ? boostOf(FORMATIONS[setup.formation], st.picks.slice(0, XI), togetherIn(u), null, null).links : null,
    half: isV2(setup) && st.phase === 'half' ? halfView(ctx, st, squad) : null,
    // Whatever the last notice says, the places money forced stay named; only the veil before Spin hides them.
    forced: real.armed && real.undo && real.phase !== 'result' ? [] : st.forced ?? [],
    result: st.result ? (({ setup: _setup, prediction: _prediction, ...shown }) => ({ ...shown, stats: seasonStats(st.result!.goalSeed, st.result!.season, slots, st.picks) }))(st.result) : null,
  };
}

/** The first half as played: results, the table at the turn of the year, who was out, and the January window. */
function halfView(ctx: RunContext, st: RunState, squad: (c: ClubSeason) => PublicPlayer[]): PublicHalf {
  const plan = planOf(ctx, { ...st, picks: st.january?.first ?? st.picks }, false);
  const season = playSeasonPlan(plan, runLeague(ctx), runOpponents(ctx), ctx.setup.seed);
  const step = season.race[plan.half - 1];
  const w = st.january!;
  const spin = w.spinId ? ctx.u.clubSeason(w.spinId) : null;
  const hide = squadHidden(ctx.setup);
  const slotsAll = slotsOf({ formation: ctx.setup.formation, rules: ctx.setup.rules });
  const signed = w.signing ? st.picks[slotsAll.findIndex((x) => x.id === w.signing!.slotId)] : null;
  return {
    half: plan.half,
    matches: season.matches.slice(0, plan.half).map((m) => ({ round: m.round, home: m.home, gf: m.gf, ga: m.ga, opponent: m.opponent.name })),
    position: step?.position ?? 0, gap: step?.gap ?? 0, leader: step?.leader ?? '',
    moments: season.moments.filter((m) => m.round <= plan.half),
    window: {
      spin: spin && !w.signing ? { id: hide ? maskId(ctx.setup.seed, spin.id) : spin.id, club: spin.club, season: spin.season, legend: spin.legend, finish: hide ? 0 : spin.finish, ...(spin.honour ? { honour: spin.honour } : {}), players: squad(spin) } : null,
      spinsLeft: w.signing ? 0 : JANUARY_SPINS - w.spins, money: januaryMoney(ctx, st),
      signing: w.signing && signed ? { slotId: w.signing.slotId, in: signed.player.name, out: w.signing.out && !w.signing.out.academy ? w.signing.out.player.name : null, refund: w.signing.refund } : null,
    },
  };
}

export const publicConstants = { budget: BUDGET.total, academy: ACADEMY_RATING, respinCost: RESPIN_COST };
export { destination, optionsFor };
