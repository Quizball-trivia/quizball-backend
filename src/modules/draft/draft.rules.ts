/**
 * Football Draft rules: pure functions only (no clock, no I/O). Spin a club-season, put one of its players in an open
 * slot, eleven times; the XI then plays a full league season (and, in a duel, a match-day head-to-head). Each fixture's luck
 * comes from the seed alone, never from who is in the XI, so a better player can only help and every team in a daily or a
 * room faces the same fixtures. Explanations are worked out by re-playing the fixture, so they say what really decided it.
 */

export type Pos = "GK" | "DEF" | "MID" | "FWD";
export type Era = "modern" | "legends" | "all";
export type Variant = "classic" | "knowledge" | "budget";
export type FormationId = "4-3-3" | "4-4-2" | "4-2-3-1" | "3-5-2";

/** Where a player really plays. Squads without this detail (some hand-researched seasons) count as natural anywhere in their line. */
export const ROLES = ["GK", "CB", "LB", "RB", "DM", "CM", "AM", "LM", "RM", "LW", "RW", "SS", "CF"] as const;
export type Role = (typeof ROLES)[number];

export interface DraftPlayer {
  id: string;
  /** The real person across clubs and seasons: one version of him per XI. */
  personId?: string;
  name: string;
  pos: Pos;
  /** Positions he can also cover (at a small cost). */
  alt?: Pos[];
  role?: Role;
  rating: number;
  apps: number;
  goals: number;
  /** Null when no figure exists for that season: shown as unknown, never as zero. */
  assists: number | null;
  cleanSheets: number;
  /** The clean sheets are estimated from the team's season, not a recorded figure. */
  cleanSheetsEstimated?: boolean;
  /** Share of the club's league minutes he played (0–1). */
  minutesShare: number;
  /** One of the all-time greats: a small bonus, shown in "why this rating?". */
  legend?: boolean;
  /**
   * What his name was worth, more than this one season: his best seasons elsewhere weigh in, so a star in a quiet year
   * costs like a star and a breakout season comes cheap. Sets the price; the rating stays what he did.
   */
  reputation?: number;
}

/** Why a season is in the Iconic Clubs league. */
export const HONOURS = ['treble', 'double', 'champions', 'unbeaten', 'centurions', 'ucl_winners', 'ucl_final', 'ucl_semi', 'european_cup', 'uefa_cup', 'europa_league', 'surprise', 'title_race'] as const;
export type Honour = (typeof HONOURS)[number];

export interface League { id: string; name: string; short: string; teams: number; games: number }

export interface ClubSeason {
  id: string;
  clubId: string;
  club: string;
  season: string;
  leagueId: string;
  legend: boolean;
  /** League finish that season (1 = champions). */
  finish: number;
  players: DraftPlayer[];
  /** Iconic Clubs only: what made the season. */
  honour?: Honour;
}

export interface Slot { id: string; label: string; pos: Pos; x: number; y: number }

export interface Pick {
  slotId: string; player: DraftPlayer; club: string; season: string; offPosition: boolean; academy?: boolean;
  /** The best player he could have taken for this spot from that squad: the reveal after a Ball Knowledge draft. */
  best?: { name: string; rating: number };
  /** Which of the eleven rounds he was signed in, to compare two drafts of the same deal pick by pick. */
  round?: number;
  /** What he cost in a Transfer budget draft, in millions. */
  price?: number;
  /** Rating points lost in this place. */
  penalty?: number;
}

const S = (id: string, label: string, pos: Pos, x: number, y: number): Slot => ({ id, label, pos, x, y });
const GK = S("gk", "GK", "GK", 50, 91);

/** Attack at the top: y is the share of the pitch's height from the top. */
export const FORMATIONS: Record<FormationId, Slot[]> = {
  "4-3-3": [GK, S("lb", "LB", "DEF", 13, 70), S("lcb", "CB", "DEF", 37, 75), S("rcb", "CB", "DEF", 63, 75), S("rb", "RB", "DEF", 87, 70),
    S("lcm", "CM", "MID", 26, 49), S("cm", "CM", "MID", 50, 53), S("rcm", "CM", "MID", 74, 49), S("lw", "LW", "FWD", 17, 23), S("st", "ST", "FWD", 50, 16), S("rw", "RW", "FWD", 83, 23)],
  "4-4-2": [GK, S("lb", "LB", "DEF", 13, 70), S("lcb", "CB", "DEF", 37, 75), S("rcb", "CB", "DEF", 63, 75), S("rb", "RB", "DEF", 87, 70),
    S("lm", "LM", "MID", 13, 45), S("lcm", "CM", "MID", 37, 50), S("rcm", "CM", "MID", 63, 50), S("rm", "RM", "MID", 87, 45), S("lst", "ST", "FWD", 36, 18), S("rst", "ST", "FWD", 64, 18)],
  "4-2-3-1": [GK, S("lb", "LB", "DEF", 13, 71), S("lcb", "CB", "DEF", 37, 76), S("rcb", "CB", "DEF", 63, 76), S("rb", "RB", "DEF", 87, 71),
    S("ldm", "DM", "MID", 36, 56), S("rdm", "DM", "MID", 64, 56), S("lam", "LW", "FWD", 15, 32), S("cam", "AM", "MID", 50, 36), S("ram", "RW", "FWD", 85, 32), S("st", "ST", "FWD", 50, 14)],
  "3-5-2": [GK, S("lcb", "CB", "DEF", 25, 71), S("cb", "CB", "DEF", 50, 71), S("rcb", "CB", "DEF", 75, 71),
    S("lwb", "LWB", "MID", 10, 47), S("lcm", "CM", "MID", 32, 52), S("cm", "CM", "MID", 50, 44), S("rcm", "CM", "MID", 68, 52), S("rwb", "RWB", "MID", 90, 47), S("lst", "ST", "FWD", 37, 17), S("rst", "ST", "FWD", 63, 17)],
};

export const XI = 11;
/** The bench (rules v2): three places anyone can take, goalkeepers too. They play when someone in the XI is out. */
export const BENCH: Slot[] = [S("b1", "SUB", "MID", 30, 100), S("b2", "SUB", "MID", 50, 100), S("b3", "SUB", "MID", 70, 100)];
export const isBench = (slot: Slot) => slot.label === "SUB";
export const FREE_RESPINS = 2;
export const RESPIN_COST = 25;
export const PICK_SECONDS = 15;
/** Rooms of four or more pick faster, or the longest room would run past a quarter of an hour on clocks alone. */
export const PICK_SECONDS_BIG_ROOM = 10;
export const pickSeconds = (seats: number) => (seats >= 4 ? PICK_SECONDS_BIG_ROOM : PICK_SECONDS);
/** An empty slot plays as a youth player; a pick out of position loses this much. */
export const ACADEMY_RATING = 50;
export const OFF_POSITION_PENALTY = 4;
export const LEGEND_BONUS = 5;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

// ── Seeded randomness (same seed → same draft, same season) ────────────────────────────────────────────────────────

