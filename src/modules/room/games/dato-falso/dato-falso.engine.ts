import { z } from 'zod';
import type { RoomEngineStanding, RoomSeatChange, RoomSeatStatus } from '../../room.engine.js';
import { DF_CARDS, DF_OPTIONS, dfCardSchema, pointsFor, publicCard, revealOf, cutFor, type DfJoker, type DfPublicCard } from './dato-falso.rules.js';

/**
 * A Dato falso room (1v1 or 2–6), pure: every seat gets the same card at once and picks the fake. The card closes at
 * its deadline or as soon as every eligible seat has picked; the reveal shows every pick, joker and points. Nobody
 * sees another seat's pick or joker before the reveal.
 */

export const INTRO_MS = 3_000;
export const CARD_MS = 20_000;
export const REVEAL_MS = 6_000;
/** A deadline this far overdue is an outage: the open card gets a fresh window, nobody is charged. */
export const OUTAGE_MS = 5_000;
/** Cards in a row without a pick after which a seat is idle (the early close stops waiting for it). */
export const IDLE_AFTER = 2;

export const datoFalsoPackSchema = z.object({
  salt: z.string().min(16).max(64),
  cards: z.array(dfCardSchema).length(DF_CARDS),
}).strict().refine((p) => new Set(p.cards.map((c) => c.id)).size === p.cards.length, 'A card appears twice');
export type DatoFalsoContent = z.infer<typeof datoFalsoPackSchema>;

export const datoFalsoCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('joker'), card: z.number().int().min(0).max(DF_CARDS - 1), kind: z.enum(['cut', 'double']) }).strict(),
  z.object({ type: z.literal('pick'), card: z.number().int().min(0).max(DF_CARDS - 1), option: z.number().int().min(0).max(DF_OPTIONS - 1) }).strict(),
]);
export type DatoFalsoCommand = z.infer<typeof datoFalsoCommandSchema>;

export type DfPhase = 'intro' | 'card' | 'reveal' | 'over' | 'cancelled';

export interface DfEntry { seat: number; pick: number | null; cut: boolean; doubled: boolean; right: boolean; points: number }
export interface DfResult { card: number; fake: number; entries: DfEntry[] }

export interface DatoFalsoState {
  phase: DfPhase;
  card: number;
  deadline: number;
  status: RoomSeatStatus[];
  missed: number[];
  /** The open card's picks, Descartar 2 and Doble o nada per seat (private to each seat until the reveal). */
  picks: Array<number | null>;
  cut: boolean[];
  doubled: boolean[];
  /** Jokers spent in this match, per seat. */
  spent: Array<{ cut: boolean; double: boolean }>;
  results: DfResult[];
}

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

export function startMatch(seats: number, nowMs: number): DatoFalsoState {
  if (seats < 2 || seats > 6) throw new Error('A Dato falso room needs 2 to 6 admitted seats');
  return {
    phase: 'intro', card: 0, deadline: nowMs + INTRO_MS,
    status: fill(seats, 'in'), missed: fill(seats, 0),
    picks: fill(seats, null), cut: fill(seats, false), doubled: fill(seats, false),
    spent: Array.from({ length: seats }, () => ({ cut: false, double: false })),
    results: [],
  };
}

export const isIdle = (s: DatoFalsoState, seat: number) => s.missed[seat] >= IDLE_AFTER;
/**
 * Seats the early close waits for: every seat still in the match and not idle. A seat that dropped out a moment ago
 * is waited for until the card's deadline (its reconnect window must not cost it the card).
 */
const eligible = (s: DatoFalsoState) => s.status.flatMap((st, seat) => (st !== 'withdrawn' && !isIdle(s, seat) ? [seat] : []));

export const totals = (s: DatoFalsoState) => s.status.map((_, seat) => s.results.reduce((sum, r) => sum + r.entries[seat].points, 0));
export const rights = (s: DatoFalsoState) => s.status.map((_, seat) => s.results.filter((r) => r.entries[seat].right).length);

/**
 * Fewer than two seats left → the match ends. The one left wins (leaving is final) if a card was revealed or they are
 * still here; when the last two drop out one after the other before any reveal (both closed every tab), nobody is
 * left to win it and it is cancelled. Nobody left at all cancels too.
 */
