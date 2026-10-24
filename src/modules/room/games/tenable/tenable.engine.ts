import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SLOTS, tenableListSchema, type TenableList, type TenableLocale } from '../../../tenable/tenable.content.js';
import { formatFigure } from '../../../tenable/tenable.figures.js';
import { judge, type Directory } from '../../../tenable/tenable.identify.js';
import { shownName } from '../../../tenable/tenable.names.js';
import { textIn } from '../../../tenable/tenable.text.js';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';

/**
 * Football Tenable as a room game (2–6 seats), pure: time comes in as `now` (the database clock read under the match
 * lock); the only random choice, the first opener, comes from the pack's seed.
 *
 * One hidden top-10 list at a time on a shared tower. Seats take turns; a right answer takes its slot and scores the
 * slot's number, a wrong answer or a timeout costs a life (LIVES per list). Free answers (already on the tower, a name
 * that means several people, a name we do not know) keep the turn and its deadline. A seat at 0 lives sits out the rest
 * of the list; a lone survivor keeps going. The list ends at 10/10 or when no seat with lives is left. LISTS lists.
 */
export const TURN_MS = 20_000;
export const INTRO_MS = 3_000;
export const LIST_END_MS = 6_000;
export const LIVES = 2;
export const LISTS = 3;
const MAX_TEXT = 60;

export const tenablePackSchema = z.object({
  lists: z.array(tenableListSchema).length(LISTS),
  seed: z.number().int().min(0).max(0xffffffff),
}).strict();
export type TenablePack = z.infer<typeof tenablePackSchema>;
/** The stored pack, plus (in memory only) each list's entity directory. */
export interface TenableContent { pack: TenablePack; directories: Directory[] | null }

export const tenableCommandSchema = z.object({
  type: z.literal('answer'),
  /** The turn this answer is for: it changes whenever the turn moves on. */
  epoch: z.number().int().min(0).max(100_000),
  /** The attempt inside that turn: a repeated or late send is never judged twice. */
  attempt: z.number().int().min(0).max(1_000),
  text: z.string().min(1).max(MAX_TEXT),
  /** A picked suggestion's entity id. */
  pick: z.string().min(1).max(64).nullable().optional(),
}).strict();
export type TenableCommand = z.infer<typeof tenableCommandSchema>;

export type Phase = 'intro' | 'turn' | 'listEnd' | 'over' | 'cancelled';
export type FeedbackKind = 'right' | 'wrong' | 'repeat' | 'ambiguous' | 'unknown' | 'time';
export interface Feedback { epoch: number; attempt: number; seat: number; kind: FeedbackKind; text: string; eid: string | null; slot: number | null }

export interface TenableState extends RoomEngineState {
  phase: Phase;
  list: number;
  points: number[];
  /** Slots found per seat over the match. */
  found: number[];
  /** Lives on the current list. */
  lives: number[];
  /** Who took each slot of the current list (null = still hidden). */
  claimed: Array<number | null>;
  turn: number;
  epoch: number;
  attempts: number;
  /** The seats in a random order drawn from the pack's seed: list i is opened by the i-th of them (rotating). */
  order: number[];
  last: Feedback | null;
  listEnd: 'complete' | 'out' | null;
  /** Points per seat on the list that just ended. */
  listPoints: number[] | null;
  /** Lists fully revealed so far (a report on a list is allowed only once it is out). */
  revealed: number;
  /** Seats that left while the match was open: they rank below everyone who stayed. */
  quit: boolean[];
}

export type CommandError = 'stale_turn' | 'not_open' | 'not_your_turn' | 'withdrawn' | 'stale_attempt' | 'invalid';

const fill = <T>(seats: number, value: T): T[] => Array.from({ length: seats }, () => value);
const ended = (s: TenableState) => s.phase === 'over' || s.phase === 'cancelled';
const decided = (s: TenableState) => s.phase === 'over' || (s.phase === 'listEnd' && s.list + 1 >= LISTS);
const directoryOf = (content: TenableContent, list: number): Directory => {
  const directory = content.directories?.[list];
  if (!directory) throw new Error('tenable content is not hydrated');
  return directory;
};

/**
 * A permutation of the seats from the seed: Fisher-Yates over a SHA-256 stream of (seed, step), with rejection so every
 * order is equally likely. The same pack gives the same order on every replica.
 */