export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export function rng(seed: number | string): () => number {
  let a = typeof seed === "string" ? hashSeed(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Transfer budget: better players cost more, so the highest rating is not always the right signing ───────────────

export const BUDGET = { total: 300, legendsTotal: 250, base: 2, growth: 0.122, starFrom: 80, starGrowth: 0.085, swing: 0.2 };
/** Legends carry a bonus and the rivals do not, so the same money would buy too much. */
export const budgetFor = (era: Era) => (era === "legends" ? BUDGET.legendsTotal : BUDGET.total);
/**
 * The price climbs faster than the reputation, more gently above 80 so a star can be worth buying, and differs a little
 * per player, so bargains exist. Same player, same price, for everyone. Without a reputation the rating stands in.
 */
export function priceOf(player: DraftPlayer): number {
  const rating = Math.max(60, player.reputation ?? player.rating);
  const base = BUDGET.base * Math.exp(BUDGET.growth * (Math.min(rating, BUDGET.starFrom) - 60) + BUDGET.starGrowth * Math.max(0, rating - BUDGET.starFrom));
  const swing = 1 + BUDGET.swing * (2 * rng(`price|${player.id}`)() - 1);
  return Math.max(1, Math.round(base * swing));
}
export const spentOn = (picks: (Pick | null)[]) => picks.reduce((a, p) => a + (p?.price ?? 0), 0);
/** What is left, how many places are still open, and what that comes to per place. An academy kid is always free, so all of it can be spent. */
export function wallet(picks: (Pick | null)[], total: number = BUDGET.total): { left: number; open: number; each: number } {
  const left = total - spentOn(picks);
  const open = picks.filter((p) => !p).length;
  return { left, open, each: open ? Math.floor(left / open) : left };
}

// ── Ratings from a real season ──────────────────────────────────────────────────────────────────────────────────────

export interface RatingInput { pos: Pos; minutesShare: number; apps: number; goals: number; assists: number | null; cleanSheets: number; finish: number; teams: number; legend?: boolean }
export interface RatingWhy { base: number; minutes: number; club: number; output: number; legend: number; total: number }

/** Our own rating: what he did that season, not a video game's number. Every part is shown to the player ("why 86?"). */
export function rateSeason(i: RatingInput): RatingWhy {
  const per38 = i.apps > 0 ? 38 / Math.max(i.apps, 19) : 0;
  // No recorded assists is not the same as none: take what is usual for what he did, so old seasons are not marked down for missing data.
  const assists = i.assists ?? (i.pos === "FWD" ? i.goals * 0.45 : i.pos === "MID" ? Math.max(3, i.goals * 0.9) : i.pos === "DEF" ? 1.5 : 0);
  const out = i.pos === "FWD" ? i.goals * 0.75 + assists * 0.45
    : i.pos === "MID" ? i.goals * 0.8 + assists * 0.6 + i.cleanSheets * 0.25
    : i.pos === "DEF" ? i.cleanSheets * 0.5 + i.goals * 0.9 + assists * 0.5
    : i.cleanSheets * 0.6;
  const base = 52;
  const minutes = Math.round(14 * clamp01(i.minutesShare));
  const club = Math.round(8 * (1 - (i.finish - 1) / Math.max(1, i.teams - 1)));
  const output = Math.round(Math.min(24, out * per38));
  const legend = i.legend ? LEGEND_BONUS : 0;
  return { base, minutes, club, output, legend, total: Math.max(50, Math.min(97, base + minutes + club + output + legend)) };
}

// ── Placing a pick ─────────────────────────────────────────────────────────────────────────────────────────────────

const ROLE_FIT: Record<string, Partial<Record<Role, number>>> = {
  GK: { GK: 0 },
  CB: { CB: 0, DM: 2, LB: 2, RB: 2 },
  LB: { LB: 0, LM: 2, CB: 2, RB: 2, LW: 4, DM: 4 },
  RB: { RB: 0, RM: 2, CB: 2, LB: 2, RW: 4, DM: 4 },
  LWB: { LB: 0, LM: 0, LW: 2, RB: 2, RM: 2, CM: 4 },
  RWB: { RB: 0, RM: 0, RW: 2, LB: 2, LM: 2, CM: 4 },
  DM: { DM: 0, CM: 0, CB: 2, AM: 2 },
  CM: { CM: 0, DM: 0, AM: 0, LM: 2, RM: 2, SS: 4, CB: 4 },
  AM: { AM: 0, CM: 0, SS: 0, LW: 2, RW: 2, LM: 2, RM: 2, CF: 2, DM: 4 },
  LM: { LM: 0, LW: 0, LB: 2, RM: 2, RW: 2, CM: 2, AM: 2 },
  RM: { RM: 0, RW: 0, RB: 2, LM: 2, LW: 2, CM: 2, AM: 2 },
  LW: { LW: 0, LM: 0, RW: 2, RM: 2, SS: 2, CF: 2, AM: 2, LB: 4 },
  RW: { RW: 0, RM: 0, LW: 2, LM: 2, SS: 2, CF: 2, AM: 2, RB: 4 },
  ST: { CF: 0, SS: 0, LW: 2, RW: 2, AM: 4, LM: 4, RM: 4 },
};
/** What this player loses in this place: 0 natural, 2 close, 4 out of position; null when he cannot play there at all. */
export function fitPenalty(player: DraftPlayer, slot: Slot): number | null {
  if (slot.label === "SUB") return 0;
  if (slot.pos === "GK" || player.pos === "GK") return slot.pos === player.pos ? 0 : null;
  const known = player.role ? ROLE_FIT[slot.label]?.[player.role] : undefined;
  if (known !== undefined) return known;
  if (player.pos === slot.pos) return player.role ? OFF_POSITION_PENALTY : 0;
  return player.alt?.includes(slot.pos) ? OFF_POSITION_PENALTY : null;
}
export const fits = (player: DraftPlayer, slot: Slot) => fitPenalty(player, slot) !== null;

const personOf = (p: DraftPlayer) => p.personId ?? p.id;
export const inXi = (player: DraftPlayer, picks: (Pick | null)[]) => picks.some((p) => p && !p.academy && personOf(p.player) === personOf(player));

/** His open places, best fit first; the bench only after every place on the pitch he could take. */
export function openSlotsFor(player: DraftPlayer, slots: Slot[], picks: (Pick | null)[]): Slot[] {
  if (inXi(player, picks)) return [];
  const rank = (slot: Slot) => (slot.label === "SUB" ? 100 : fitPenalty(player, slot) ?? 9);
  return slots.filter((s, i) => !picks[i] && fits(player, s)).sort((a, b) => rank(a) - rank(b));
}

/** Where tapping this player would put him, and the rating he would play at there. */
export function destination(player: DraftPlayer, slots: Slot[], picks: (Pick | null)[], target?: string | null): { slot: Slot; rating: number; offPosition: boolean; penalty: number } | null {
  const open = openSlotsFor(player, slots, picks);
  const slot = open.find((x) => x.id === target) ?? open[0];
  if (!slot) return null;
  const penalty = fitPenalty(player, slot) ?? 0;
  return { slot, offPosition: penalty > 0, penalty, rating: player.rating - penalty };
}

/** Players of a squad that still fit one of my open slots (and nobody else took this round). */
export function pickable(squad: DraftPlayer[], slots: Slot[], picks: (Pick | null)[], taken: readonly string[] = []): DraftPlayer[] {
  return squad.filter((p) => !taken.includes(p.id) && openSlotsFor(p, slots, picks).length > 0);
}

export function place(picks: (Pick | null)[], slots: Slot[], slotId: string, player: DraftPlayer, from: ClubSeason): (Pick | null)[] {
  const i = slots.findIndex((s) => s.id === slotId);
  if (i < 0 || picks[i] || !fits(player, slots[i])) throw new Error("slot_not_open");
  const next = picks.slice();
  const penalty = fitPenalty(player, slots[i]) ?? 0;
  next[i] = { slotId, player, club: from.club, season: from.season, offPosition: penalty > 0, penalty };
  return next;
}

export const effective = (p: Pick | null) => (p ? p.player.rating - (p.penalty ?? (p.offPosition ? OFF_POSITION_PENALTY : 0)) : ACADEMY_RATING);

// ── Team strength ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Lines { gk: number; def: number; mid: number; att: number; overall: number }

/** What lifts an XI beyond its ratings (rules v2): points per place (captain, chemistry) and a tactic's shift of the lines. */
export interface Boost { perSlot?: readonly number[]; shift?: LineShift | null }
export interface LineShift { att: number; mid: number; def: number; gk: number }

/** The bench never counts here: only the eleven places on the pitch make the lines. */
export function lines(slots: Slot[], picks: (Pick | null)[], boost?: Boost): Lines {
  const avg = (pos: Pos) => {
    const r = slots.map((s, i) => (s.pos === pos && !isBench(s) ? effective(picks[i]) + (boost?.perSlot?.[i] ?? 0) : null)).filter((v): v is number => v !== null);
    return r.length ? r.reduce((a, b) => a + b, 0) / r.length : ACADEMY_RATING;
  };
  const shift = boost?.shift;
  const gk = avg("GK") + (shift?.gk ?? 0), def = avg("DEF") + (shift?.def ?? 0), mid = avg("MID") + (shift?.mid ?? 0), att = avg("FWD") + (shift?.att ?? 0);
  return { gk, def, mid, att, overall: round1(gk * 0.12 + def * 0.3 + mid * 0.28 + att * 0.3) };
}

// ── A match ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LineStrengths = Omit<Lines, "overall">;
export interface Opponent extends LineStrengths { id: string; name: string; strength: number }

/** Every line counts in both directions: midfield helps create and protect, the keeper only protects. */
const attackPower = (l: LineStrengths) => l.att * 0.65 + l.mid * 0.35;
const defencePower = (l: LineStrengths) => l.def * 0.6 + l.gk * 0.25 + l.mid * 0.15;

/** One fixture's luck. It comes from the seed and the fixture only, so swapping a player can never change a team's luck. */
export interface FixtureLuck { mine: number; theirs: number; swing: number }
export function fixtureLuck(seed: string, fixture: number | string): FixtureLuck {
  const r = rng(`${seed}|fixture|${fixture}`);
  const u = 2 * r() - 1;
  return { mine: r() - 0.5, theirs: r() - 0.5, swing: u * u * u * SIM.swing };
}

/** Calibrated on the real squads: see the numbers in the project notes before changing any of these. */
export const SIM = { swing: 7, noise: 1, edge: 0.22, lowEdge: 0.15, cap: 3.6, home: 1.5 };

/** A league side's goals at level strength; a head-to-head between two players starts both sides equal. */
const LEAGUE_BASES = [1.35, 1.15] as const;
/** A tie's legs: closer to a real scoreline than a league game against a weaker side. */
const TIE_GOALS = { base: 1.1, cap: 2.5 };

/** Expected goals from an edge in rating points: steep around level, flattening out so an elite side wins 3–0, not 7–0. */
function expectedGoals(base: number, edge: number, cap: number = SIM.cap): number {
  if (edge <= 0) return base * Math.exp((SIM.lowEdge * edge) / base);
  const room = cap - base;
  return base + room * (1 - Math.exp((-SIM.edge * edge) / room));
}

/** Goals never fall as a side's own lines rise, and conceded never rise: a better player cannot make a result worse. */
export function playMatch(me: LineStrengths, them: LineStrengths, luck: FixtureLuck, home: number, bases: readonly [number, number] = LEAGUE_BASES): { gf: number; ga: number } {
  const edgeFor = attackPower(me) - defencePower(them) + home + luck.swing;
  const edgeAgainst = attackPower(them) - defencePower(me) - home - luck.swing;
  return {
    gf: Math.max(0, Math.round(expectedGoals(bases[0], edgeFor) + luck.mine * SIM.noise)),
    ga: Math.max(0, Math.round(expectedGoals(bases[1], edgeAgainst) + luck.theirs * SIM.noise)),
  };
}

// ── The season ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type Line = "att" | "mid" | "def" | "gk";
/**
 * Why a game was lost, found by re-playing it: `day` it would not have been lost with neutral luck; `line` that line, a few
 * points better, would have saved it; `outclassed` nothing short of a better team would have.
 */
export type LossReason = { kind: "day" } | { kind: "line"; line: Line; mine: number; theirs: number } | { kind: "outclassed" };
export interface MatchResult { round: number; opponent: Opponent; home: boolean; gf: number; ga: number; reason: LossReason | null }
export type Finish = "perfect" | "champions" | "europe" | "mid" | "relegation";
/** The player who cost most, measured: the same season re-played with a team-level player in his place. */
export interface WeakLink { slot: string; name: string; rating: number; academy: boolean; pointsLost: number }
/** One line of the final table. Rivals really play each other, on the seed's luck, and their games against you count. */
export interface TableRow { id: string; name: string; me: boolean; p: number; w: number; d: number; l: number; gf: number; ga: number; points: number }
/** The title race after each round: your place, and how far behind the leader you are (or ahead of second). */
export interface RaceStep { position: number; gap: number; leader: string }
export interface SeasonResult { w: number; d: number; l: number; gf: number; ga: number; points: number; position: number; teams: number; games: number; finish: Finish; matches: MatchResult[]; weak: WeakLink | null; table: TableRow[]; race: RaceStep[] }

const LINE_FIXES = [2, 4, 6, 8];
function whyLost(me: Lines, opp: Opponent, luck: FixtureLuck, home: number): LossReason {
  const lost = (l: LineStrengths, k: FixtureLuck) => { const m = playMatch(l, opp, k, home); return m.gf < m.ga; };
  if (!lost(me, { mine: 0, theirs: 0, swing: 0 })) return { kind: "day" };
  for (const lift of LINE_FIXES) {
    const saving = (["att", "mid", "def", "gk"] as const).filter((line) => !lost({ ...me, [line]: me[line] + lift }, luck));
    if (saving.length) {
      const facing = (line: Line) => (line === "att" ? opp.def : line === "mid" ? opp.mid : opp.att);
      const line = saving.reduce((a, b) => (facing(b) - me[b] > facing(a) - me[a] ? b : a));
      return { kind: "line", line, mine: Math.round(me[line]), theirs: Math.round(facing(line)) };
    }
  }
  return { kind: "outclassed" };
}

/** A real calendar: every team once a round, home and away mostly alternating, and the reverse fixtures in the second half. Team 0 is you. */
function calendar(rivals: number, seed: string): [number, number][][] {
  const ids = Array.from({ length: rivals + 1 }, (_, i) => i);
  const draw = rng(`${seed}|calendar`);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(draw() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const ring = ids.length % 2 ? [...ids, -1] : ids;
  const n = ring.length;
  const first: [number, number][][] = [];
  for (let round = 0; round < n - 1; round++) {
    const games: [number, number][] = [];
    const at = (k: number) => (k === 0 ? ring[0] : ring[((k - 1 + round) % (n - 1)) + 1]);
    for (let k = 0; k < n / 2; k++) {
      const a = at(k), b = at(n - 1 - k);
      if (a < 0 || b < 0) continue;
      games.push((k === 0 ? round % 2 === 0 : k % 2 === 1) ? [a, b] : [b, a]);
    }
    first.push(games);
  }
  return [...first, ...first.map((g) => g.map(([a, b]): [number, number] => [b, a]))];
}

/** `team`: the same lines all season, or the lines of each round (a season with absences and a January window). */
function fixtures(team: Lines | ((round: number) => Lines), opponents: Opponent[], seed: string, explain = true, luckSeed = seed): MatchResult[] {
  const teamOf = typeof team === "function" ? team : () => team;
  const out: MatchResult[] = [];
  calendar(opponents.length, seed).forEach((games) => {
    const mine = games.find(([h, a]) => h === 0 || a === 0);
    if (!mine) return;
    const round = out.length + 1;
    const home = mine[0] === 0;
    const opp = opponents[(home ? mine[1] : mine[0]) - 1];
    const luck = fixtureLuck(luckSeed, round);
    const edge = home ? SIM.home : -SIM.home;
    const mineNow = teamOf(round);
    const { gf, ga } = playMatch(mineNow, opp, luck, edge);
    out.push({ round, opponent: opp, home, gf, ga, reason: explain && gf < ga ? whyLost(mineNow, opp, luck, edge) : null });
  });
  return out;
}

const RIVAL_EDGE = 0.6;
/** Rival against rival: natural goals around the expected number, so the table has real ups and downs. */
function rivalGame(h: Opponent, a: Opponent, seed: string): [number, number] {
  const r = rng(`${seed}|h${h.id}|a${a.id}`);
  const u = 2 * r() - 1;
  const swing = u * u * u * SIM.swing + SIM.home;
  // A league is closer than a rival's best XI suggests: its top side does not win 100 points every year.
  const edge = (attack: number, defence: number) => (attack - defence) * RIVAL_EDGE;
  return [naturalGoals(expectedGoals(LEAGUE_BASES[0], edge(attackPower(h), defencePower(a)) + swing), r()), naturalGoals(expectedGoals(LEAGUE_BASES[1], edge(attackPower(a), defencePower(h)) - swing), r())];
}

/** The whole league on one seed. Rival games depend on the seed alone, so everyone on the same draw sees the same rivals' results. */
function leagueTable(matches: MatchResult[], opponents: Opponent[], seed: string, withRace: boolean, rivalCache?: Map<string, [number, number]>): { table: TableRow[]; race: RaceStep[] } {
  const rows: TableRow[] = [{ id: "me", name: "", me: true, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, points: 0 }, ...opponents.map((o) => ({ id: o.id, name: o.name, me: false, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, points: 0 }))];
  const score = (row: TableRow, gf: number, ga: number) => { row.p++; row.gf += gf; row.ga += ga; if (gf > ga) { row.w++; row.points += 3; } else if (gf === ga) { row.d++; row.points++; } else row.l++; };
  const sorted = () => rows.slice().sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf);
  const race: RaceStep[] = [];
  let played = 0;
  for (const games of calendar(opponents.length, seed)) {
    const before = played;
    for (const [h, a] of games) {
      if (h === 0 || a === 0) {
        const m = matches[played++];
        score(rows[0], m.gf, m.ga);
        score(rows[h === 0 ? a : h], m.ga, m.gf);
      } else {
        const key = `${h}|${a}`;
        const known = rivalCache?.get(key);
        const [gh, ga] = known ?? rivalGame(opponents[h - 1], opponents[a - 1], seed);
        if (rivalCache && !known) rivalCache.set(key, [gh, ga]);
        score(rows[h], gh, ga);
        score(rows[a], ga, gh);
      }
    }
    if (withRace && played > before) {
      const now = sorted();
      const position = now.findIndex((r) => r.me) + 1;
      race.push({ position, gap: position === 1 ? rows[0].points - now[1].points : now[0].points - rows[0].points, leader: position === 1 ? now[1].name : now[0].name });
    }
  }
  return { table: sorted(), race };
}

const finishOf = (l: number, d: number, position: number, teams: number): Finish => (l === 0 && d === 0 ? "perfect" : position === 1 ? "champions" : position <= 6 ? "europe" : position > teams - 3 ? "relegation" : "mid");

const pointsOf = (matches: MatchResult[]) => matches.reduce((a, m) => a + (m.gf > m.ga ? 3 : m.gf === m.ga ? 1 : 0), 0);

function findWeakLink(slots: Slot[], picks: (Pick | null)[], opponents: Opponent[], seed: string, points: number, boost?: Boost): WeakLink | null {
  const level = Math.round(lines(slots, picks).overall);
  let worst: WeakLink | null = null;
  slots.forEach((slot, i) => {
    const p = picks[i];
    const rating = effective(p);
    if (rating >= level) return;
    const swap = picks.slice();
    swap[i] = { slotId: slot.id, club: "", season: "", offPosition: false, player: { id: "x", name: "", pos: slot.pos, rating: level, apps: 0, goals: 0, assists: 0, cleanSheets: 0, minutesShare: 0 } };
    const pointsLost = pointsOf(fixtures(lines(slots, swap, boost), opponents, seed)) - points;
    if (pointsLost > 0 && (!worst || pointsLost > worst.pointsLost || (pointsLost === worst.pointsLost && rating < worst.rating))) {
      worst = { slot: slot.label, name: p?.academy ? "" : p?.player.name ?? "", rating, academy: !p || !!p.academy, pointsLost };
    }
  });
  return worst;
}

export function playSeason(slots: Slot[], picks: (Pick | null)[], league: League, opponents: Opponent[], seed: string): SeasonResult {
  const leagueSeed = `${seed}|${league.id}`;
  const matches = fixtures(lines(slots, picks), opponents, leagueSeed);
  const w = matches.filter((m) => m.gf > m.ga).length;
  const d = matches.filter((m) => m.gf === m.ga).length;
  const l = matches.length - w - d;
  const points = w * 3 + d;
  const gf = matches.reduce((a, m) => a + m.gf, 0), ga = matches.reduce((a, m) => a + m.ga, 0);
  const { table, race } = leagueTable(matches, opponents, leagueSeed, true);
  const position = table.findIndex((r) => r.me) + 1;
  const finish = finishOf(l, d, position, opponents.length + 1);
  const weak = finish === "perfect" ? null : findWeakLink(slots, picks, opponents, leagueSeed, points);
  return { w, d, l, gf, ga, points, position, teams: league.teams, games: league.games, finish, matches, weak, table, race };
}

/** Before a ball is kicked: this XI's season played many times on other luck. Its own stream, so it can never change the real season. */
export interface Prediction { points: number; position: number; titlePct: number }
const FORECAST_LEAGUES = 5;
export function predictSeason(slots: Slot[], picks: (Pick | null)[], league: League, opponents: Opponent[], seed: string, tries = 30): Prediction {
  const team = lines(slots, picks);
  let points = 0, position = 0, titles = 0;
  // A few rival leagues, many seasons of mine against them: the rivals' games are the costly part, and they do not need redoing.
  const leagues = Array.from({ length: FORECAST_LEAGUES }, () => new Map<string, [number, number]>());
  for (let k = 0; k < tries; k++) {
    const which = k % FORECAST_LEAGUES;
    const s = `${seed}|${league.id}|forecast|${which}`;
    const matches = fixtures(team, opponents, s, false, `${s}|${k}`);
    const { table } = leagueTable(matches, opponents, s, false, leagues[which]);
    const at = table.findIndex((r) => r.me) + 1;
    points += table[at - 1].points; position += at;
    if (at === 1) titles++;
  }
  return { points: Math.round(points / tries), position: Math.round(position / tries), titlePct: Math.round((100 * titles) / tries) };
}

// ── Match day (duel) ───────────────────────────────────────────────────────────────────────────────────────────────

export interface Battle { key: "attack" | "midfield" | "defence"; mine: number; theirs: number; winner: 0 | 1 | null }
/** One goal as the season view shows it. Drawn after the result and on its own stream, so it can never change a score. */
export interface MatchGoal { minute: number; mine: boolean; slotId: string | null; assistSlotId?: string | null }
const SCORER_WEIGHT: Record<Pos, number> = { GK: 0, DEF: 0.12, MID: 0.45, FWD: 1 };
export function matchGoals(seed: string, m: { round: number; gf: number; ga: number }, slots: Slot[], picks: (Pick | null)[]): MatchGoal[] {
  const r = rng(`${seed}|goals|${m.round}`);
  const taken = new Set<number>();
  const minute = () => { let v: number; do { v = 1 + Math.floor(r() * 90); } while (taken.has(v)); taken.add(v); return v; };
  const weights = slots.map((slot, i) => {
    const p = picks[i];
    if (!p || slot.pos === "GK" || isBench(slot)) return 0;
    const base = SCORER_WEIGHT[slot.pos] + (2 * p.player.goals) / Math.max(p.player.apps, 1);
    return p.academy ? base * 0.5 : base;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const scorer = () => {
    let at = r() * total;
    for (let i = 0; i < weights.length; i++) { at -= weights[i]; if (weights[i] > 0 && at <= 0) return slots[i].id; }
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return slots[i].id;
    return null;
  };
  const goals: MatchGoal[] = [];
  const a = rng(`${seed}|assists|${m.round}`);
  const assister = (scoredBy: string | null) => {
    if (a() > 0.75) return null;
    const chances = slots.map((slot, i) => {
      const p = picks[i];
      if (!p || slot.pos === "GK" || isBench(slot) || slot.id === scoredBy) return 0;
      const made = (p.player.assists ?? (slot.pos === "MID" ? 5 : 2)) / Math.max(p.player.apps, 1);
      return (slot.pos === "MID" ? 0.5 : slot.pos === "FWD" ? 0.35 : 0.12) + 2 * made;
    });
    const sum = chances.reduce((x, y) => x + y, 0);
    let at = a() * sum;
    for (let i = 0; i < chances.length; i++) { at -= chances[i]; if (chances[i] > 0 && at <= 0) return slots[i].id; }
    return null;
  };
  for (let i = 0; i < m.gf; i++) { const by = scorer(); goals.push({ minute: minute(), mine: true, slotId: by, assistSlotId: assister(by) }); }
  for (let i = 0; i < m.ga; i++) goals.push({ minute: minute(), mine: false, slotId: null });
  return goals.sort((a, b) => a.minute - b.minute);
}

/** The XI's season in numbers: who scored, who made them, and the keeper's clean sheets. Worked out from the same goals the season showed. */
/** `name`: when the season fielded different players in one place, whose line this is. */
export interface PlayerLine { slotId: string; goals: number; assists: number; name?: string }
/** `keeper`: with lineups per round, the goalkeeper who kept the most clean sheets, and how many. */
export interface SeasonStats { players: PlayerLine[]; cleanSheets: number; topScorer: PlayerLine | null; topAssists: PlayerLine | null; keeper?: { name: string; cleanSheets: number; games: number } | null }
/** `picksOf`: who played each round (rules v2); without it, the same XI all season. Lines are per person when it is given. */
export function seasonStats(seed: string, season: { matches: { round: number; gf: number; ga: number }[] }, slots: Slot[], picks: (Pick | null)[], picksOf?: (round: number) => (Pick | null)[]): SeasonStats {
  const byId = new Map<string, PlayerLine>(picksOf ? [] : slots.map((s) => [s.id, { slotId: s.id, goals: 0, assists: 0 }]));
  const lineOf = (lineup: (Pick | null)[], slotId: string | null | undefined): PlayerLine | null => {
    if (!slotId) return null;
    if (!picksOf) return byId.get(slotId) ?? null;
    const p = lineup[slots.findIndex((s) => s.id === slotId)];
    const key = p && !p.academy ? `p:${p.player.personId ?? p.player.id}` : `a:${slotId}`;
    const known = byId.get(key);
    if (known) return known;
    const made = { slotId, goals: 0, assists: 0, name: p && !p.academy ? p.player.name : "" };
    byId.set(key, made);
    return made;
  };
  let cleanSheets = 0;
  const keepers = new Map<string, { name: string; cleanSheets: number; games: number }>();
  const gk = slots.findIndex((s) => s.pos === "GK" && s.label !== "SUB");
  for (const m of season.matches) {
    if (m.ga === 0) cleanSheets++;
    const lineup = picksOf ? picksOf(m.round) : picks;
    if (picksOf && gk >= 0) {
      // Every keeper who played, and each clean sheet to the one in goal that day.
      const k = lineup[gk];
      const key = k && !k.academy ? k.player.personId ?? k.player.id : "academy";
      const line = keepers.get(key) ?? { name: k && !k.academy ? k.player.name : "", cleanSheets: 0, games: 0 };
      line.games++;
      if (m.ga === 0) line.cleanSheets++;
      keepers.set(key, line);
    }
    for (const g of matchGoals(seed, m, slots, lineup)) {
      if (!g.mine) continue;
      const scorer = lineOf(lineup, g.slotId);
      if (scorer) scorer.goals++;
      const maker = lineOf(lineup, g.assistSlotId);
      if (maker) maker.assists++;
    }
  }
  const players = [...byId.values()];
  const most = (key: "goals" | "assists") => players.reduce<PlayerLine | null>((a, b) => (b[key] > (a?.[key] ?? 0) ? b : a), null);
  // The most clean sheets, then the most games: a keeper who never kept one still shows by name.
  const keeper = picksOf ? [...keepers.values()].reduce<{ name: string; cleanSheets: number; games: number } | null>((a, b) => (!a || b.cleanSheets > a.cleanSheets || (b.cleanSheets === a.cleanSheets && b.games > a.games) ? b : a), null) : undefined;
  return { players, cleanSheets, topScorer: most("goals"), topAssists: most("assists"), ...(keeper !== undefined ? { keeper } : {}) };
}

/** A head-to-head on screen: scorers on both sides, drawn after the result so they can never change it. */
export interface DayGoal { minute: number; side: 0 | 1; slotId: string | null }
/** `slotsB`: the second team's formation, when it was drafted in another shape. */
export function matchDayGoals(seed: string, goals: readonly [number, number], slots: Slot[], a: (Pick | null)[], b: (Pick | null)[], slotsB: Slot[] = slots): DayGoal[] {
  const mine = matchGoals(`${seed}|a`, { round: 0, gf: goals[0], ga: 0 }, slots, a).map((g) => ({ ...g, side: 0 as const }));
  const used = new Set(mine.map((g) => g.minute));
  const theirs = matchGoals(`${seed}|b`, { round: 0, gf: goals[1], ga: 0 }, slotsB, b).map((g) => { let minute = g.minute; while (used.has(minute)) minute = minute % 90 + 1; used.add(minute); return { ...g, minute, side: 1 as const }; });
  return [...mine, ...theirs].map(({ minute, side, slotId }) => ({ minute, side, slotId })).sort((x, y) => x.minute - y.minute);
}

/** How long one match stays on screen: about a second, longer while a perfect run is alive near the end. */
export const SEASON_PACE = { match: 1000, tense: 1600, tenseLast: 8, runEnded: 2000, end: 1500 };
export function matchMs(season: { games: number; matches: MatchResult[] }, index: number): number {
  const stillPerfect = season.matches.slice(0, index).every((m) => m.gf > m.ga);
  return stillPerfect && index >= season.games - SEASON_PACE.tenseLast ? SEASON_PACE.tense : SEASON_PACE.match;
}

export interface MatchDay { battles: Battle[];
  /** Each leg's score, first team's goals first: it is at home in the first leg. */
  legs: [[number, number], [number, number]];
  /** The total over both legs. */
  goals: [number, number]; penalties: [number, number] | null; winner: 0 | 1 }

/** A shootout: the better keeper has the edge, not a guarantee. */
function shootout(gkA: number, gkB: number, seed: string): [number, number] {
  const r = rng(`${seed}|pens`);
  const edge = Math.max(-0.2, Math.min(0.2, (gkA - gkB) * 0.012));
  const a = 0.75 + edge, b = 0.75 - edge;
  let sa = 0, sb = 0;
  for (let i = 0; i < 5; i++) { if (r() < a) sa++; if (r() < b) sb++; }
  for (let i = 0; i < 30 && sa === sb; i++) { if (r() < a) sa++; if (r() < b) sb++; }
  if (sa === sb) { if (gkA >= gkB) sa++; else sb++; }
  return [sa, sb];
}

/** Three line battles and a scoreline from the same match the league plays. A draw goes to penalties. */
/** Goals around the expected number, as in real football. The draw is fixed first, so more expected goals can never mean fewer goals. */
function naturalGoals(expected: number, draw: number): number {
  let goals = 0, chance = Math.exp(-expected), total = chance;
  while (draw > total && goals < 12) { goals++; chance *= expected / goals; total += chance; }
  return goals;
}

/** One leg of a tie: the first team at home in leg 0, the second team at home in leg 1. */
function playLeg(a: LineStrengths, b: LineStrengths, seed: string, leg: 0 | 1): [number, number] {
  const r = rng(`${seed}|leg|${leg}`);
  const u = 2 * r() - 1;
  const edge = (leg === 0 ? SIM.home : -SIM.home) + u * u * u * SIM.swing;
  return [
    naturalGoals(expectedGoals(TIE_GOALS.base, attackPower(a) - defencePower(b) + edge, TIE_GOALS.cap), r()),
    naturalGoals(expectedGoals(TIE_GOALS.base, attackPower(b) - defencePower(a) - edge, TIE_GOALS.cap), r()),
  ];
}

/** Team against team: two legs, home and away; the total decides, then penalties. Same two teams and seed, same tie. */
export function matchDay(a: Lines, b: Lines, seed: string): MatchDay {
  const win = (x: number, y: number): 0 | 1 | null => (Math.abs(x - y) < 0.5 ? null : x > y ? 0 : 1);
  const battles: Battle[] = [
    { key: "attack", mine: round1(attackPower(a)), theirs: round1(defencePower(b)), winner: win(attackPower(a), defencePower(b)) },
    { key: "midfield", mine: round1(a.mid), theirs: round1(b.mid), winner: win(a.mid, b.mid) },
    { key: "defence", mine: round1(defencePower(a)), theirs: round1(attackPower(b)), winner: win(defencePower(a), attackPower(b)) },
  ];
  const legs: [[number, number], [number, number]] = [playLeg(a, b, seed, 0), playLeg(a, b, seed, 1)];
  const goals: [number, number] = [legs[0][0] + legs[1][0], legs[0][1] + legs[1][1]];
  if (goals[0] !== goals[1]) return { battles, legs, goals, penalties: null, winner: goals[0] > goals[1] ? 0 : 1 };
  const penalties = shootout(a.gk, b.gk, seed);
  return { battles, legs, goals, penalties, winner: penalties[0] > penalties[1] ? 0 : 1 };
}

// ── Turns, rewards, ranking ────────────────────────────────────────────────────────────────────────────────────────

/** Each round starts one seat further on, so first choice goes round the table evenly (two players simply alternate). */
export function pickOrder(round: number, seats: number): number[] {
  return Array.from({ length: seats }, (_, i) => (round + i) % seats);
}

export function coinsFor(season: SeasonResult, variant: Variant): number {
  const base = season.finish === "perfect" ? 1000 : season.w >= 34 ? 150 : season.w >= 30 ? 50 : season.w >= 25 ? 15 : 0;
  const title = season.finish === "champions" ? 50 : 0;
  return Math.round((base + title) * (variant === "knowledge" ? 1.5 : 1));
}

/** Board order: points, then goal difference, then goals scored. */
export const rankKey = (s: SeasonResult) => s.points * 1_000_000 + (s.gf - s.ga + 500) * 1000 + s.gf;

/** One square per pick for the share text (green = 85+, yellow = 75+, white = below, black = academy). */
export function shareSquares(picks: (Pick | null)[]): string {
  return picks.map((p) => (!p || p.academy ? "⬛" : effective(p) >= 85 ? "🟩" : effective(p) >= 75 ? "🟨" : "⬜")).join("");
}

// ── Rules v2: chemistry, captain, tactics, the bench, moments, the January window, cups ─────────────────────────────

/** The version of the season rules a setup plays: 1 (or absent) as before, 2 with everything below. */
export const RULES_V2 = 2;

/** The captain plays above himself. */
export const CAPTAIN_BONUS = 4;
/** Each former teammate in the XI is worth a point, up to this many. */
export const CHEMISTRY_CAP = 3;

/** A manager's way of playing: it moves points between the lines. Every tactic adds up to the same, none is free. */
export const TACTICS = {
  gegenpress: { att: 3, mid: 1, def: -2, gk: 0 },
  catenaccio: { att: -2, mid: 0, def: 3, gk: 1 },
  tikitaka: { att: 0, mid: 3, def: -1, gk: 0 },
  counter: { att: 2, mid: -2, def: 2, gk: 0 },
  wingplay: { att: 2, mid: 1, def: -1, gk: 0 },
  parkbus: { att: -3, mid: 0, def: 3, gk: 2 },
} as const satisfies Record<string, LineShift>;
export type TacticId = keyof typeof TACTICS;
export const TACTIC_IDS = Object.keys(TACTICS) as TacticId[];

/** The three tactics on offer for a draw (the same three for everyone on that seed). */
export function offeredTactics(seed: string): TacticId[] {
  const r = rng(`${seed}|tactics`);
  const pool = TACTIC_IDS.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, 3);
}

/** Two players of the XI who once shared a dressing room: the club and season they played together. */
export interface ChemLink { a: string; b: string; club: string; season: string }
export type Together = (a: DraftPlayer, b: DraftPlayer) => { club: string; season: string } | null;

/** Former teammates in the eleven (never the bench, never academy kids): who links with whom, and each place's bonus. */
export function chemistry(slots: Slot[], picks: (Pick | null)[], together: Together): { links: ChemLink[]; perSlot: number[] } {
  const links: ChemLink[] = [];
  const count = slots.map(() => 0);
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = picks[i], b = picks[j];
      if (!a || !b || a.academy || b.academy || isBench(slots[i]) || isBench(slots[j])) continue;
      const met = together(a.player, b.player);
      if (!met) continue;
      links.push({ a: slots[i].id, b: slots[j].id, club: met.club, season: met.season });
      count[i]++; count[j]++;
    }
  }
  return { links, perSlot: count.map((n) => Math.min(CHEMISTRY_CAP, n)) };
}

/** Everything that lifts the XI: chemistry, the captain and the tactic. */
export function boostOf(slots: Slot[], picks: (Pick | null)[], together: Together | null, captain: string | null, tactic: TacticId | null): Boost & { links: ChemLink[] } {
  const chem = together ? chemistry(slots, picks, together) : { links: [], perSlot: slots.map(() => 0) };
  const perSlot = chem.perSlot.map((v, i) => v + (captain && slots[i].id === captain && picks[i] && !picks[i]!.academy ? CAPTAIN_BONUS : 0));
  return { perSlot, shift: tactic ? TACTICS[tactic] : null, links: chem.links };
}

/** Something that happens in a season: a player out (injury or red card), or a derby. Drawn from the seed, never the XI. */
export interface Moment { round: number; kind: "injury" | "red" | "derby"; slotId?: string; weeks?: number; rival?: string }

export function momentsOf(seed: string, slots: Slot[], games: number, opponents: Opponent[]): Moment[] {
  const r = rng(`${seed}|moments`);
  const xi = slots.filter((s) => !isBench(s));
  // An outfield player far more often than the keeper.
  const who = () => { const outfield = xi.filter((s) => s.pos !== "GK"); return r() < 0.06 ? xi.find((s) => s.pos === "GK")!.id : outfield[Math.floor(r() * outfield.length)].id; };
  const out: Moment[] = [];
  const injuries = 1 + Math.floor(r() * 3);
  for (let i = 0; i < injuries; i++) out.push({ round: 2 + Math.floor(r() * (games - 4)), kind: "injury", slotId: who(), weeks: 1 + Math.floor(Math.pow(r(), 1.5) * 6) });
  const reds = Math.floor(r() * 3);
  for (let i = 0; i < reds; i++) out.push({ round: 2 + Math.floor(r() * (games - 3)), kind: "red", slotId: who(), weeks: 1 });
  // The derby: one of the strongest sides, both meetings.
  const strong = opponents.slice().sort((a, b) => b.strength - a.strength).slice(0, 6);
  if (strong.length) out.push({ round: 0, kind: "derby", rival: strong[Math.floor(r() * strong.length)].id });
  return out.sort((a, b) => a.round - b.round);
}

/** Who is out in a round: slot ids. */
export function absentIn(round: number, moments: readonly Moment[]): Set<string> {
  const out = new Set<string>();
  for (const m of moments) if (m.slotId && m.kind !== "derby" && round >= m.round && round < m.round + (m.weeks ?? 1)) out.add(m.slotId);
  return out;
}

/** A side for one round: whoever is out is covered by the best-fitting bench player, else an academy kid. */
export function lineupFor(slots: Slot[], picks: (Pick | null)[], bench: (Pick | null)[], out: ReadonlySet<string>): { picks: (Pick | null)[]; covers: Record<string, string | null> } {
  const used = new Set<number>();
  const covers: Record<string, string | null> = {};
  const next = picks.slice();
  slots.forEach((slot, i) => {
    if (!out.has(slot.id)) return;
    let best = -1, bestRating = -1, bestPenalty = 0;
    bench.forEach((b, k) => {
      if (!b || b.academy || used.has(k)) return;
      const penalty = fitPenalty(b.player, slot);
      if (penalty === null) return;
      if (b.player.rating - penalty > bestRating) { best = k; bestRating = b.player.rating - penalty; bestPenalty = penalty; }
    });
    if (best >= 0 && bestRating > ACADEMY_RATING) {
      used.add(best);
      const b = bench[best]!;
      next[i] = { ...b, slotId: slot.id, penalty: bestPenalty, offPosition: bestPenalty > 0 };
      covers[slot.id] = b.player.name;
    } else {
      next[i] = { slotId: slot.id, club: "", season: "", offPosition: false, academy: true, player: { id: `cover-${slot.id}`, name: "", pos: slot.pos, rating: ACADEMY_RATING, apps: 0, goals: 0, assists: 0, cleanSheets: 0, minutesShare: 0 } };
      covers[slot.id] = null;
    }
  });
  return { picks: next, covers };
}

/** One half of a season's squad: the XI, the bench and what lifts them. */
export interface SquadHalf { picks: (Pick | null)[]; bench: (Pick | null)[]; boost: Boost }
/** A whole season on rules v2: absences covered from the bench, and a second half that may differ (the January window). */
export interface SeasonPlan { slots: Slot[]; first: SquadHalf; second?: SquadHalf; half: number; moments: Moment[] }

const samePerson = (a: Pick | null, b: Pick | null) => !!a && !!b && !a.academy && !b.academy && (a.player.personId ?? a.player.id) === (b.player.personId ?? b.player.id);

/** The lines of each round. A player sold in January takes his absence with him. */
/**
 * Who is out in a round of a plan. A player sold in January takes his absence with him; an absence that starts in the
 * second half belongs to whoever holds the place then.
 */
export function outIn(plan: Pick2<SeasonPlan, "slots" | "first" | "second" | "half" | "moments">, round: number): Set<string> {
  const second = round > plan.half && plan.second ? plan.second : null;
  const out = new Set<string>();
  for (const m of plan.moments) {
    if (!m.slotId || m.kind === "derby" || round < m.round || round >= m.round + (m.weeks ?? 1)) continue;
    if (second && m.round <= plan.half) {
      const i = plan.slots.findIndex((s) => s.id === m.slotId);
      if (!samePerson(plan.first.picks[i], second.picks[i])) continue;
    }
    out.add(m.slotId);
  }
  return out;
}
type Pick2<T, K extends keyof T> = { [P in K]: T[P] };

/** Who played each round: the half's squad, absences covered from its bench (the same for the season, its goals and awards). */
export function roundPicks(plan: Pick2<SeasonPlan, "slots" | "first" | "second" | "half" | "moments">): (round: number) => { picks: (Pick | null)[]; out: Set<string>; squad: SquadHalf } {
  const cache = new Map<string, { picks: (Pick | null)[]; out: Set<string>; squad: SquadHalf }>();
  return (round) => {
    const squad = round > plan.half && plan.second ? plan.second : plan.first;
    const out = outIn(plan, round);
    const key = `${squad === plan.first ? 1 : 2}|${[...out].sort().join(",")}`;
    const known = cache.get(key);
    if (known) return known;
    const made = { picks: lineupFor(plan.slots, squad.picks, squad.bench, out).picks, out, squad };
    cache.set(key, made);
    return made;
  };
}

/** The lines of each round. */
export function roundLines(plan: SeasonPlan): (round: number) => Lines {
  const who = roundPicks(plan);
  const cache = new Map<(Pick | null)[], Lines>();
  return (round) => {
    const { picks, out, squad } = who(round);
    const known = cache.get(picks);
    if (known) return known;
    const perSlot = (squad.boost.perSlot ?? []).map((v, i) => (out.has(plan.slots[i].id) ? 0 : v));
    const l = lines(plan.slots, picks, { perSlot, shift: squad.boost.shift });
    cache.set(picks, l);
    return l;
  };
}

/** A moment as shown: who (empty for an academy kid, whom nobody announces) and who stepped in. Every absence is kept: the lineups need them all. */
export interface MomentView extends Moment { name?: string; cover?: string | null }

/** The season on rules v2. Same luck and rivals as ever: only who plays each round changes. */
export function playSeasonPlan(plan: SeasonPlan, league: League, opponents: Opponent[], seed: string): SeasonResult & { moments: MomentView[]; derby: string | null } {
  const leagueSeed = `${seed}|${league.id}`;
  const teamOf = roundLines(plan);
  const matches = fixtures(teamOf, opponents, leagueSeed);
  const w = matches.filter((m) => m.gf > m.ga).length;
  const d = matches.filter((m) => m.gf === m.ga).length;
  const l = matches.length - w - d;
  const points = w * 3 + d;
  const gf = matches.reduce((a, m) => a + m.gf, 0), ga = matches.reduce((a, m) => a + m.ga, 0);
  const { table, race } = leagueTable(matches, opponents, leagueSeed, true);
  const position = table.findIndex((r) => r.me) + 1;
  const finish = finishOf(l, d, position, opponents.length + 1);
  const end = plan.second ?? plan.first;
  const weak = finish === "perfect" ? null : findWeakLink(plan.slots, end.picks, opponents, leagueSeed, pointsOf(fixtures(lines(plan.slots, end.picks, end.boost), opponents, leagueSeed)), end.boost);
  const derby = plan.moments.find((m) => m.kind === "derby")?.rival ?? null;
  const moments: MomentView[] = plan.moments.filter((m) => m.kind !== "derby").map((m) => {
    const squad = m.round > plan.half && plan.second ? plan.second : plan.first;
    const i = plan.slots.findIndex((s) => s.id === m.slotId);
    const p = squad.picks[i];
    // Covered as the season really did it: with everyone out that week, each sub only once.
    const cover = lineupFor(plan.slots, squad.picks, squad.bench, outIn(plan, m.round)).covers[m.slotId!];
    return { ...m, name: p && !p.academy ? p.player.name : "", cover };
  });
  return { w, d, l, gf, ga, points, position, teams: league.teams, games: league.games, finish, matches, weak, table, race, moments, derby };
}

// ── Cups after the league ──────────────────────────────────────────────────────────────────────────────────────────

export interface CupMatch { stage: number; opponent: string; gf: number; ga: number; pens: [number, number] | null; won: boolean }
export interface CupRun { kind: "cup" | "europe"; stages: number; matches: CupMatch[]; won: boolean }
export const CUP_STAGES = 5;
export const EUROPE_STAGES = 4;
export const EUROPE_PLACES = 4;

/** A knockout on neutral ground, one match a round, penalties on a draw; the field gets stronger as it goes. */
export function playCup(kind: CupRun["kind"], team: Lines, field: Opponent[], seed: string, stages: number): CupRun {
  const r = rng(`${seed}|${kind}|draw`);
  const pool = field.slice();
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  // The draw: weaker sides early, the strongest saved for the end (one from each slice of the field, weakest slice first).
  const byStrength = pool.slice().sort((a, b) => a.strength - b.strength);
  const ladder = Array.from({ length: Math.min(stages, byStrength.length) }, (_, s) => {
    const from = Math.floor((s * byStrength.length) / stages), to = Math.max(from + 1, Math.floor(((s + 1) * byStrength.length) / stages));
    return byStrength[from + Math.floor(r() * (to - from))];
  });
  const matches: CupMatch[] = [];
  for (let stage = 0; stage < ladder.length; stage++) {
    const opp = ladder[stage];
    const m = rng(`${seed}|${kind}|${stage}`);
    const u = 2 * m() - 1;
    // At home in the early rounds; from the quarter-finals on, neutral ground.
    const edge = u * u * u * SIM.swing + (stage < ladder.length - 3 ? SIM.home : 0);
    const gf = naturalGoals(expectedGoals(TIE_GOALS.base, attackPower(team) - defencePower(opp) + edge, TIE_GOALS.cap), m());
    const ga = naturalGoals(expectedGoals(TIE_GOALS.base, attackPower(opp) - defencePower(team) - edge, TIE_GOALS.cap), m());
    const pens = gf === ga ? shootout(team.gk, opp.gk, `${seed}|${kind}|${stage}`) : null;
    const won = gf > ga || (!!pens && pens[0] > pens[1]);
    matches.push({ stage, opponent: opp.name, gf, ga, pens, won });
    if (!won) break;
  }
  // No field, no cup: nobody wins a tournament without playing it.
  return { kind, stages: ladder.length, matches, won: ladder.length > 0 && matches.length === ladder.length && matches.every((x) => x.won) };
}

/** Coins on rules v2: the league table as before, and more for cups: a treble pays the most. */
export const CUP_COINS = { cup: 40, europe: 150, treble: 250 };
export function cupCoins(season: SeasonResult, cup: CupRun | null, europe: CupRun | null): number {
  const champions = season.finish === "champions" || season.finish === "perfect";
  return (cup?.won ? CUP_COINS.cup : 0) + (europe?.won ? CUP_COINS.europe : 0) + (champions && cup?.won && europe?.won ? CUP_COINS.treble : 0);
}
