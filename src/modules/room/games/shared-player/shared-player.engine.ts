import { z } from 'zod';
import type { Universe } from '../../../footballers/footballers.universe.js';
import type { RoomEngineStanding, RoomEngineState, RoomSeatChange } from '../../room.engine.js';
import type { RoomLocale } from '../../room.types.js';

/**
 * "Played for both" as a room game, pure (time comes in as `now`, the database clock read under the match lock).
 * Two clubs are shown and every seat races to name a footballer who played for both.
 *  - 2 seats: the first right answer takes the point; a second one inside TIE_MS shares it. First to POINTS_TO_WIN
 *    with a different score, DUEL_ROUNDS at most (level then = a draw).
 *  - 3–6 seats: everyone may answer until the clock runs out; points by the order of the right answers
 *    (PARTY_POINTS), PARTY_ROUNDS rounds.
 * Order means the order the server committed the answers in.
 */
export const COUNTDOWN_MS = 3_000;
export const RACE_MS = 10_000;
export const REVEAL_MS = 5_000;
/** A wrong answer blocks that seat for a moment, so typing every name you know is not a strategy. */
export const WRONG_LOCK_MS = 1_000;
export const TIE_MS = 300;
export const POINTS_TO_WIN = 3;
export const DUEL_ROUNDS = 10;
export const PARTY_ROUNDS = 8;
/** Points for the first, second and every later right answer of a round. */
export const PARTY_POINTS = [3, 2, 1] as const;
export const PACK_PAIRS = 10;
const EXAMPLES = 6;
const MAX_TEXT = 60;

const localized = z.object({ es: z.string().min(1).max(60), en: z.string().min(1).max(60), ka: z.string().min(1).max(60), tr: z.string().min(1).max(60) }).strict();
const clubSchema = z.object({ key: z.string().min(1).max(64), label: localized, crest: z.string().min(1).max(200) }).strict();

/** One private pool pair. `accepted` (footballer ids, the reviewed examples first) never reaches a client before the reveal. */
export const sharedPlayerItemSchema = z.object({
  id: z.string().min(1).max(64),
  release: z.string().min(3).max(40),
  a: clubSchema,
  b: clubSchema,
  accepted: z.array(z.string().min(1).max(64)).min(3).max(2_000),
  examples: z.number().int().min(0).max(2_000),
}).strict();
export type SharedPlayerItem = z.infer<typeof sharedPlayerItemSchema>;

export const sharedPlayerPackSchema = z.object({ release: z.string().min(3).max(40), pairs: z.array(sharedPlayerItemSchema).length(PACK_PAIRS) }).strict()
  .refine((pack) => pack.pairs.every((pair) => pair.release === pack.release), 'one release per pack');
export type SharedPlayerPack = z.infer<typeof sharedPlayerPackSchema>;

/** The stored pack, plus (in memory only) the footballers of its release. */
export interface SharedPlayerContent { pack: SharedPlayerPack; universe: Universe | null }

export const sharedPlayerCommandSchema = z.object({
  type: z.literal('answer'),
  round: z.number().int().min(0).max(50),
  /** This seat's attempt number in the round (from the view): a repeated or late send can never be judged twice. */
  attempt: z.number().int().min(0).max(1_000),
  text: z.string().min(1).max(MAX_TEXT),
}).strict();
export type SharedPlayerCommand = z.infer<typeof sharedPlayerCommandSchema>;

export type Phase = 'countdown' | 'race' | 'settle' | 'reveal' | 'over' | 'cancelled';
export interface Feedback { attempt: number; kind: 'ok' | 'wrong'; text: string }
export interface Round {
  /** Seats that scored, in the order they answered. */
  winners: number[];
  /** The accepted footballer (id) per seat, or null. */
  answers: Array<string | null>;
  gains: number[];
}

export interface SharedPlayerState extends RoomEngineState {
  phase: Phase;
  /** 0-based pair index. */
  round: number;
  scores: number[];
  hits: Array<string | null>;
  order: number[];
  lockedUntil: number[];
  attempts: number[];
  last: Array<Feedback | null>;
  results: Round[];
  /** Seats that left while the match was still open: they rank below everyone who stayed. */
  quit: boolean[];
}

export type AnswerError = 'stale_round' | 'not_open' | 'withdrawn' | 'already_answered' | 'stale_attempt' | 'locked' | 'invalid';

const fill = <T>(seats: number, value: T): T[] => Array.from({ length: seats }, () => value);
const isDuel = (s: SharedPlayerState) => s.status.length === 2;
const ended = (s: SharedPlayerState) => s.phase === 'over' || s.phase === 'cancelled';
const partyPoints = (position: number): number => PARTY_POINTS[Math.min(position, PARTY_POINTS.length - 1)];
export const totalRounds = (s: SharedPlayerState): number => (isDuel(s) ? DUEL_ROUNDS : PARTY_ROUNDS);

