import { z } from 'zod';
import { duelPoints, goalSchema, MAX_MINUTE, MIN_MINUTE, minuteValue, publicGoal, type PublicGoal } from '../../minuto/minuto.goal.js';
import { reject, type DuelEngine, type EngineOutcome, type Scores, type Seat, type Step } from '../duel.types.js';

export const MD_ROUNDS = 10;
/** Each goal's guess window. Both seats answer inside it; the round settles when both have, or when it ends. */
export const MD_WINDOW_MS = 30_000;
export const MD_REVEAL_MS = 6_000;
/** Goals in a row without a guess that count as leaving the match. */
export const MD_IDLE_FORFEIT = 3;
export const MD_TIERS = ['easy', 'easy', 'medium', 'easy', 'medium', 'medium', 'hard', 'medium', 'hard', 'hard'] as const;

const contentSchema = z.object({ rounds: z.array(goalSchema).length(MD_ROUNDS) })
  .refine((c) => new Set(c.rounds.map((g) => g.fingerprint)).size === MD_ROUNDS && new Set(c.rounds.map((g) => g.id)).size === MD_ROUNDS, 'a goal is dealt twice');
export type MinutoDuelContent = z.infer<typeof contentSchema>;

export const minutoCommandSchema = z.object({
  type: z.literal('guess'),
  round: z.number().int().min(0).max(MD_ROUNDS - 1),
  minute: z.number().int().min(MIN_MINUTE).max(MAX_MINUTE),
});
export type MinutoCommand = z.infer<typeof minutoCommandSchema>;

export interface MinutoRoundResult {
  guesses: [number | null, number | null];
  answer: { base: number; added: number };
  points: [number, number];
}

export interface MinutoDuelState {
  v: 1;
  phase: 'guess' | 'reveal' | 'over';
  r: number;
  /** This round's guesses: private to each seat until the round settles. */
  guesses: [number | null, number | null];
  settled: MinutoRoundResult | null;
  results: MinutoRoundResult[];
  scores: Scores;
  idle: [number, number];
  idleSeat: Seat | null;
}

const SEATS: readonly Seat[] = [0, 1];

function settle(s: MinutoDuelState, content: MinutoDuelContent): Step<MinutoDuelState> {
  const goal = content.rounds[s.r];
  const points = duelPoints(s.guesses, minuteValue(goal.minute));
  const result: MinutoRoundResult = { guesses: [...s.guesses], answer: { base: goal.minute.base, added: goal.minute.added }, points };
  const scores: Scores = [s.scores[0] + points[0], s.scores[1] + points[1]];
  return { state: { ...s, phase: 'reveal', settled: result, results: [...s.results, result], scores }, phase: { ms: MD_REVEAL_MS } };
}

export interface MinutoSeatView { answered: boolean; guess: number | null }

export interface MinutoDuelView {
  phase: MinutoDuelState['phase'];
  round: number;
  totalRounds: number;
  goal: PublicGoal;
  me: MinutoSeatView | null;
  rival: { answered: boolean } | null;
  /** Both seats' answered flags, for a spectator-safe view. */
  answered: [boolean, boolean];
  settled: MinutoRoundResult | null;
  results: MinutoRoundResult[];
  scores: Scores;
  idle: [number, number];
}

/**
 * "¿En qué minuto?" as a friend duel: both seats type a minute for the same goal inside a window; a seat sees only
 * that the rival has answered. The round settles when both answered or the window ends, with the video's points
 * (exact 3, else the closer guess 1, a tie 1 each). A guess is final; the minute is shown only in the reveal.
 */
export const minutoDuelEngine: DuelEngine<MinutoDuelContent, MinutoDuelState, MinutoCommand> = {
  game: 'minuto',
  version: 1,
  commandSchema: minutoCommandSchema,

  parseContent: (value) => contentSchema.parse(value),

  start() {
    return {
      state: { v: 1, phase: 'guess', r: 0, guesses: [null, null], settled: null, results: [], scores: [0, 0], idle: [0, 0], idleSeat: null },
      phase: { ms: MD_WINDOW_MS },
    };
  },

  apply(s, content, seat, command) {
    if (s.phase !== 'guess') reject('round_over');
    if (command.round !== s.r) reject('stale_round');
    if (s.guesses[seat] !== null) reject('already_answered');
    const guesses: [number | null, number | null] = [...s.guesses];
    guesses[seat] = command.minute;
    const idle: [number, number] = [...s.idle];
    idle[seat] = 0;
    const answered: MinutoDuelState = { ...s, guesses, idle };
    // The first guess keeps the window (and its phase token); the second settles the round at once.
    return guesses[0] !== null && guesses[1] !== null ? settle(answered, content) : { state: answered, phase: 'keep' };
  },

  expire(s, content) {
    if (s.phase === 'over') reject('game_over');
    if (s.phase === 'reveal') {
      const r = s.r + 1;
      if (r >= MD_ROUNDS) return { state: { ...s, phase: 'over' }, phase: null };
      return { state: { ...s, phase: 'guess', r, guesses: [null, null], settled: null }, phase: { ms: MD_WINDOW_MS } };
    }
    // The window ended: every seat without a guess gets an idle strike, counted once per goal. The round settles
    // first (a guess that was in still scores), then a seat at the limit forfeits.
    const idle: [number, number] = [s.guesses[0] === null ? s.idle[0] + 1 : 0, s.guesses[1] === null ? s.idle[1] + 1 : 0];
    const settled = settle({ ...s, idle }, content);
    const gone = SEATS.filter((seat) => idle[seat] >= MD_IDLE_FORFEIT);
    // Both gone at once: neither left alone; the match ends on the scores.
    if (gone.length > 0) return { state: { ...settled.state, phase: 'over', idleSeat: gone.length === 1 ? gone[0] : null }, phase: null };
    return settled;
  },

  view(s, content, seat): MinutoDuelView {
    const goal = content.rounds[Math.min(s.r, MD_ROUNDS - 1)];
    const revealed = s.phase !== 'guess';
    return {
      phase: s.phase,
      round: s.r,
      totalRounds: MD_ROUNDS,
      goal: publicGoal(goal),
      me: seat === null ? null : { answered: s.guesses[seat] !== null, guess: s.guesses[seat] },
      rival: seat === null ? null : { answered: s.guesses[seat === 0 ? 1 : 0] !== null },
      answered: [s.guesses[0] !== null, s.guesses[1] !== null],
      settled: revealed ? s.settled : null,
      results: s.results,
      scores: s.scores,
      idle: s.idle,
    };
  },

  outcome: (s): EngineOutcome | null => (s.phase === 'over' ? { scores: s.scores, idle: s.idleSeat } : null),
  scores: (s) => s.scores,
};