export function seatOrder(seats: number, seed: number): number[] {
  const order = Array.from({ length: seats }, (_, i) => i);
  let counter = 0;
  const below = (n: number): number => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = createHash('sha256').update(`${seed}:${counter++}`).digest().readUInt32BE(0);
      if (x < limit) return x % n;
    }
  };
  for (let i = seats - 1; i > 0; i -= 1) {
    const j = below(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function startMatch(seats: number, content: TenableContent, now: number): TenableState {
  if (seats < 2 || seats > 6) throw new Error('A room match needs 2 to 6 admitted seats');
  const order = seatOrder(seats, content.pack.seed);
  return {
    phase: 'intro', list: 0, deadline: now + INTRO_MS, status: fill(seats, 'in'), points: fill(seats, 0), found: fill(seats, 0), lives: fill(seats, LIVES),
    claimed: fill(SLOTS, null), turn: order[0], epoch: 0, attempts: 0, order, last: null, listEnd: null, listPoints: null,
    revealed: 0, quit: fill(seats, false),
  };
}

/** Seats that can still take a turn on this list. */
const canPlay = (s: TenableState, seat: number) => s.status[seat] !== 'withdrawn' && s.lives[seat] > 0;

/** The next seat with lives after `seat` (itself when it is the only one left), or null. */
function nextSeat(s: TenableState, seat: number): number | null {
  for (let step = 1; step <= s.status.length; step += 1) {
    const candidate = (seat + step) % s.status.length;
    if (canPlay(s, candidate)) return candidate;
  }
  return null;
}

/**
 * List i is opened by the i-th seat of the random order (rotating), skipping seats that left. Fixed before the match
 * starts, so no score or play can buy a better opening (a scored opener rule would reward throwing points).
 */
function openerFor(s: TenableState, list: number): number {
  for (let k = 0; k < s.order.length; k += 1) {
    const seat = s.order[(list + k) % s.order.length];
    if (s.status[seat] !== 'withdrawn') return seat;
  }
  return 0;
}

function beginList(s: TenableState, list: number, now: number): TenableState {
  const lives = s.status.map((st) => (st === 'withdrawn' ? 0 : LIVES));
  const fresh = { ...s, list, lives, claimed: fill(SLOTS, null), listEnd: null, listPoints: null, last: null };
  const opener = openerFor(fresh, list);
  return { ...fresh, phase: 'turn', turn: opener, epoch: s.epoch + 1, attempts: 0, deadline: now + TURN_MS };
}

function endList(s: TenableState, reason: 'complete' | 'out', now: number): TenableState {
  const listPoints = s.status.map((_, seat) => s.claimed.reduce<number>((sum, by, i) => (by === seat ? sum + i + 1 : sum), 0));
  return {
    ...s, phase: 'listEnd', listEnd: reason, listPoints, points: s.points.map((p, seat) => p + listPoints[seat]),
    revealed: s.list + 1, epoch: s.epoch + 1, attempts: 0, deadline: now + LIST_END_MS,
  };
}

/** After a turn that moved the game on (right, wrong, timeout, the seat on turn left): the next turn or the list's end. */
function afterMove(s: TenableState, from: number, now: number): TenableState {
  if (s.claimed.every((by) => by !== null)) return endList(s, 'complete', now);
  const next = nextSeat(s, from);
  if (next === null) return endList(s, 'out', now);
  return { ...s, turn: next, epoch: s.epoch + 1, attempts: 0, deadline: now + TURN_MS };
}

export function tick(s: TenableState, now: number): TenableState {
  if (ended(s) || now < s.deadline) return s;
  if (s.phase === 'intro') return beginList(s, 0, now);
  if (s.phase === 'turn') {
    const seat = s.turn;
    const lost: TenableState = { ...s, lives: s.lives.map((l, i) => (i === seat ? Math.max(0, l - 1) : l)), last: { epoch: s.epoch, attempt: s.attempts, seat, kind: 'time', text: '', eid: null, slot: null } };
    return afterMove(lost, seat, now);
  }
  return s.list + 1 >= LISTS ? { ...s, phase: 'over' } : beginList(s, s.list + 1, now);
}

/** After an outage the open turn (or the intro) gets a fresh window; nobody is charged. */
export function afterOutage(s: TenableState, now: number): TenableState {
  if (s.phase === 'intro') return { ...s, deadline: now + INTRO_MS };
  if (s.phase === 'turn') return { ...s, deadline: now + TURN_MS };
  return s;
}

/**
 * Seat changes that arrive together, at `now`. A seat that leaves is out of the match (its turn passes on at once, no
 * life is charged to anyone); fewer than two seats left ends it: a result once a list was finished, otherwise
 * cancelled. An away seat keeps its turn: its clock runs, and a timeout costs it a life like anyone's.
 */
export function seatsChanged(s: TenableState, changes: readonly RoomSeatChange[], now: number): TenableState {
  if (ended(s)) return s;
  const open = !decided(s);
  const status = [...s.status];
  const quit = [...s.quit];
  const left: number[] = [];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
    if (change === 'leave') {
      left.push(seat);
      if (open) quit[seat] = true;
    }
  }
  const next: TenableState = { ...s, status, quit, lives: s.lives.map((l, i) => (left.includes(i) ? 0 : l)) };
  if (!open || left.length === 0) return next;
  const live = status.filter((st) => st !== 'withdrawn').length;
  if (live < 2) return { ...next, phase: live === 0 || s.revealed === 0 ? 'cancelled' : 'over' };
  return next.phase === 'turn' && left.includes(next.turn) ? afterMove(next, next.turn, now) : next;
}

export function applyCommand(s: TenableState, content: TenableContent, seat: number, command: TenableCommand, now: number): { state: TenableState; error?: CommandError } {
  if (s.phase === 'turn' && command.epoch !== s.epoch) return { state: s, error: 'stale_turn' };
  // Same boundary as tick(): at the deadline the turn is lost, whichever runs first.
  if (s.phase !== 'turn' || now >= s.deadline) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (s.turn !== seat) return { state: s, error: 'not_your_turn' };
  if (command.attempt !== s.attempts) return { state: s, error: 'stale_attempt' };
  const text = command.text.trim();
  if (!text) return { state: s, error: 'invalid' };
  const list = content.pack.lists[s.list];
  const taken = new Set(s.claimed.flatMap((by, i) => (by === null ? [] : [i])));
  const verdict = judge(directoryOf(content, s.list), list.slots.map((x) => x.eid), taken, text, command.pick ?? null);
  const feedback: Feedback = {
    epoch: s.epoch, attempt: command.attempt, seat, kind: verdict.kind, text,
    eid: verdict.kind === 'right' || verdict.kind === 'wrong' || verdict.kind === 'repeat' ? verdict.eid : null,
    slot: verdict.kind === 'right' || verdict.kind === 'repeat' ? verdict.slot : null,
  };
  // Free: the turn and its deadline stay; only the attempt moves on.
  if (verdict.kind === 'repeat' || verdict.kind === 'ambiguous' || verdict.kind === 'unknown') return { state: { ...s, attempts: s.attempts + 1, last: feedback } };
  if (verdict.kind === 'right') {
    const claimed = s.claimed.map((by, i) => (i === verdict.slot ? seat : by));
    return { state: afterMove({ ...s, claimed, found: s.found.map((n, i) => (i === seat ? n + 1 : n)), last: feedback }, seat, now) };
  }
  return { state: afterMove({ ...s, lives: s.lives.map((l, i) => (i === seat ? l - 1 : l)), last: feedback }, seat, now) };
}

/** The table, best first; places are shared on equal points and seats that quit rank below everyone who stayed. */
export function standings(s: TenableState): RoomEngineStanding[] {
  const rows = s.points.map((points, seat) => ({ seat, points, found: s.found[seat], quit: s.quit[seat] }));
  const stayed = rows.filter((r) => !r.quit);
  return rows
    .sort((a, b) => Number(a.quit) - Number(b.quit) || b.points - a.points || b.found - a.found || a.seat - b.seat)
    .map((r) => ({ seat: r.seat, points: r.points, roundWins: r.found, place: r.quit ? stayed.length + 1 : 1 + stayed.filter((o) => o.points > r.points).length }));
}

/** Revealed: the list is over (its listEnd is on screen or past). Before that only claimed slots carry a name. */
export const listRevealed = (s: TenableState, list: number): boolean => list < s.revealed;

/** What a seat sees. Hidden slots carry nothing but their rank until the list is revealed. */
export function viewOf(s: TenableState, content: TenableContent, seat: number, locale: TenableLocale) {
  const over = ended(s);
  const listIndex = Math.min(s.list, LISTS - 1);
  const list: TenableList = content.pack.lists[listIndex];
  const directory = directoryOf(content, listIndex);
  const nameOf = (eid: string | null) => (eid === null ? null : shownName(directory, eid, locale));
  const text = textIn(list, locale);
  const open = listRevealed(s, listIndex);
  const started = s.phase !== 'intro';
  const last = s.last && { epoch: s.last.epoch, attempt: s.last.attempt, seat: s.last.seat, kind: s.last.kind, text: s.last.text, name: nameOf(s.last.eid), rank: s.last.slot === null ? null : s.last.slot + 1 };
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    list: listIndex,
    lists: LISTS,
    format: s.status.length === 2 ? 'duel' : 'party',
    turnMs: TURN_MS,
    // The title is shown with the intro countdown too: it is the question, not an answer.
    current: { title: text.title, note: text.note, asOf: list.asOf, kind: list.kind, release: list.release },
    slots: list.slots.map((slot, i) => {
      const by = started ? s.claimed[i] : null;
      const shown = by !== null || open;
      return { rank: i + 1, name: shown ? nameOf(slot.eid) : null, detail: shown ? formatFigure(slot.figure, locale) : null, by, missed: open && by === null };
    }),
    turn: s.phase === 'turn' ? s.turn : null,
    epoch: s.epoch,
    attempt: s.attempts,
    maxLives: LIVES,
    seats: s.status.map((status, i) => ({ seat: i, status, lives: s.lives[i], score: s.points[i], found: s.found[i] })),
    mySeat: seat,
    last,
    listEnd: s.phase === 'listEnd' || over ? (s.listEnd ? { reason: s.listEnd } : null) : null,
    listPoints: s.phase === 'listEnd' ? s.listPoints : null,
    final: decided(s),
    standings: s.phase === 'over' ? standings(s) : null,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
