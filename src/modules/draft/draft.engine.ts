import type { AvatarCustomization } from "../users/avatar-customization.js";
import {
  wallet, priceOf, FORMATIONS, budgetFor, FREE_RESPINS, RESPIN_COST, XI, coinsFor, destination, lines, matchDay, openSlotsFor, pickOrder, pickable, place, playSeason, rng,
  type ClubSeason, type DraftPlayer, type Era, type FormationId, type League, type MatchDay, type Opponent, type Pick, type SeasonResult, type Variant,
} from "./draft.rules.js";

/**
 * The prototype's draft engine: a pure reducer over one draft (solo, duel or room), run on this device with bots. The
 * real game moves this to the server (it deals the spins and judges the picks); the screens only read `DraftState`.
 */
export interface DraftUniverse {
  leagues: League[];
  spin: (leagueId: string, era: Era, seed: string, used: readonly string[]) => ClubSeason;
  /** Another club of this era, in the same season where we have one so the season reel stays put; null if there is none. */
  otherClub: (current: ClubSeason, era: Era, seed: string, used: readonly string[]) => ClubSeason | null;
  /** The same club in another season of this era, or null if we have no other. */
  otherSeason: (club: ClubSeason, era: Era, seed: string) => ClubSeason | null;
  opponents: (leagueId: string, seed: string) => Opponent[];
}

/** `challenge`: a friend's exact draw, played whenever you like, against their record. */
export type DraftMode = "daily" | "free" | "duel" | "room" | "challenge";
export interface DraftSeat { name: string; avatar: AvatarCustomization | null; bot: boolean; picks: (Pick | null)[] }
export type DraftPhase = "spinning" | "picking" | "ready" | "season" | "result";

export interface DraftState {
  mode: DraftMode;
  variant: Variant;
  leagueId: string;
  era: Era;
  formation: FormationId;
  seed: string;
  seats: DraftSeat[];
  round: number;
  /** Index into this round's picking order. */
  turn: number;
  /** Who picks first in round one, drawn from the seed: with an odd number of rounds, always the same seat would be an edge. */
  firstSeat: number;
  spin: ClubSeason;
  /** The eleven spins of this seed, fixed up front: everyone on the same seed gets the same draw whatever they pick or re-spin. */
  deal: ClubSeason[];
  spinCount: number;
  usedClubs: string[];
  /** Players taken this round (duel/room): gone for everyone after. */
  taken: { playerId: string; seat: number }[];
  respins: number;
  respinsUsed: number;
  /** A Transfer budget draft's money, in millions: each seat has this much. */
  budget: number;
  /** Every signing in order: the live feed in a duel or room. */
  feed: { seat: number; name: string; club: string; season: string }[];
  coins: number;
  phase: DraftPhase;
  seasons: SeasonResult[] | null;
  match: MatchDay | null;
  coinsEarned: number;
  notice: "respin_free" | "no_fit" | "no_coins" | "academy" | "no_other_season" | "no_money" | null;
}

/** What a "Beat my draft" link carries: the exact draw, as many re-spins as the challenger used, the record to beat and their XI (shown only once the friend has played). */
export interface ChallengeTarget { from: string; seed: string; leagueId: string; era: Era; formation: FormationId; variant: Variant; respins: number; w: number; d: number; l: number; points: number; gf: number; ga: number; picks: (Pick | null)[] }

export interface NewDraft { mode: DraftMode; variant: Variant; leagueId: string; era: Era; formation: FormationId; seed: string; seats: Omit<DraftSeat, "picks">[]; coins?: number; respins?: number }

export function newDraft(u: DraftUniverse, o: NewDraft): DraftState {
  const deal: ClubSeason[] = [];
  for (let round = 0; round < XI; round++) deal.push(u.spin(o.leagueId, o.era, `${o.seed}|deal|${round}`, deal.map((c) => c.clubId)));
  return {
    ...o, seats: o.seats.map((s) => ({ ...s, picks: Array(XI).fill(null) })), round: 0, turn: 0, firstSeat: Math.floor(rng(`${o.seed}|first`)() * o.seats.length), spin: deal[0], deal, spinCount: 0, usedClubs: deal.map((c) => c.clubId), taken: [],
    respins: o.respins ?? FREE_RESPINS, respinsUsed: 0, budget: budgetFor(o.era), feed: [], coins: o.coins ?? 0, phase: "picking", seasons: null, match: null, coinsEarned: 0, notice: null,
  };
}

export const slotsOf = (s: DraftState) => FORMATIONS[s.formation];
export const isShared = (mode: DraftMode) => mode === "duel" || mode === "room";
export const activeSeat = (s: DraftState) => (isShared(s.mode) ? pickOrder(s.round + s.firstSeat, s.seats.length)[s.turn] : 0);
export const takenIds = (s: DraftState) => s.taken.map((t) => t.playerId);
export const leagueOf = (u: DraftUniverse, s: DraftState) => u.leagues.find((l) => l.id === s.leagueId) ?? u.leagues[0];

