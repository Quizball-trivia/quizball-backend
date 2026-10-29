import { createHash } from 'node:crypto';
import { z } from 'zod';
import { d501CategorySchema, textIn, type D501Category, type D501Locale } from '../../../darts501/darts501.content.js';
import { D501, entriesOf, finishes, outs, readDart, type Board, type DartVerdict } from '../../../darts501/darts501.rules.js';
import { shownName } from '../../../tenable/tenable.names.js';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';

/**
 * Football Darts 501 as a room game (2–6 seats), pure: time comes in as `now` (the database clock read under the match
 * lock); the only random choice, the openers' order, comes from the pack's seed.
 *
 * A leg: everyone on 501, turns in seat order, one footballer of the leg's category per turn. After a checkout the rest
 * of that round still throws; then the seat closest to 0 takes the leg (the first to get there on a tie). When nobody
 * can throw any more (DARTS each), the lowest score takes it, and a tie for lowest takes nobody. A 1v1 is first to
 * two legs, at most LEGS (drawn legs can leave it level: then less left over the legs, then a draw); a party plays
 * LEGS legs. A turn that runs out is a dart that scores nothing; IDLE_LIMIT of them in a row, with no dart thrown in
 * between, bench the seat for the rest of the match (it keeps its room seat, so the runtime's seat rows stay true).
 */
export const TURN_MS = 20_000;
export const INTRO_MS = 3_000;
export const LEG_END_MS = 6_000;
export const LEGS = 3;
export const IDLE_LIMIT = 3;
/** Finishes a seat is shown at a leg's end, from the score it was left on. */
export const MISSED_SHOWN = 3;
const MAX_TEXT = 60;

export const darts501PackSchema = z.object({
  legs: z.array(d501CategorySchema).length(LEGS),
  seed: z.number().int().min(0).max(0xffffffff),
}).strict();
export type Darts501Pack = z.infer<typeof darts501PackSchema>;
/** The stored pack, plus (in memory only) each leg's footballers and coverage. */
export interface Darts501Content { pack: Darts501Pack; boards: Board[] | null }

export const darts501CommandSchema = z.object({
  type: z.literal('throw'),
  /** The turn this dart is for: it changes whenever the turn moves on. */
  epoch: z.number().int().min(0).max(100_000),
  /** The attempt inside that turn: a repeated or late send is never judged twice. */
  attempt: z.number().int().min(0).max(1_000),
  text: z.string().min(1).max(MAX_TEXT),
  /** A picked suggestion's footballer id. */
  pick: z.string().min(1).max(64).nullable().optional(),
}).strict();
export type Darts501Command = z.infer<typeof darts501CommandSchema>;

export type Phase = 'intro' | 'turn' | 'legEnd' | 'over' | 'cancelled';
/** One dart of the current leg; `e` is null for a turn that ran out, `x` null for a miss. */
export interface StoredDart { n: number; seat: number; e: string | null; t: string; v: DartVerdict; x: number | null; b: number; a: number }
export interface Feedback extends StoredDart { epoch: number; attempt: number }

export interface Darts501State extends RoomEngineState {
  phase: Phase;
  leg: number;
  remaining: number[];
  /** Darts each seat has used in this leg. */
  used: number[];
  legsWon: number[];
  /** What each seat was left on, summed over the finished legs (the party table's tie-break). */
  leftTotal: number[];
  /** This leg's darts, in order. */
  thrown: StoredDart[];
  /** Seats that threw in the round under way. */
  round: number[];
  /** Seats that checked out in this leg, in order, with where they landed. */
  finishing: Array<{ seat: number; at: number }>;
  turn: number;
  epoch: number;
  attempts: number;
  /** The seats in a random order drawn from the pack's seed: leg i is opened by the i-th of them (rotating). */
  order: number[];
  last: Feedback | null;
  legEnd: { winner: number | null; reason: 'checkout' | 'darts' } | null;
  /** Turns in a row each seat let run out (only a thrown dart resets it; free answers do not). */
  idle: number[];
  /** Seats benched for idling: they throw no more and rank with the seats that left. */
  benched: boolean[];
  /** Legs finished so far (a report on a leg is allowed only once it is over). */
  revealed: number;
  /** Seats that left (or were taken out) while the match was open: they rank below everyone who stayed. */
  quit: boolean[];
  pro: boolean;
}

export type CommandError = 'stale_turn' | 'not_open' | 'not_your_turn' | 'withdrawn' | 'stale_attempt' | 'invalid';

