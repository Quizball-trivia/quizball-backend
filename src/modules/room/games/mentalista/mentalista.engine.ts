import { z } from 'zod';
import type { RoomEngineStanding, RoomSeatChange, RoomSeatStatus } from '../../room.engine.js';
import {
  MENTALISTA_MAX_OPTIONS, MENTALISTA_MAX_ROUNDS, MENTALISTA_MIN_SEATS, MENTALISTA_OUTAGE_MS, pointsFor,
  publicCategory, type MentalistaContent, type MentalistaPublicCategory,
} from './mentalista.rules.js';

/**
 * Mentalista's pure state machine. One round per admitted seat; in each the scheduled chooser commits a secret pick,
 * the other seats lock one prediction, then the round reveals. Phases: choose → predict → reveal → (next | over).
 * `tick` moves one boundary per call. The secret of an open round is never placed anywhere a non-author view reads it.
 */

export const mentalistaCommandSchema = z.discriminatedUnion('type', [
  // The chooser commits their legal pick (an option index of the round's public category).
  z.object({ type: z.literal('choose'), round: z.number().int().min(0).max(MENTALISTA_MAX_ROUNDS - 1), option: z.number().int().min(0).max(MENTALISTA_MAX_OPTIONS - 1) }).strict(),
  // A predictor locks one immutable prediction of the chooser's pick.
  z.object({ type: z.literal('predict'), round: z.number().int().min(0).max(MENTALISTA_MAX_ROUNDS - 1), option: z.number().int().min(0).max(MENTALISTA_MAX_OPTIONS - 1) }).strict(),
]);
export type MentalistaCommand = z.infer<typeof mentalistaCommandSchema>;

export type MentalistaPhase = 'choose' | 'predict' | 'reveal' | 'over' | 'cancelled';

export interface MentalistaEntry { seat: number; prediction: number | null; matched: boolean; points: number }
export interface MentalistaResult {
  round: number;
  chooser: number;
  /** The chooser's committed pick (an option index), or null when the slot was voided (no commit). */
  target: number | null;
  /** The slot produced no scoring: the chooser withdrew before committing, or none was committed by the deadline. */
  voided: boolean;
  entries: MentalistaEntry[];
}

export interface MentalistaState {
  phase: MentalistaPhase;
  round: number;
  deadline: number;
  status: RoomSeatStatus[];
  /** Who chooses in each round, frozen at the gate. One entry per round (= admitted seats). */
  schedule: number[];
  /** The open round's committed pick, private to the chooser until the reveal. */
  choice: number | null;
  committed: boolean;
  /** The open round's locked predictions, each private to its own seat until the reveal. */
  predictions: Array<number | null>;
  results: MentalistaResult[];
}

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);
const replace = <T>(list: readonly T[], at: number, value: T): T[] => list.map((v, i) => (i === at ? value : v));

export function startMatch(seats: number, content: MentalistaContent, nowMs: number): MentalistaState {
  if (seats < MENTALISTA_MIN_SEATS || seats > MENTALISTA_MAX_ROUNDS) throw new Error(`A Mentalista room needs ${MENTALISTA_MIN_SEATS} to ${MENTALISTA_MAX_ROUNDS} admitted seats`);
  if (content.categories.length < seats) throw new Error('Mentalista content has fewer categories than admitted seats');
  // One cycle, in seat order: each admitted seat chooses exactly once; the roster schedule never changes after this.
  const schedule = Array.from({ length: seats }, (_, r) => r);
  return openRound({
    phase: 'choose', round: 0, deadline: nowMs, status: fill(seats, 'in'), schedule,
    choice: null, committed: false, predictions: fill(seats, null), results: [],
  }, content, 0, nowMs);
}

const chooserOf = (s: MentalistaState): number => s.schedule[s.round];
const totalRounds = (s: MentalistaState): number => s.schedule.length;

export const totals = (s: MentalistaState): number[] => s.status.map((_, seat) => s.results.reduce((sum, r) => sum + (r.entries[seat]?.points ?? 0), 0));
export const matches = (s: MentalistaState): number[] => s.status.map((_, seat) => s.results.filter((r) => r.entries[seat]?.matched).length);

/** The predictors a round waits for: every seat still in the match (away included) that is not the chooser. */
const pendingPredictors = (s: MentalistaState): number[] => s.status.flatMap((st, seat) => (st !== 'withdrawn' && seat !== chooserOf(s) ? [seat] : []));

/**
 * Fewer than two non-withdrawn seats → the match ends once it can tell how: one left wins while they are here (leaving
 * is final); if they are away too, the match waits (back wins it, their window running out cancels it). None cancels.
 */