type Pick2 = { spin: ClubSeason; spinCount: number; usedClubs: string[] };
function nextSpin(u: DraftUniverse, s: DraftState, tag: string): Pick2 {
  const spin = u.spin(s.leagueId, s.era, `${s.seed}|${tag}|${s.spinCount}`, s.usedClubs);
  return { spin, spinCount: s.spinCount + 1, usedClubs: [...s.usedClubs, spin.clubId] };
}

export type RespinKind = "club" | "season";

/** Re-spin either reel: free ones first; in Free play more cost coins. Never in a duel or room: everyone shares that spin. */
export function respin(u: DraftUniverse, s: DraftState, kind: RespinKind = "club"): DraftState {
  if (s.phase !== "picking" || isShared(s.mode)) return s;
  const free = s.respins > 0;
  if (!free && s.mode !== "free") return s;
  if (!free && s.coins < RESPIN_COST) return { ...s, notice: "no_coins" };
  let drawn: Pick2 | null;
  if (kind === "season") {
    const next = u.otherSeason(s.spin, s.era, `${s.seed}|season|${s.spinCount}`);
    if (!next) return { ...s, notice: "no_other_season" };
    drawn = { spin: next, spinCount: s.spinCount + 1, usedClubs: s.usedClubs };
  } else {
    const next = u.otherClub(s.spin, s.era, `${s.seed}|club|${s.spinCount}`, s.usedClubs);
    if (!next) return { ...s, notice: "no_other_season" };
    drawn = { spin: next, spinCount: s.spinCount + 1, usedClubs: [...s.usedClubs, next.clubId] };
  }
  const paid = free ? { respins: s.respins - 1 } : { coins: s.coins - RESPIN_COST };
  return ensureFit(u, { ...s, ...drawn, ...paid, respinsUsed: s.respinsUsed + 1, notice: null });
}

/** Who this seat can sign right now: fits, not taken, and in a Transfer budget draft within what it can spend. */
export function optionsFor(s: DraftState, seatIdx: number): DraftPlayer[] {
  const seat = s.seats[seatIdx];
  const fits = pickable(s.spin.players, slotsOf(s), seat.picks, takenIds(s));
  if (s.variant !== "budget") return fits;
  const { left } = wallet(seat.picks, s.budget);
  return fits.filter((p) => priceOf(p) <= left);
}

/** If nobody in the spun squad fits the seat's open slots: a solo draft gets a free replacement spin, a shared spin gives an academy kid. */
function ensureFit(u: DraftUniverse, s: DraftState): DraftState {
  let next = s;
  for (let guard = 0; guard < 8; guard++) {
    const seatIdx = activeSeat(next);
    if (optionsFor(next, seatIdx).length > 0) return next;
    if (isShared(next.mode) && next.variant !== "budget") break;
    if (isShared(next.mode) && pickable(next.spin.players, slotsOf(next), next.seats[seatIdx].picks, takenIds(next)).length === 0) break;
    // Out of money: another spin would not help. The player chooses which place goes to a free academy kid.
    if (pickable(next.spin.players, slotsOf(next), next.seats[seatIdx].picks, takenIds(next)).length > 0) return { ...next, notice: seatIdx === 0 ? "no_money" : next.notice };
    // Tagged by the round, not by how the draft got here: whoever needs this replacement gets the same one.
    next = { ...next, ...nextSpin(u, { ...next, spinCount: next.round * 100 + guard }, "fit"), notice: "no_fit" };
  }
  return advance(u, { ...autoAcademy(next), notice: activeSeat(next) === 0 ? "academy" : next.notice });
}

/** A seat that cannot fit anyone left in a shared spin gets an academy kid in its first open slot. */
function autoAcademy(s: DraftState, slotId?: string): DraftState {
  const seatIdx = activeSeat(s);
  const seat = s.seats[seatIdx];
  const chosen = slotId ? seat.picks.findIndex((p, k) => !p && slotsOf(s)[k].id === slotId) : -1;
  const i = chosen >= 0 ? chosen : seat.picks.findIndex((p) => !p);
  const slot = slotsOf(s)[i];
  const kid: DraftPlayer = { id: `academy-${s.round}-${seatIdx}`, name: "", pos: slot.pos, rating: 50, apps: 0, goals: 0, assists: 0, cleanSheets: 0, minutesShare: 0 };
  const picks = seat.picks.slice();
  picks[i] = { slotId: slot.id, player: kid, club: s.spin.club, season: s.spin.season, offPosition: false, academy: true, round: s.round };
  return { ...s, seats: s.seats.map((x, k) => (k === seatIdx ? { ...x, picks } : x)) };
}

/** Transfer budget: a free academy kid in the place the player chooses, to save money for the others. */
export function signAcademy(u: DraftUniverse, s: DraftState, slotId: string): DraftState {
  if (s.phase !== "picking" || s.variant !== "budget") return s;
  const seat = s.seats[activeSeat(s)];
  const i = slotsOf(s).findIndex((x) => x.id === slotId);
  if (i < 0 || seat.picks[i]) return s;
  return advance(u, { ...autoAcademy(s, slotId), notice: null });
}