const fill = <T>(seats: number, value: T): T[] => Array.from({ length: seats }, () => value);
const ended = (s: Darts501State) => s.phase === 'over' || s.phase === 'cancelled';
const legsToWin = (s: Darts501State) => (s.status.length === 2 ? Math.floor(LEGS / 2) + 1 : LEGS);
const isFinal = (s: Darts501State) => s.legsWon.some((n) => n >= legsToWin(s)) || s.leg + 1 >= LEGS || alive(s) < 2;
const decided = (s: Darts501State) => s.phase === 'over' || (s.phase === 'legEnd' && isFinal(s));
const playing = (s: Darts501State, seat: number) => s.status[seat] !== 'withdrawn' && !s.benched[seat];
const alive = (s: Darts501State) => s.status.filter((_, seat) => playing(s, seat)).length;
const boardOf = (content: Darts501Content, leg: number): Board => {
  const board = content.boards?.[leg];
  if (!board) throw new Error('darts501 content is not hydrated');
  return board;
};
const usedOf = (s: Darts501State) => new Set(s.thrown.flatMap((d) => (d.e ? [d.e] : [])));

/** A permutation of the seats from the seed (Fisher-Yates over a SHA-256 stream, with rejection): the same on every replica. */
export function seatOrder(seats: number, seed: number): number[] {
  const order = Array.from({ length: seats }, (_, i) => i);
  let counter = 0;
  const below = (n: number): number => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = createHash('sha256').update(`d501:${seed}:${counter++}`).digest().readUInt32BE(0);
      if (x < limit) return x % n;
    }
  };
  for (let i = seats - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function startMatch(seats: number, content: Darts501Content, now: number): Darts501State {
  if (seats < 2 || seats > 6) throw new Error('A room match needs 2 to 6 admitted seats');
  const order = seatOrder(seats, content.pack.seed);
  return {
    phase: 'intro', leg: 0, deadline: now + INTRO_MS, status: fill(seats, 'in'), remaining: fill(seats, D501.start), used: fill(seats, 0),
    legsWon: fill(seats, 0), leftTotal: fill(seats, 0), thrown: [], round: [], finishing: [], turn: order[0], epoch: 0, attempts: 0, order,
    last: null, legEnd: null, idle: fill(seats, 0), benched: fill(seats, false), revealed: 0, quit: fill(seats, false), pro: false,
  };
}

const canThrow = (s: Darts501State, seat: number) => playing(s, seat) && s.remaining[seat] > 0 && s.used[seat] < D501.darts;

/** The next seat after `after` that can throw, optionally only among seats that have not thrown in this round. */
function nextThrower(s: Darts501State, after: number, skip: readonly number[] = []): number | null {
  const n = s.status.length;
  for (let k = 1; k <= n; k += 1) {
    const seat = (after + k) % n;
    if (canThrow(s, seat) && !skip.includes(seat)) return seat;
  }
  return null;
}

/** Leg i is opened by the i-th seat of the random order (rotating), skipping seats that left: no play can buy it. */
function openerFor(s: Darts501State, leg: number): number | null {
  for (let k = 0; k < s.order.length; k += 1) {
    const seat = s.order[(leg + k) % s.order.length];
    if (canThrow(s, seat)) return seat;
  }
  return null;
}

const startTurn = (s: Darts501State, seat: number, now: number): Darts501State =>
  ({ ...s, phase: 'turn', turn: seat, epoch: s.epoch + 1, attempts: 0, deadline: now + TURN_MS });

function beginLeg(s: Darts501State, leg: number, now: number): Darts501State {
  const fresh: Darts501State = {
    ...s, leg, remaining: s.status.map(() => D501.start), used: s.status.map((_, seat) => (playing(s, seat) ? 0 : D501.darts)),
    thrown: [], round: [], finishing: [], last: null, legEnd: null,
  };
  const opener = openerFor(fresh, leg);
  return opener === null ? { ...fresh, phase: 'over' } : startTurn(fresh, opener, now);
}

function endLeg(s: Darts501State, winner: number | null, reason: 'checkout' | 'darts', now: number): Darts501State {
  return {
    ...s, phase: 'legEnd', legEnd: { winner, reason },
    legsWon: s.legsWon.map((n, seat) => n + (seat === winner ? 1 : 0)),
    leftTotal: s.leftTotal.map((n, seat) => n + Math.max(0, s.remaining[seat])),
    revealed: s.leg + 1, round: [], epoch: s.epoch + 1, attempts: 0, deadline: now + LEG_END_MS,
  };
}

/**
 * After `from` has thrown (or left): the rest of the round throws; at the end of a round with a checkout the seat closest
 * to 0 takes the leg (the first to get there on a tie); when nobody can throw any more, the lowest score does.
 */
function advance(s: Darts501State, from: number, now: number): Darts501State {
  const inRound = nextThrower(s, from, s.round);
  if (inRound !== null) return startTurn(s, inRound, now);
  if (s.finishing.length > 0) {
    const best = s.finishing.reduce((a, b) => (b.at > a.at ? b : a));
    return endLeg(s, best.seat, 'checkout', now);
  }
  const next = nextThrower(s, from);
  if (next !== null) return startTurn({ ...s, round: [] }, next, now);
  const live = s.status.flatMap((_, seat) => (playing(s, seat) ? [seat] : []));
  const low = Math.min(...live.map((seat) => s.remaining[seat]));
  const lows = live.filter((seat) => s.remaining[seat] === low);
  return endLeg(s, lows.length === 1 ? lows[0] : null, 'darts', now);
}

function record(s: Darts501State, dart: Omit<StoredDart, 'n'>, epoch: number, attempt: number): Darts501State {
  const stored: StoredDart = { ...dart, n: s.thrown.length };
  return {
    ...s,
    thrown: [...s.thrown, stored],
    remaining: s.remaining.map((r, seat) => (seat === dart.seat ? dart.a : r)),
    used: s.used.map((u, seat) => (seat === dart.seat ? u + 1 : u)),
    round: [...s.round, dart.seat],
    finishing: dart.v === 'checkout' ? [...s.finishing, { seat: dart.seat, at: dart.a }] : s.finishing,
    last: { ...stored, epoch, attempt },
  };
}

/** Fewer than two seats left: a result once a leg was finished, otherwise nothing was played (cancelled). */
function whenAlone(s: Darts501State): Darts501State {
  if (alive(s) >= 2) return s;
  return { ...s, phase: alive(s) === 0 || s.revealed === 0 ? 'cancelled' : 'over' };
}

/**
 * Takes `seats` out of the match at `now`: left (withdrawn) or idle (benched, still seated); the turn passes on at once
 * when it was theirs. A batch is applied whole before anything is decided.
 */
function withdraw(s: Darts501State, seats: readonly number[], now: number, how: 'left' | 'idle' = 'left'): Darts501State {
  if (seats.length === 0) return s;
  const open = !decided(s);
  const next: Darts501State = {
    ...s,
    status: how === 'left' ? s.status.map((st, seat) => (seats.includes(seat) ? 'withdrawn' : st)) : s.status,
    benched: how === 'idle' ? s.benched.map((b, seat) => b || seats.includes(seat)) : s.benched,
    quit: s.quit.map((q, seat) => q || (open && seats.includes(seat))),
    finishing: s.finishing.filter((f) => !seats.includes(f.seat)),
  };
  if (!open) return next;
  const alone = whenAlone(next);
  if (alone.phase !== next.phase) return alone;
  return next.phase === 'turn' && seats.includes(next.turn) ? advance(next, next.turn, now) : next;
}

export function tick(s: Darts501State, now: number): Darts501State {
  if (ended(s) || now < s.deadline) return s;
  if (s.phase === 'intro') return beginLeg(s, 0, now);
  if (s.phase === 'turn') {
    const seat = s.turn;
    const timedOut = record(s, { seat, e: null, t: '', v: 'time', x: null, b: s.remaining[seat], a: s.remaining[seat] }, s.epoch, s.attempts);
    const idle = s.idle.map((n, i) => (i === seat ? n + 1 : n));
    if (idle[seat] >= IDLE_LIMIT) return withdraw({ ...timedOut, idle }, [seat], now, 'idle');
    return advance({ ...timedOut, idle }, seat, now);
  }
  return isFinal(s) ? { ...s, phase: 'over' } : beginLeg(s, s.leg + 1, now);
}

/** After an outage the open turn (or the intro) gets a fresh window; nobody is charged. */
export function afterOutage(s: Darts501State, now: number): Darts501State {
  if (s.phase === 'intro') return { ...s, deadline: now + INTRO_MS };
  if (s.phase === 'turn') return { ...s, deadline: now + TURN_MS };
  return s;
}

/** Seat changes that arrive together, at `now`. An away seat keeps its turn: its clock runs like anyone's. */
export function seatsChanged(s: Darts501State, changes: readonly RoomSeatChange[], now: number): Darts501State {
  if (ended(s)) return s;
  const status = [...s.status];
  const left: number[] = [];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    if (change === 'leave') left.push(seat);
    else status[seat] = change === 'away' ? 'away' : 'in';
  }
  return withdraw({ ...s, status }, left, now);
}

