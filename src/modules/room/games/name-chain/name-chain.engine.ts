import { z } from 'zod';
import type { Universe } from '../../../footballers/footballers.universe.js';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';
import { draw, examplesOn, judge, letterExhausted, pickStart, type Verdict } from './name-chain.core.js';

/**
 * The footballer name chain as a room game (2–6 seats), pure: time comes in as `now` (the database clock read under
 * the match lock) and every random pick comes from the pack's seed and a counter kept in the state.
 *
 * Seats take turns. The seat on turn types a footballer whose first name or surname starts with the last letter of the
 * previous footballer's known name. A wrong answer costs only the time it took; when the clock runs out, or the seat
 * gives up, it is out of the round. The last seat in takes the round and a point; first to ROUNDS_TO_WIN points,
 * MAX_ROUNDS at most (then the table decides; level = shared first place).
 */
export const TURN_MS = 10_000;
export const INTRO_MS = 3_000;
export const ROUND_END_MS = 5_000;
export const ROUNDS_TO_WIN = 3;
export const MAX_ROUNDS = 9;
/** Rooms open with start names of this half; the daily keeps the other. */
const ROOM_START_BUCKET = 1;
const MAX_TEXT = 60;
const EXAMPLES = 5;

export const nameChainPackSchema = z.object({ release: z.string().min(3).max(40), seed: z.number().int().min(0).max(0xffffffff) }).strict();
export type NameChainPack = z.infer<typeof nameChainPackSchema>;
/** The stored pack, plus (in memory only) the footballers of its release. */
export interface NameChainContent { pack: NameChainPack; universe: Universe | null }

export const nameChainCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('answer'),
    /** The turn this answer is for (from the view): it changes on every answer taken, every lost turn and every round. */
    epoch: z.number().int().min(0).max(100_000),
    /** The attempt number inside that turn: a repeated or late send can never be judged twice. */
    attempt: z.number().int().min(0).max(1_000),
    text: z.string().min(1).max(MAX_TEXT),
  }).strict(),
  z.object({ type: z.literal('pass'), epoch: z.number().int().min(0).max(100_000) }).strict(),
]);
export type NameChainCommand = z.infer<typeof nameChainCommandSchema>;

export type Phase = 'intro' | 'turn' | 'roundEnd' | 'over' | 'cancelled';
export interface ChainLink { pid: string; by: number | null }
export interface Feedback { epoch: number; attempt: number; seat: number; kind: Verdict; text: string; pid: string | null }
export type LostTurn = { seat: number; reason: 'time' | 'pass' | 'left' };

export interface NameChainState extends RoomEngineState {
  phase: Phase;
  round: number;
  /** Rounds won: the table. */
  points: number[];
  /** Still in this round. */
  alive: boolean[];
  /** This round's chain; a link by null is a name the game supplied. */
  chain: ChainLink[];
  /** Every footballer used in the match: a name never comes back in a later round. */
  used: string[];
  letter: string;
  turn: number;
  epoch: number;
  attempts: number;
  /** Accepted answers per seat. */
  answers: number[];
  last: Feedback | null;
  ended: LostTurn | null;
  roundWinner: number | null;
  /** Random draws taken so far (start names): the next pick uses the next one. */
  draws: number;
  /** Rounds that ended with a winner. */
  roundsWon: number;
  /** Seats that left while the match was still open: they rank below everyone who stayed. */
  quit: boolean[];
}

export type CommandError = 'stale_turn' | 'not_open' | 'not_your_turn' | 'withdrawn' | 'stale_attempt' | 'invalid';

const fill = <T>(seats: number, value: T): T[] => Array.from({ length: seats }, () => value);
const bump = (list: readonly number[], seat: number, by: number): number[] => list.map((v, i) => (i === seat ? v + by : v));
const ended = (s: NameChainState) => s.phase === 'over' || s.phase === 'cancelled';
const universeOf = (content: NameChainContent): Universe => {
  if (!content.universe) throw new Error('name_chain content is not hydrated');
  return content.universe;
};

export function startMatch(seats: number, now: number): NameChainState {
  if (seats < 2 || seats > 6) throw new Error('A room match needs 2 to 6 admitted seats');
  return {
    phase: 'intro', round: 0, deadline: now + INTRO_MS, status: fill(seats, 'in'), points: fill(seats, 0), alive: fill(seats, true), chain: [], used: [],
    letter: '', turn: 0, epoch: 0, attempts: 0, answers: fill(seats, 0), last: null, ended: null, roundWinner: null, draws: 0, roundsWon: 0, quit: fill(seats, false),
  };
}