function settleTerminal(s: MentalistaState): MentalistaState {
  if (s.phase === 'over' || s.phase === 'cancelled') return s;
  const live = s.status.flatMap((st, seat) => (st === 'withdrawn' ? [] : [seat]));
  if (live.length >= 2) return s;
  if (live.length === 0) return { ...s, phase: 'cancelled' };
  return s.status[live[0]] === 'in' ? { ...s, phase: 'over' } : s;
}

const loneAway = (s: MentalistaState): boolean => {
  const live = s.status.filter((st) => st !== 'withdrawn');
  return live.length === 1 && live[0] === 'away';
};

/** Opens round `r` in the choose phase with a fresh pick/prediction slate. A withdrawn chooser is voided on the next tick. */
function openRound(s: MentalistaState, content: MentalistaContent, r: number, nowMs: number): MentalistaState {
  return { ...s, phase: 'choose', round: r, deadline: nowMs + content.timing.chooseMs, choice: null, committed: false, predictions: fill(s.status.length, null) };
}

function openPredict(s: MentalistaState, content: MentalistaContent, nowMs: number): MentalistaState {
  return { ...s, phase: 'predict', deadline: nowMs + content.timing.predictMs };
}

/** Banks a result and enters the reveal phase. `target` null marks a voided slot (no commit); scoring is then skipped. */
function bank(s: MentalistaState, content: MentalistaContent, target: number | null, nowMs: number): MentalistaState {
  const chooser = chooserOf(s);
  const voided = target === null;
  const entries: MentalistaEntry[] = s.status.map((status, seat): MentalistaEntry => {
    // The chooser never scores; a predictor who withdrew before the reveal earns no open-round points.
    if (seat === chooser || status === 'withdrawn' || voided) {
      return { seat, prediction: seat === chooser ? null : s.predictions[seat], matched: false, points: 0 };
    }
    const matched = s.predictions[seat] !== null && s.predictions[seat] === target;
    return { seat, prediction: s.predictions[seat], matched, points: pointsFor(matched) };
  });
  return { ...s, phase: 'reveal', deadline: nowMs + content.timing.revealMs, results: [...s.results, { round: s.round, chooser, target, voided, entries }] };
}

/** Moves the clock one boundary: choose → predict (on commit) or void; predict → reveal; reveal → next round or over. */
export function tick(s: MentalistaState, content: MentalistaContent, nowMs: number): MentalistaState {
  if (s.phase === 'over' || s.phase === 'cancelled') return s;
  if (s.phase === 'choose') {
    // Committed wins over a withdrawal in the same instant: a pick that landed before the chooser left is preserved.
    if (s.committed) return openPredict(s, content, nowMs);
    if (s.status[chooserOf(s)] === 'withdrawn') return bank(s, content, null, nowMs);
    if (nowMs - s.deadline > MENTALISTA_OUTAGE_MS) return { ...s, deadline: nowMs + content.timing.chooseMs };
    // Deadline with no commit: the slot is voided (there is no target to predict against).
    return nowMs >= s.deadline ? bank(s, content, null, nowMs) : s;
  }
  if (s.phase === 'predict') {
    if (nowMs - s.deadline > MENTALISTA_OUTAGE_MS) return { ...s, deadline: nowMs + content.timing.predictMs };
    const pend = pendingPredictors(s);
    const everyoneLocked = pend.length > 0 && pend.every((seat) => s.predictions[seat] !== null);
    return nowMs >= s.deadline || everyoneLocked ? bank(s, content, s.choice, nowMs) : s;
  }
  // reveal
  if (nowMs < s.deadline) return s;
  const next = s.round + 1;
  if (next < totalRounds(s)) return openRound(s, content, next, nowMs);
  // The last cycle is done. A lone away survivor keeps the match open until they come back or their window ends.
  return loneAway(s) ? { ...s, deadline: nowMs + content.timing.revealMs } : { ...s, phase: 'over' };
}

export function afterOutage(s: MentalistaState, content: MentalistaContent, nowMs: number): MentalistaState {
  if (s.phase === 'choose') return { ...s, deadline: nowMs + content.timing.chooseMs };
  if (s.phase === 'predict') return { ...s, deadline: nowMs + content.timing.predictMs };
  return s;
}

/** Seat changes that arrive together, then one terminal check. Phase advancement is left to the following tick. */
export function seatsChanged(s: MentalistaState, changes: readonly RoomSeatChange[]): MentalistaState {
  if (s.phase === 'over' || s.phase === 'cancelled') return s;
  const status = [...s.status];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
  }
  return settleTerminal({ ...s, status });
}