export function applyCommand(s: Darts501State, content: Darts501Content, seat: number, command: Darts501Command, now: number): { state: Darts501State; error?: CommandError } {
  if (s.phase === 'turn' && command.epoch !== s.epoch) return { state: s, error: 'stale_turn' };
  // Same boundary as tick(): at the deadline the dart is lost, whichever runs first.
  if (s.phase !== 'turn' || now >= s.deadline) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (s.turn !== seat) return { state: s, error: 'not_your_turn' };
  if (command.attempt !== s.attempts) return { state: s, error: 'stale_attempt' };
  const text = command.text.trim();
  if (!text) return { state: s, error: 'invalid' };
  const read = readDart(boardOf(content, s.leg), usedOf(s), s.remaining[seat], text, command.pick ?? null, s.pro);
  if (read.free) {
    // Free: the turn and its deadline stay; only the attempt moves on (and a free answer is not a dart: idle stays).
    const last: Feedback = { n: s.thrown.length, seat, e: read.eid, t: text, v: read.verdict, x: null, b: s.remaining[seat], a: s.remaining[seat], epoch: s.epoch, attempt: command.attempt };
    return { state: { ...s, attempts: s.attempts + 1, last } };
  }
  const idle = s.idle.map((n, i) => (i === seat ? 0 : n));
  const thrown = record({ ...s, idle }, { seat, e: read.eid, t: text, v: read.verdict, x: read.value, b: s.remaining[seat], a: read.after }, s.epoch, command.attempt);
  return { state: advance(thrown, seat, now) };
}