export function startMatch(seats: number, now: number): SharedPlayerState {
  if (seats < 2 || seats > 6) throw new Error('A room match needs 2 to 6 admitted seats');
  return {
    phase: 'countdown', round: 0, deadline: now + COUNTDOWN_MS, status: fill(seats, 'in'), scores: fill(seats, 0), hits: fill(seats, null), order: [],
    lockedUntil: fill(seats, 0), attempts: fill(seats, 0), last: fill(seats, null), results: [], quit: fill(seats, false),
  };
}

/** True once the round on screen is the last one: nothing follows its reveal. */
export function matchOver(s: SharedPlayerState): boolean {
  const played = s.round + 1;
  if (!isDuel(s)) return played >= PARTY_ROUNDS;
  const [a, b] = s.scores;
  return played >= DUEL_ROUNDS || (Math.max(a, b) >= POINTS_TO_WIN && a !== b);
}

/** The result is settled: the last round has been revealed (a seat leaving now changes nothing). */
const decided = (s: SharedPlayerState) => s.phase === 'over' || (s.phase === 'reveal' && matchOver(s));

function reveal(s: SharedPlayerState, now: number): SharedPlayerState {
  const gains = fill(s.status.length, 0);
  s.order.forEach((seat, position) => { gains[seat] = isDuel(s) ? 1 : partyPoints(position); });
  return {
    ...s, phase: 'reveal', deadline: now + REVEAL_MS, scores: s.scores.map((score, seat) => score + gains[seat]),
    results: [...s.results, { winners: s.order, answers: s.hits, gains }],
  };
}

function openRound(s: SharedPlayerState, round: number, now: number): SharedPlayerState {
  const seats = s.status.length;
  return { ...s, phase: 'countdown', round, deadline: now + COUNTDOWN_MS, hits: fill(seats, null), order: [], lockedUntil: fill(seats, 0), attempts: fill(seats, 0), last: fill(seats, null) };
}

/** Three or more seats: the round closes early once every connected seat has found a footballer. */
function everyoneIn(s: SharedPlayerState): boolean {
  const here = s.status.flatMap((status, seat) => (status === 'in' ? [seat] : []));
  return here.length > 0 && here.every((seat) => s.hits[seat] !== null);
}

export function tick(s: SharedPlayerState, now: number): SharedPlayerState {
  if (ended(s)) return s;
  if (s.phase === 'race' && !isDuel(s) && everyoneIn(s)) return reveal(s, now);
  if (now < s.deadline) return s;
  if (s.phase === 'countdown') return { ...s, phase: 'race', deadline: now + RACE_MS };
  if (s.phase === 'race' || s.phase === 'settle') return reveal(s, now);
  return matchOver(s) ? { ...s, phase: 'over' } : openRound(s, s.round + 1, now);
}

/** After an outage the open countdown or race starts its window again (answers already in are kept). */
export function afterOutage(s: SharedPlayerState, now: number): SharedPlayerState {
  if (s.phase === 'countdown') return { ...s, deadline: now + COUNTDOWN_MS };
  if (s.phase === 'race') return { ...s, deadline: now + RACE_MS };
  return s;
}

/**
 * Seat changes that arrive together, then one terminal check. Fewer than two seats left: a result once a round was
 * revealed (whoever left ranks last), otherwise cancelled. Once the last round is revealed nothing changes the result.
 */
export function seatsChanged(s: SharedPlayerState, changes: readonly RoomSeatChange[]): SharedPlayerState {
  if (ended(s)) return s;
  const open = !decided(s);
  const status = [...s.status];
  const quit = [...s.quit];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
    if (change === 'leave' && open) quit[seat] = true;
  }
  const next = { ...s, status, quit };
  if (!open) return next;
  const live = status.filter((st) => st !== 'withdrawn').length;
  if (live >= 2) return next;
  return { ...next, phase: live === 0 || s.results.length === 0 ? 'cancelled' : 'over' };
}