/** True once the round on screen decided the match: nothing follows it. */
export function matchOver(s: NameChainState): boolean {
  return s.points.some((p) => p >= ROUNDS_TO_WIN) || s.round + 1 >= MAX_ROUNDS;
}
const decided = (s: NameChainState) => s.phase === 'over' || (s.phase === 'roundEnd' && matchOver(s));

/** The next seat still in the round after `seat`, going round the table. */
function nextAlive(alive: readonly boolean[], seat: number): number {
  for (let step = 1; step <= alive.length; step += 1) {
    const candidate = (seat + step) % alive.length;
    if (alive[candidate]) return candidate;
  }
  return seat;
}

function beginRound(s: NameChainState, content: NameChainContent, round: number, now: number): NameChainState {
  const universe = universeOf(content);
  const start = pickStart(universe, new Set(s.used), ROOM_START_BUCKET, draw(content.pack.seed, s.draws));
  // Nobody left to start from (it would take a match of thousands of names): the table decides.
  if (start === null) return { ...s, phase: 'over' };
  const alive = s.status.map((status) => status !== 'withdrawn');
  const opener = alive[round % alive.length] ? round % alive.length : nextAlive(alive, round % alive.length);
  return {
    ...s, phase: 'turn', round, chain: [{ pid: start, by: null }], used: [...s.used, start], letter: universe.last(start), alive, turn: opener,
    epoch: s.epoch + 1, attempts: 0, deadline: now + TURN_MS, last: null, ended: null, roundWinner: null, draws: s.draws + 1,
  };
}

/** One seat is left in the round: it takes the point and the round closes. */
function closeRound(s: NameChainState, alive: boolean[], now: number): NameChainState {
  const survivor = alive.indexOf(true);
  return {
    ...s, alive, phase: 'roundEnd', epoch: s.epoch + 1, deadline: now + ROUND_END_MS, roundWinner: survivor >= 0 ? survivor : null,
    points: survivor >= 0 ? bump(s.points, survivor, 1) : s.points, roundsWon: s.roundsWon + (survivor >= 0 ? 1 : 0),
  };
}

/** The seat on turn lost it: out of the round; the chain goes on from the same letter with a fresh clock. */
function loseTurn(s: NameChainState, lost: LostTurn, now: number): NameChainState {
  const alive = s.alive.map((a, i) => a && i !== lost.seat);
  if (alive.filter(Boolean).length <= 1) return closeRound({ ...s, ended: lost }, alive, now);
  return { ...s, alive, ended: lost, turn: nextAlive(alive, lost.seat), epoch: s.epoch + 1, attempts: 0, deadline: now + TURN_MS };
}

export function tick(s: NameChainState, content: NameChainContent, now: number): NameChainState {
  if (ended(s) || now < s.deadline) return s;
  if (s.phase === 'intro') return beginRound(s, content, 0, now);
  if (s.phase === 'turn') return loseTurn(s, { seat: s.turn, reason: 'time' }, now);
  return matchOver(s) ? { ...s, phase: 'over' } : beginRound(s, content, s.round + 1, now);
}

/** After an outage the open turn (or the intro) starts its window again. */
export function afterOutage(s: NameChainState, now: number): NameChainState {
  if (s.phase === 'intro') return { ...s, deadline: now + INTRO_MS };
  if (s.phase === 'turn') return { ...s, deadline: now + TURN_MS };
  return s;
}

/**
 * Seat changes that arrive together, at `now`. A seat that leaves is out of the round (its turn passes on at once)
 * and of the match; fewer than two seats left ends it: a result once a round was won, otherwise cancelled. Once the
 * deciding round is over nothing changes the result. An away seat keeps its turn: its clock simply runs.
 */
export function seatsChanged(s: NameChainState, changes: readonly RoomSeatChange[], now: number): NameChainState {
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
  let next: NameChainState = { ...s, status, quit };
  if (!open || left.length === 0) return next;
  const live = status.filter((st) => st !== 'withdrawn').length;
  if (live < 2) return { ...next, phase: live === 0 || s.roundsWon === 0 ? 'cancelled' : 'over' };
  if (next.phase !== 'turn') return next;
  const alive = next.alive.map((a, i) => a && !left.includes(i));
  if (alive.filter(Boolean).length <= 1) return closeRound({ ...next, ended: left.includes(next.turn) ? { seat: next.turn, reason: 'left' } : next.ended }, alive, now);
  next = { ...next, alive };
  return left.includes(next.turn) ? { ...next, ended: { seat: next.turn, reason: 'left' }, turn: nextAlive(alive, next.turn), epoch: next.epoch + 1, attempts: 0, deadline: now + TURN_MS } : next;
}