/** The table, best first: legs won, then less left over the legs; places are shared on both, and seats that quit come last. */
export function standings(s: Darts501State): RoomEngineStanding[] {
  const rows = s.status.map((_, seat) => ({ seat, legs: s.legsWon[seat], left: s.leftTotal[seat], quit: s.quit[seat] }));
  const stayed = rows.filter((r) => !r.quit);
  const better = (a: typeof rows[number], b: typeof rows[number]) => a.legs > b.legs || (a.legs === b.legs && a.left < b.left);
  return rows
    .sort((a, b) => Number(a.quit) - Number(b.quit) || b.legs - a.legs || a.left - b.left || a.seat - b.seat)
    .map((r) => ({ seat: r.seat, points: r.legs, roundWins: r.legs, place: r.quit ? stayed.length + 1 : 1 + stayed.filter((o) => better(o, r)).length }));
}

/** A leg's darts and numbers are out once it is over. */
export const legRevealed = (s: Darts501State, leg: number): boolean => leg < s.revealed;

/** What a seat sees: the darts thrown and counts; the category's other numbers never, except the viewer's missed finishes at a leg's end. */
export function viewOf(s: Darts501State, content: Darts501Content, seat: number, locale: D501Locale) {
  const over = ended(s);
  const leg = Math.min(s.leg, LEGS - 1);
  const category: D501Category = content.pack.legs[leg];
  const board = boardOf(content, leg);
  const nameOf = (eid: string | null) => (eid === null ? null : shownName(board.directory, eid, locale));
  const text = textIn(category, locale);
  const toDart = (d: StoredDart) => ({ id: d.n, by: d.seat, text: d.t, name: nameOf(d.e), stat: d.x, verdict: d.v, before: d.b, after: d.a });
  const used = usedOf(s);
  const atLegEnd = s.phase === 'legEnd' || (over && s.legEnd !== null);
  const missed = atLegEnd && s.remaining[seat] > 0
    ? finishes(entriesOf(category), used, s.remaining[seat], MISSED_SHOWN, s.pro).map((f) => ({ name: nameOf(f.eid) ?? '?', value: f.value }))
    : [];
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    leg,
    legs: LEGS,
    format: s.status.length === 2 ? 'duel' : 'party',
    turnMs: TURN_MS,
    maxDarts: D501.darts,
    // The category is shown with the intro countdown too: it is the question, not an answer.
    current: { id: category.id, title: text.title, note: text.note, unit: category.unit, asOf: category.asOf, release: category.release, kind: category.kind },
    seats: s.status.map((status, i) => ({ seat: i, status, benched: s.benched[i], remaining: s.remaining[i], dartsUsed: s.used[i], legsWon: s.legsWon[i], leftTotal: s.leftTotal[i], idle: s.idle[i] })),
    turn: s.phase === 'turn' ? s.turn : null,
    epoch: s.epoch,
    attempt: s.attempts,
    mySeat: seat,
    darts: s.thrown.map(toDart),
    last: s.last && { ...toDart(s.last), epoch: s.last.epoch, attempt: s.last.attempt },
    finishing: s.finishing,
    outs: s.phase === 'turn' ? outs(entriesOf(category), used, s.remaining[s.turn], s.pro) : null,
    legEnd: atLegEnd && s.legEnd ? { ...s.legEnd, missed } : null,
    final: decided(s),
    standings: s.phase === 'over' ? standings(s) : null,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
