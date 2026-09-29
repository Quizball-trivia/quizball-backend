import { z } from 'zod';
import { isAcceptedGuess, normalizeAnswer } from '../../pistas/pistas.normalize.js';
import { CLUE_KINDS } from '../../pistas/pistas.types.js';
import {
  other, reject,
  type DuelCtx, type DuelEngine, type DuelLocale, type EngineOutcome, type LocalizedText, type Scores, type Seat, type Step,
} from '../duel.types.js';

export const PD_ROUNDS = 10;
export const PD_CLUES = 10;
/** A wrong guess leaves the rival at most this many more clues (Davo: "como máximo tres pistas más"). */
export const PD_LAST_CHANCE = 3;
export const PD_WINDOW_MS = 45_000;
/** Once one seat asked for the next clue, the other has at most this long left in the window. */
export const PD_AFTER_PASS_MS = 15_000;
export const PD_REVEAL_MS = 5_000;
/** Whole windows in a row without any action that count as leaving the match. */
export const PD_IDLE_FORFEIT = 3;
export const PD_GUESS_MAX = 60;

const pointsAt = (clue: number): number => PD_CLUES + 1 - clue;

const text = z.string().trim().min(1).max(400);
const localized = z.object({ es: text, en: text, ka: text, tr: text });

/** One pool item: a hidden player with 10 clues; `accepted` is normalised when parsed. */
export const pistasRoundSchema = z.object({
  id: z.string().min(1).max(64),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  clues: z.array(z.object({ kind: z.enum(CLUE_KINDS), icon: z.string().min(1).max(32).nullable(), text: localized })).length(PD_CLUES),
  answer: z.object({ display: localized, accepted: z.array(z.string().min(1).max(PD_GUESS_MAX)).min(1) }),
}).transform((round) => ({
  ...round,
  answer: { display: round.answer.display, accepted: [...new Set(round.answer.accepted.map(normalizeAnswer).filter(Boolean))] },
}));

const contentSchema = z.object({ rounds: z.array(pistasRoundSchema).length(PD_ROUNDS) });

export type PistasDuelContent = z.infer<typeof contentSchema>;

export const pistasCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('guess'), round: z.number().int().min(0).max(PD_ROUNDS - 1), text: z.string().max(PD_GUESS_MAX) }),
  /** A vote for the next clue; not binding: the seat may still guess until the next clue opens. */
  z.object({ type: z.literal('pass'), round: z.number().int().min(0).max(PD_ROUNDS - 1), clue: z.number().int().min(1).max(PD_CLUES) }),
]);
export type PistasCommand = z.infer<typeof pistasCommandSchema>;

export interface PistasSeatRound {
  locked: boolean;
  passed: boolean;
  /** Did anything in the open window (a pass or a guess). */
  acted: boolean;
  wrong: string | null;
}

export interface PistasRoundResult { winner: Seat | null; clue: number; points: number }

export interface PistasDuelState {
  v: 1;
  phase: 'clue' | 'reveal' | 'over';
  r: number;
  /** The open clue, 1-based. */
  n: number;
  /** Last clue this round can reach: 10, or min(10, n + 3) after the first wrong guess. */
  ceiling: number;
  seats: [PistasSeatRound, PistasSeatRound];
  /** The open window was already cut to PD_AFTER_PASS_MS by a pass. */
  shortened: boolean;
  settled: PistasRoundResult | null;
  scores: Scores;
  results: PistasRoundResult[];
  idle: [number, number];
  idleSeat: Seat | null;
}

const freshSeat = (): PistasSeatRound => ({ locked: false, passed: false, acted: false, wrong: null });

const openWindow = (s: PistasDuelState, n: number): Step<PistasDuelState> => ({
  state: {
    ...s,
    n,
    shortened: false,
    seats: s.seats.map((seat) => (seat.locked ? seat : { ...seat, passed: false, acted: false })) as PistasDuelState['seats'],
  },
  phase: { ms: PD_WINDOW_MS },
});

function settle(s: PistasDuelState, winner: Seat | null): Step<PistasDuelState> {
  const points = winner === null ? 0 : pointsAt(s.n);
  const result: PistasRoundResult = { winner, clue: s.n, points };
  const scores: Scores = [...s.scores];
  if (winner !== null) scores[winner] += points;
  return { state: { ...s, phase: 'reveal', settled: result, results: [...s.results, result], scores }, phase: { ms: PD_REVEAL_MS } };
}

const eligible = (s: PistasDuelState): Seat[] => ([0, 1] as Seat[]).filter((seat) => !s.seats[seat].locked);

/** Every seat still in the round asked for more: open the next clue, or end the round at the ceiling. */
function advanceIfAllPassed(s: PistasDuelState): Step<PistasDuelState> | null {
  const open = eligible(s);
  if (open.length === 0) return settle(s, null);
  if (!open.every((seat) => s.seats[seat].passed)) return null;
  return s.n < s.ceiling ? openWindow(s, s.n + 1) : settle(s, null);
}