function settleTerminal(s: DatoFalsoState): DatoFalsoState {
  if (s.phase === 'over' || s.phase === 'cancelled') return s;
  const live = s.status.flatMap((st, seat) => (st === 'withdrawn' ? [] : [seat]));
  if (live.length >= 2) return s;
  if (live.length === 0) return { ...s, phase: 'cancelled' };
  return { ...s, phase: s.results.length > 0 || s.status[live[0]] === 'in' ? 'over' : 'cancelled' };
}

/** Seat changes that arrive together, then one terminal check (everyone leaving at once cancels). */
export function seatsChanged(s: DatoFalsoState, changes: readonly RoomSeatChange[]): DatoFalsoState {
  if (s.phase === 'over' || s.phase === 'cancelled') return s;
  const status = [...s.status];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
  }
  return settleTerminal({ ...s, status });
}

function reveal(s: DatoFalsoState, content: DatoFalsoContent, nowMs: number): DatoFalsoState {
  const fake = content.cards[s.card].fake;
  // An idle seat the early close did not wait for had no full clock to answer in: jokers it played on this card come
  // back to it, and an unanswered double costs nothing.
  const early = nowMs < s.deadline;
  const refunded = (seat: number) => early && isIdle(s, seat) && s.picks[seat] === null;
  // A seat that left scores nothing from then on: no point for a pick it made, no −1 for a double it can no longer play.
  const entries = s.status.map((status, seat): DfEntry => {
    if (status === 'withdrawn') return { seat, pick: null, cut: s.cut[seat], doubled: false, right: false, points: 0 };
    if (refunded(seat)) return { seat, pick: null, cut: false, doubled: false, right: false, points: 0 };
    const right = s.picks[seat] === fake;
    return { seat, pick: s.picks[seat], cut: s.cut[seat], doubled: s.doubled[seat], right, points: pointsFor(right, s.doubled[seat]) };
  });
  const spent = s.spent.map((j, seat) => (refunded(seat) ? { cut: j.cut && !s.cut[seat], double: j.double && !s.doubled[seat] } : j));
  const missed = s.missed.map((m, seat) => (s.picks[seat] === null ? m + 1 : 0));
  return { ...s, phase: 'reveal', deadline: nowMs + REVEAL_MS, results: [...s.results, { card: s.card, fake, entries }], missed, spent };
}

function openCard(s: DatoFalsoState, card: number, nowMs: number): DatoFalsoState {
  const n = s.status.length;
  return { ...s, phase: 'card', card, deadline: nowMs + CARD_MS, picks: fill(n, null), cut: fill(n, false), doubled: fill(n, false) };
}

/** Moves the clock: intro → card 0; a card closes at its deadline or when every eligible seat picked; reveal → next. */
export function tick(s: DatoFalsoState, content: DatoFalsoContent, nowMs: number): DatoFalsoState {
  if (s.phase === 'intro') return nowMs >= s.deadline ? openCard(s, 0, nowMs) : s;
  if (s.phase === 'card') {
    if (nowMs - s.deadline > OUTAGE_MS) return { ...s, deadline: nowMs + CARD_MS };
    const seats = eligible(s);
    const allIn = seats.length > 0 && seats.every((seat) => s.picks[seat] !== null);
    return nowMs >= s.deadline || allIn ? reveal(s, content, nowMs) : s;
  }
  if (s.phase === 'reveal' && nowMs >= s.deadline) {
    return s.card + 1 >= content.cards.length ? { ...s, phase: 'over' } : openCard(s, s.card + 1, nowMs);
  }
  return s;
}

export function afterOutage(s: DatoFalsoState, nowMs: number): DatoFalsoState {
  return s.phase === 'card' ? { ...s, deadline: nowMs + CARD_MS } : s;
}

const replace = <T>(list: readonly T[], at: number, value: T): T[] => list.map((v, i) => (i === at ? value : v));