export function pick(u: DraftUniverse, s: DraftState, playerId: string, slotId?: string): DraftState {
  if (s.phase !== "picking") return s;
  const seatIdx = activeSeat(s);
  const seat = s.seats[seatIdx];
  const player = s.spin.players.find((p) => p.id === playerId);
  if (!player || takenIds(s).includes(playerId)) return s;
  const slots = slotsOf(s);
  const open = openSlotsFor(player, slots, seat.picks);
  const target = slotId ? open.find((x) => x.id === slotId) : open[0];
  if (!target) return s;
  const budget = s.variant === "budget";
  if (budget && priceOf(player) > wallet(seat.picks, s.budget).left) return s;
  // The reveal compares like with like: the best player on offer for the line he filled.
  const signed = { name: player.name, rating: destination(player, slots, seat.picks, target.id)?.rating ?? player.rating };
  const best = optionsFor(s, seatIdx)
    .map((p) => ({ dest: destination(p, slots, seat.picks), name: p.name }))
    .filter((x) => x.dest?.slot.pos === target.pos)
    .map((x) => ({ name: x.name, rating: x.dest?.rating ?? 0 }))
    .reduce((a, b) => (b.rating > a.rating ? b : a), signed);
  const picks = place(seat.picks, slots, target.id, player, s.spin).map((p) => (p?.slotId === target.id ? { ...p, best, round: s.round, ...(budget ? { price: priceOf(player) } : {}) } : p));
  return advance(u, { ...s, seats: s.seats.map((x, k) => (k === seatIdx ? { ...x, picks } : x)), taken: [...s.taken, { playerId, seat: seatIdx }], feed: [...s.feed, { seat: seatIdx, name: player.name, club: s.spin.club, season: s.spin.season }], notice: null });
}

function advance(u: DraftUniverse, s: DraftState): DraftState {
  if (isShared(s.mode) && s.turn + 1 < s.seats.length) return ensureFit(u, { ...s, turn: s.turn + 1 });
  if (s.round + 1 >= XI) return { ...s, phase: "ready" };
  return ensureFit(u, { ...s, round: s.round + 1, turn: 0, taken: [], spin: s.deal[s.round + 1] });
}

/** A bot (or a seat whose clock ran out) takes a fitting player: bots favour good players, with some misses. */
export function botPick(u: DraftUniverse, s: DraftState, skill = 0.7, tag = ""): DraftState {
  const seatIdx = activeSeat(s);
  const seat = s.seats[seatIdx];
  const options = optionsFor(s, seatIdx);
  if (!options.length) return advance(u, autoAcademy(s));
  const r = rng(`${s.seed}|bot|${s.round}|${s.turn}${tag}`);
  const rated = (p: DraftPlayer) => destination(p, slotsOf(s), seat.picks)?.rating ?? p.rating;
  let score = rated;
  if (s.variant === "budget") {
    // Spend at a pace that lasts all eleven places, and prefer value over the biggest name.
    const { left, open } = wallet(seat.picks, s.budget);
    const pace = (left / Math.max(1, open)) * 1.7;
    score = (p) => rated(p) - priceOf(p) * 0.12 - (priceOf(p) > pace ? 100 : 0);
  }
  const sorted = options.slice().sort((a, b) => score(b) - score(a));
  const choice = r() < skill ? sorted[0] : sorted[Math.min(sorted.length - 1, 1 + Math.floor(r() * 3))];
  return pick(u, s, choice.id);
}

/** The clock ran out: the first name that fits and can be paid for, so letting time run out is never smarter than choosing. */
export function timeoutPick(u: DraftUniverse, s: DraftState): DraftState {
  const options = optionsFor(s, activeSeat(s)).slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return options.length ? pick(u, s, options[0].id) : advance(u, autoAcademy(s));
}

/** Play every seat's season; in a duel also the match day. Coins only for the player's own seat. */
export function finish(u: DraftUniverse, s: DraftState): DraftState {
  // Only a complete XI plays, and only once: coins and results can never come twice.
  if (s.phase !== "ready" || s.seats.some((seat) => seat.picks.some((p) => !p))) return s;
  const league = leagueOf(u, s);
  const opps = u.opponents(s.leagueId, s.seed);
  const seasons = s.seats.map((seat) => playSeason(slotsOf(s), seat.picks, league, opps, s.seed));
  const match = s.mode === "duel" ? matchDay(lines(slotsOf(s), s.seats[0].picks), lines(slotsOf(s), s.seats[1].picks), s.seed) : null;
  const coinsEarned = s.mode === "daily" || s.mode === "free" ? coinsFor(seasons[0], s.variant) : 0;
  return { ...s, phase: "result", seasons, match, coinsEarned, coins: s.coins + coinsEarned };
}

export const filled = (seat: DraftSeat) => seat.picks.filter(Boolean).length;