export function applyCommand(s: MentalistaState, content: MentalistaContent, seat: number, cmd: MentalistaCommand, nowMs: number): { state: MentalistaState; error?: string } {
  if (s.phase === 'over' || s.phase === 'cancelled') return { state: s, error: 'not_active' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  // Round- and phase-scoped: a command naming another round, or arriving in the wrong phase, is refused outright.
  if (cmd.round !== s.round) return { state: s, error: 'stale_round' };
  const category = content.categories[s.round];
  if (cmd.option >= category.options.length) return { state: s, error: 'illegal_option' };
  if (nowMs >= s.deadline) return { state: s, error: 'not_open' };

  if (cmd.type === 'choose') {
    if (seat !== chooserOf(s)) return { state: s, error: 'not_chooser' };
    if (s.phase !== 'choose') return { state: s, error: 'wrong_phase' };
    if (s.committed) return { state: s, error: 'already_chosen' };
    return { state: { ...s, choice: cmd.option, committed: true } };
  }
  // predict
  if (seat === chooserOf(s)) return { state: s, error: 'chooser_cannot_predict' };
  if (s.phase !== 'predict') return { state: s, error: 'wrong_phase' };
  // Final, no revisions: a second prediction — even under a fresh command id — is rejected.
  if (s.predictions[seat] !== null) return { state: s, error: 'already_predicted' };
  return { state: { ...s, predictions: replace(s.predictions, seat, cmd.option) } };
}

/** Points first; equal points share a place; seats that left rank below everyone who stayed. */
export function standings(s: MentalistaState): RoomEngineStanding[] {
  const points = totals(s);
  const wins = matches(s);
  const order = s.status.map((st, seat) => ({ seat, out: st === 'withdrawn', points: points[seat] }))
    .sort((a, b) => Number(a.out) - Number(b.out) || b.points - a.points || a.seat - b.seat);
  const place = new Map<number, number>();
  order.forEach((x, i) => {
    const prev = order[i - 1];
    place.set(x.seat, prev && prev.out === x.out && prev.points === x.points ? place.get(prev.seat)! : i + 1);
  });
  return s.status.map((_, seat) => ({ seat, points: points[seat], roundWins: wins[seat], place: place.get(seat)! }));
}

export interface MentalistaView {
  phase: 'choose' | 'predict' | 'reveal' | 'over';
  round: number;
  totalRounds: number;
  chooserSeat: number;
  category: MentalistaPublicCategory | null;
  iAmChooser: boolean;
  seats: Array<{ seat: number; status: RoomSeatStatus; isChooser: boolean; committed: boolean; predicted: boolean; score: number }>;
  mySeat: number;
  /** The author's own secret, for them alone: the chooser's committed pick, else null. */
  myChoice: number | null;
  /** The author's own locked prediction, for them alone, else null. */
  myPrediction: number | null;
  reveal: MentalistaResult | null;
  results: MentalistaResult[];
  standings: RoomEngineStanding[] | null;
  deadline: string | null;
}

/**
 * What `seat` sees. A non-author learns only public facts — the category, who the chooser is, and per-seat booleans
 * for whether a pick/prediction is in — never the value of another seat's open secret. So two states that differ only
 * in another seat's open choice or prediction (same phase, same deadline, same status) are indistinguishable here.
 * Only banked (revealed) rounds carry targets and predictions; an open round's secret is never leaked, including when
 * the match is over or cancelled.
 */
export function viewOf(s: MentalistaState, content: MentalistaContent, seat: number, locale: string): MentalistaView {
  const points = totals(s);
  const chooser = chooserOf(s);
  const open = s.phase === 'choose' || s.phase === 'predict';
  const category = s.phase === 'over' || s.phase === 'cancelled' ? null : publicCategory(content.categories[s.round], locale);
  const last = s.phase === 'reveal' ? s.results[s.results.length - 1] ?? null : null;
  const terminal = s.phase === 'over' || s.phase === 'cancelled';
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    round: s.round,
    totalRounds: totalRounds(s),
    chooserSeat: chooser,
    category,
    iAmChooser: !terminal && seat === chooser,
    seats: s.status.map((status, x) => ({
      seat: x, status,
      isChooser: !terminal && x === chooser,
      // Public booleans only: whether (not what) a seat has committed or locked in the open round.
      committed: open && x === chooser ? s.committed : false,
      predicted: s.phase === 'predict' && x !== chooser && status !== 'withdrawn' ? s.predictions[x] !== null : false,
      score: points[x],
    })),
    mySeat: seat,
    myChoice: open && seat === chooser && s.committed ? s.choice : null,
    myPrediction: s.phase === 'predict' && seat !== chooser ? s.predictions[seat] : null,
    reveal: last,
    results: s.results,
    standings: terminal ? standings(s) : null,
    deadline: terminal ? null : new Date(s.deadline).toISOString(),
  };
}