export function submitAnswer(s: SharedPlayerState, content: SharedPlayerContent, seat: number, command: SharedPlayerCommand, now: number): { state: SharedPlayerState; error?: AnswerError } {
  const racing = s.phase === 'race' || s.phase === 'settle';
  if (racing && command.round !== s.round) return { state: s, error: 'stale_round' };
  // Same boundary as tick(): at the deadline the race (or the tie window) is closed, whichever runs first.
  if (!racing || now >= s.deadline) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (s.hits[seat] !== null) return { state: s, error: 'already_answered' };
  if (command.attempt !== s.attempts[seat]) return { state: s, error: 'stale_attempt' };
  if (now < s.lockedUntil[seat]) return { state: s, error: 'locked' };
  const text = command.text.trim();
  if (!text) return { state: s, error: 'invalid' };
  if (!content.universe) throw new Error('shared_player content is not hydrated');
  const pair = content.pack.pairs[s.round];
  const pid = content.universe.pickAmong(text, pair.accepted);
  const attempts = s.attempts.map((n, i) => (i === seat ? n + 1 : n));
  const say = (feedback: Feedback) => s.last.map((f, i) => (i === seat ? feedback : f));
  if (pid === null) {
    return { state: { ...s, attempts, lockedUntil: s.lockedUntil.map((t, i) => (i === seat ? now + WRONG_LOCK_MS : t)), last: say({ attempt: command.attempt, kind: 'wrong', text }) } };
  }
  const next: SharedPlayerState = {
    ...s, attempts, hits: s.hits.map((hit, i) => (i === seat ? pid : hit)), order: [...s.order, seat],
    last: say({ attempt: command.attempt, kind: 'ok', text: content.universe.player(pid)?.name ?? text }),
  };
  if (!isDuel(s)) return { state: next };
  // The second right answer inside the tie window: nothing more can happen in this round.
  if (s.phase === 'settle') return { state: reveal(next, now) };
  // The full tie window, even when the first answer came in the race's last moment.
  return { state: { ...next, phase: 'settle', deadline: now + TIE_MS } };
}

/** The table, best first; places are shared on ties and seats that quit rank below everyone who stayed. */
export function standings(s: SharedPlayerState): RoomEngineStanding[] {
  const rows = s.scores.map((points, seat) => ({ seat, points, roundWins: s.results.filter((r) => r.answers[seat] !== null).length, quit: s.quit[seat] }));
  const stayed = rows.filter((r) => !r.quit);
  return rows
    .sort((a, b) => Number(a.quit) - Number(b.quit) || b.points - a.points || a.seat - b.seat)
    .map((r) => ({ seat: r.seat, points: r.points, roundWins: r.roundWins, place: r.quit ? stayed.length + 1 : 1 + stayed.filter((o) => o.points > r.points).length }));
}

type ClubView = { key: string; name: string; crest: string };
const clubView = (club: SharedPlayerItem['a'], locale: RoomLocale): ClubView => ({ key: club.key, name: club.label[locale], crest: club.crest });

/** What `seat` sees. Before a round's reveal: no clubs during the countdown, never an accepted name, never another seat's answer. */
export function viewOf(s: SharedPlayerState, content: SharedPlayerContent, seat: number, locale: RoomLocale) {
  const universe = content.universe;
  if (!universe) throw new Error('shared_player content is not hydrated');
  const nameOf = (pid: string | null) => (pid === null ? null : universe.player(pid)?.name ?? null);
  const pairOf = (round: number) => content.pack.pairs[round];
  const resultView = (r: Round, round: number) => {
    const pair = pairOf(round);
    const shown = pair.accepted.slice(0, Math.min(EXAMPLES, pair.examples || EXAMPLES));
    // An accepted answer outside the examples is shown too, so nobody wonders why it counted.
    const given = r.answers.filter((pid): pid is string => pid !== null && !shown.includes(pid));
    return {
      round, clubs: [clubView(pair.a, locale), clubView(pair.b, locale)], winners: r.winners, answers: r.answers.map(nameOf), gains: r.gains,
      examples: [...new Set([...shown, ...given])].map(nameOf).filter((name): name is string => name !== null), total: pair.accepted.length,
    };
  };
  const racing = s.phase === 'race' || s.phase === 'settle';
  const current = pairOf(s.round);
  const over = ended(s);
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    round: s.round,
    totalRounds: totalRounds(s),
    format: isDuel(s) ? 'duel' : 'party',
    pointsToWin: POINTS_TO_WIN,
    clubs: s.phase === 'countdown' || over ? null : [clubView(current.a, locale), clubView(current.b, locale)],
    // Every crest of the match, sorted: the screen loads them up front, so no reveal waits for an image (and the list
    // says nothing about which clubs meet).
    crests: [...new Set(content.pack.pairs.flatMap((pair) => [pair.a.crest, pair.b.crest]))].sort(),
    seats: s.status.map((status, i) => ({ seat: i, status, answered: racing ? s.hits[i] !== null : false, score: s.scores[i] })),
    mySeat: seat,
    myAttempt: s.attempts[seat],
    myLockedUntil: racing && s.lockedUntil[seat] > 0 ? new Date(s.lockedUntil[seat]).toISOString() : null,
    myHit: racing ? nameOf(s.hits[seat]) : null,
    myLast: racing ? s.last[seat] : null,
    reveal: s.phase === 'reveal' ? resultView(s.results[s.results.length - 1], s.round) : null,
    // Only revealed rounds.
    results: s.results.map(resultView),
    standings: s.phase === 'over' ? standings(s) : null,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