export function applyCommand(s: NameChainState, content: NameChainContent, seat: number, command: NameChainCommand, now: number): { state: NameChainState; error?: CommandError } {
  if (s.phase === 'turn' && command.epoch !== s.epoch) return { state: s, error: 'stale_turn' };
  // Same boundary as tick(): at the deadline the turn is lost, whichever runs first.
  if (s.phase !== 'turn' || now >= s.deadline) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (s.turn !== seat) return { state: s, error: 'not_your_turn' };
  if (command.type === 'pass') return { state: loseTurn(s, { seat, reason: 'pass' }, now) };
  if (command.attempt !== s.attempts) return { state: s, error: 'stale_attempt' };
  const text = command.text.trim();
  if (!text) return { state: s, error: 'invalid' };
  const universe = universeOf(content);
  const used = new Set(s.used);
  const judged = judge(universe, used, s.letter, text);
  const feedback: Feedback = { epoch: s.epoch, attempt: command.attempt, seat, kind: judged.verdict, text, pid: judged.pid };
  // A wrong answer costs only the time it took: the clock keeps running and the seat can try again.
  if (judged.verdict !== 'ok' || judged.pid === null) return { state: { ...s, attempts: s.attempts + 1, last: feedback } };

  used.add(judged.pid);
  let chain = [...s.chain, { pid: judged.pid, by: seat }];
  let letter = universe.last(judged.pid);
  let draws = s.draws;
  // Nobody left on this letter: the game supplies a fresh name, nobody is penalised, used names stay used.
  if (letterExhausted(universe, used, letter)) {
    const fresh = pickStart(universe, used, ROOM_START_BUCKET, draw(content.pack.seed, draws));
    draws += 1;
    if (fresh === null) return { state: { ...s, chain, used: [...used], answers: bump(s.answers, seat, 1), last: feedback, draws, phase: 'over' } };
    used.add(fresh);
    chain = [...chain, { pid: fresh, by: null }];
    letter = universe.last(fresh);
  }
  return {
    state: {
      ...s, chain, used: [...used], letter, answers: bump(s.answers, seat, 1), turn: nextAlive(s.alive, seat), epoch: s.epoch + 1, attempts: 0,
      deadline: now + TURN_MS, last: feedback, ended: null, draws,
    },
  };
}

/** The table, best first; places are shared on ties and seats that quit rank below everyone who stayed. */
export function standings(s: NameChainState): RoomEngineStanding[] {
  const rows = s.points.map((points, seat) => ({ seat, points, answers: s.answers[seat], quit: s.quit[seat] }));
  const stayed = rows.filter((r) => !r.quit);
  return rows
    .sort((a, b) => Number(a.quit) - Number(b.quit) || b.points - a.points || b.answers - a.answers || a.seat - b.seat)
    // The stat shown beside the points is the names a seat said (the points already are the rounds won).
    .map((r) => ({ seat: r.seat, points: r.points, roundWins: r.answers, place: r.quit ? stayed.length + 1 : 1 + stayed.filter((o) => o.points > r.points).length }));
}

/** What a seat sees. The chain and every typed answer are public: there is nothing here to hide but the next letter's answers. */
export function viewOf(s: NameChainState, content: NameChainContent, seat: number) {
  const universe = universeOf(content);
  const nameOf = (pid: string | null) => (pid === null ? null : universe.player(pid)?.name ?? null);
  const over = ended(s);
  const last = s.last && {
    epoch: s.last.epoch, attempt: s.last.attempt, seat: s.last.seat, kind: s.last.kind, text: s.last.text, name: nameOf(s.last.pid),
    starts: s.last.pid && s.last.kind === 'letter' ? [...universe.starts(s.last.pid)] : [],
  };
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    round: s.round,
    maxRounds: MAX_ROUNDS,
    pointsToWin: ROUNDS_TO_WIN,
    format: s.status.length === 2 ? 'duel' : 'party',
    turnMs: TURN_MS,
    letter: s.letter,
    turn: s.phase === 'turn' ? s.turn : null,
    epoch: s.epoch,
    attempt: s.attempts,
    chain: s.chain.map((link) => ({ name: nameOf(link.pid) ?? '', game: universe.player(link.pid)?.game ?? '', by: link.by })),
    seats: s.status.map((status, i) => ({ seat: i, status, alive: s.alive[i], score: s.points[i], answers: s.answers[i] })),
    mySeat: seat,
    last,
    ended: s.ended,
    roundWinner: s.phase === 'roundEnd' || over ? s.roundWinner : null,
    // Shown once a turn was lost: what could have been said on the letter.
    could: s.phase === 'roundEnd' && s.letter ? examplesOn(universe, new Set(s.used), s.letter, EXAMPLES) : [],
    final: decided(s),
    standings: s.phase === 'over' ? standings(s) : null,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