const withSeat = (s: PistasDuelState, seat: Seat, patch: Partial<PistasSeatRound>): PistasDuelState['seats'] => {
  const seats = [...s.seats] as PistasDuelState['seats'];
  seats[seat] = { ...seats[seat], ...patch };
  return seats;
};

const withIdle = (s: PistasDuelState, seat: Seat, value: number): [number, number] => {
  const idle: [number, number] = [...s.idle];
  idle[seat] = value;
  return idle;
};

const textFor = (value: LocalizedText, locale: DuelLocale): string => value[locale] ?? value.es;

export const pistasDuelEngine: DuelEngine<PistasDuelContent, PistasDuelState, PistasCommand> = {
  game: 'pistas',
  version: 1,
  commandSchema: pistasCommandSchema,

  parseContent: (value) => contentSchema.parse(value),

  start() {
    return {
      state: {
        v: 1, phase: 'clue', r: 0, n: 1, ceiling: PD_CLUES, seats: [freshSeat(), freshSeat()], shortened: false,
        settled: null, scores: [0, 0], results: [], idle: [0, 0], idleSeat: null,
      },
      phase: { ms: PD_WINDOW_MS },
    };
  },

  apply(s, content, seat, command, ctx: DuelCtx) {
    if (s.phase !== 'clue') reject('round_over');
    if (command.round !== s.r) reject('stale_round');
    if (s.seats[seat].locked) reject('locked_out');
    const idle = withIdle(s, seat, 0);

    if (command.type === 'guess') {
      const guess = normalizeAnswer(command.text);
      if (!guess) reject('empty_guess');
      const acted: PistasDuelState = { ...s, idle, seats: withSeat(s, seat, { acted: true }) };
      if (isAcceptedGuess(content.rounds[s.r].answer.accepted, guess)) return settle(acted, seat);
      const wrong = command.text.trim().slice(0, PD_GUESS_MAX);
      const locked: PistasDuelState = {
        ...acted,
        seats: withSeat(acted, seat, { locked: true, wrong }),
        ceiling: acted.seats[other(seat)].locked ? acted.ceiling : Math.min(acted.ceiling, PD_CLUES, s.n + PD_LAST_CHANCE),
      };
      return advanceIfAllPassed(locked) ?? { state: locked, phase: 'keep' };
    }

    if (command.clue !== s.n) reject('stale_clue');
    if (s.seats[seat].passed) return { state: { ...s, idle }, phase: 'keep' };
    const passed: PistasDuelState = { ...s, idle, seats: withSeat(s, seat, { passed: true, acted: true }) };
    const advanced = advanceIfAllPassed(passed);
    if (advanced) return advanced;
    if (passed.shortened) return { state: passed, phase: 'keep' };
    return { state: { ...passed, shortened: true }, phase: { ms: Math.min(ctx.remainingMs, PD_AFTER_PASS_MS) } };
  },

  expire(s) {
    if (s.phase === 'over') reject('game_over');
    if (s.phase === 'reveal') {
      const r = s.r + 1;
      if (r >= PD_ROUNDS) return { state: { ...s, phase: 'over' }, phase: null };
      return {
        state: { ...s, phase: 'clue', r, n: 1, ceiling: PD_CLUES, seats: [freshSeat(), freshSeat()], shortened: false, settled: null },
        phase: { ms: PD_WINDOW_MS },
      };
    }
    let idle: [number, number] = [...s.idle];
    let seats = s.seats;
    for (const seat of eligible(s)) {
      if (!s.seats[seat].acted) idle = [seat === 0 ? idle[0] + 1 : idle[0], seat === 1 ? idle[1] + 1 : idle[1]];
      seats = withSeat({ ...s, seats }, seat, { passed: true });
    }
    const gone = ([0, 1] as Seat[]).filter((seat) => idle[seat] >= PD_IDLE_FORFEIT);
    if (gone.length > 0) {
      return { state: { ...s, idle, seats, phase: 'over', idleSeat: gone.length === 1 ? gone[0] : null }, phase: null };
    }
    const expired: PistasDuelState = { ...s, idle, seats };
    return s.n < s.ceiling ? openWindow(expired, s.n + 1) : settle(expired, null);
  },

  view(s, content, _seat, locale) {
    const round = content.rounds[Math.min(s.r, PD_ROUNDS - 1)];
    return {
      phase: s.phase,
      round: s.r,
      totalRounds: PD_ROUNDS,
      difficulty: round.difficulty,
      clue: s.n,
      ceiling: s.ceiling,
      pointsInPlay: pointsAt(s.n),
      clues: round.clues.slice(0, s.n).map((c) => ({ kind: c.kind, icon: c.icon, text: textFor(c.text, locale) })),
      seats: s.seats.map((seat) => ({ locked: seat.locked, passed: seat.passed, wrong: seat.wrong })),
      settled: s.settled ? { ...s.settled, answer: textFor(round.answer.display, locale) } : null,
      results: s.results,
      scores: s.scores,
      idle: s.idle,
    };
  },

  outcome: (s): EngineOutcome | null => (s.phase === 'over' ? { scores: s.scores, idle: s.idleSeat } : null),
  scores: (s) => s.scores,
};