export function applyCommand(s: DatoFalsoState, content: DatoFalsoContent, seat: number, cmd: DatoFalsoCommand, nowMs: number): { state: DatoFalsoState; error?: string } {
  if (s.phase !== 'card' || nowMs >= s.deadline) return { state: s, error: 'not_open' };
  if (cmd.card !== s.card) return { state: s, error: 'stale_card' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (s.picks[seat] !== null) return { state: s, error: 'already_picked' };
  if (cmd.type === 'joker') return joker(s, seat, cmd.kind);
  if (s.cut[seat] && cutFor(content.cards[s.card], content.salt, seat).includes(cmd.option)) return { state: s, error: 'option_removed' };
  // A pick clears idle at once (the seat is back in the early-close set).
  return { state: { ...s, picks: replace(s.picks, seat, cmd.option), missed: replace(s.missed, seat, 0) } };
}

function joker(s: DatoFalsoState, seat: number, kind: DfJoker): { state: DatoFalsoState; error?: string } {
  if (s.spent[seat][kind]) return { state: s, error: 'joker_used' };
  // Only a pick clears idle: a joker changing a public flag would tell the others it was played.
  const spent = replace(s.spent, seat, { ...s.spent[seat], [kind]: true });
  return kind === 'cut'
    ? { state: { ...s, spent, cut: replace(s.cut, seat, true) } }
    : { state: { ...s, spent, doubled: replace(s.doubled, seat, true) } };
}

/** Points first; equal points share a place; seats that left rank below everyone who stayed. */
export function standings(s: DatoFalsoState): RoomEngineStanding[] {
  const points = totals(s);
  const wins = rights(s);
  const order = s.status.map((st, seat) => ({ seat, out: st === 'withdrawn', points: points[seat] }))
    .sort((a, b) => Number(a.out) - Number(b.out) || b.points - a.points || a.seat - b.seat);
  const place = new Map<number, number>();
  order.forEach((x, i) => {
    const prev = order[i - 1];
    place.set(x.seat, prev && prev.out === x.out && prev.points === x.points ? place.get(prev.seat)! : i + 1);
  });
  return s.status.map((_, seat) => ({ seat, points: points[seat], roundWins: wins[seat], place: place.get(seat)! }));
}

export interface DatoFalsoView {
  phase: 'intro' | 'card' | 'reveal' | 'over';
  card: number;
  totalCards: number;
  current: DfPublicCard | null;
  seats: Array<{ seat: number; status: RoomSeatStatus; answered: boolean; idle: boolean; score: number; jokers: { cut: boolean; double: boolean } | null }>;
  mySeat: number;
  mine: { pick: number | null; removed: number[]; doubled: boolean; jokers: { cut: boolean; double: boolean } };
  reveal: (DfResult & { explain: string }) | null;
  results: DfResult[];
  standings: RoomEngineStanding[] | null;
  deadline: string | null;
}

/**
 * What `seat` sees. The open card has no fake and no explanation; the other seats show only whether they answered,
 * and their jokers only once the card is revealed (a seat's spent jokers from revealed cards are public).
 */
export function viewOf(s: DatoFalsoState, content: DatoFalsoContent, seat: number, locale: string): DatoFalsoView {
  const points = totals(s);
  const card = content.cards[s.card];
  const showing = s.phase === 'card' || s.phase === 'reveal';
  const last = s.phase === 'reveal' ? s.results[s.results.length - 1] : null;
  // Jokers others spent on revealed cards only: during an open card, its own jokers stay private.
  const publicSpent = s.status.map((_, x) => ({
    cut: s.results.some((r) => r.entries[x].cut),
    double: s.results.some((r) => r.entries[x].doubled),
  }));
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    card: s.card,
    totalCards: content.cards.length,
    current: showing ? publicCard(card, locale) : null,
    seats: s.status.map((status, x) => ({
      seat: x, status,
      answered: s.phase === 'card' ? s.picks[x] !== null : last ? last.entries[x].pick !== null : false,
      idle: isIdle(s, x),
      score: points[x],
      jokers: x === seat ? s.spent[x] : publicSpent[x],
    })),
    mySeat: seat,
    mine: {
      pick: showing ? s.picks[seat] : null,
      removed: showing && s.cut[seat] ? cutFor(card, content.salt, seat) : [],
      doubled: showing ? s.doubled[seat] : false,
      jokers: s.spent[seat],
    },
    reveal: last ? { ...last, explain: revealOf(card, locale).explain } : null,
    results: s.results,
    standings: s.phase === 'over' || s.phase === 'cancelled' ? standings(s) : null,
    deadline: s.phase === 'over' || s.phase === 'cancelled' ? null : new Date(s.deadline).toISOString(),
  };
}
