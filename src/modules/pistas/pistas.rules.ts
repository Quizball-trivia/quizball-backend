import { CLUES_PER_ROUND, LAST_CHANCE_CLUES, MAX_POINTS_PER_ROUND, MAX_WRONG_GUESSES, ROUNDS_PER_DAY } from './pistas.constants.js';
import { copyClue, copyText, type IndexedRound } from './pistas.content.js';
import { rejected } from './pistas.errors.js';
import { isAcceptedGuess, normalizeAnswer } from './pistas.normalize.js';
import type { PublicRunState, RoundResult, RunState } from './pistas.types.js';

export function newState(): RunState {
  return { v: 1, r: 0, n: 1, g: 0, c: null, s: null, res: [], done: false };
}

/** Only the known fields. */
const pack = (s: RunState): RunState => ({ v: 1, r: s.r, n: s.n, g: s.g, c: s.c, s: s.s, res: s.res, done: s.done });

export const pointsFor = (revealed: number): number => MAX_POINTS_PER_ROUND + 1 - revealed;

export const canReveal = (s: RunState): boolean =>
  !s.done && s.s === null && s.n < CLUES_PER_ROUND && (s.c === null || s.n < s.c);

function assertOpen(s: RunState): void {
  if (s.done) throw rejected('run_done');
  if (s.s) throw rejected('round_settled');
}

/** Settling appends the result at once; the 10th settled round finishes the run in the same write. */
function settle(s: RunState, result: RoundResult, totalRounds: number): RunState {
  const res = [...s.res, result];
  return pack({ ...s, s: result, res, done: res.length >= totalRounds });
}

export function reveal(s: RunState): RunState {
  assertOpen(s);
  if (!canReveal(s)) throw rejected('no_more_clues');
  return pack({ ...s, n: s.n + 1 });
}

/**
 * Right → solved for 11 − n. The first miss opens the last chance: at most LAST_CHANCE_CLUES more
 * clues (never past the last) and one more guess. The second miss settles the round as missed.
 */
export function guess(s: RunState, round: IndexedRound, text: string, totalRounds: number): { state: RunState; correct: boolean } {
  assertOpen(s);
  if (s.g >= MAX_WRONG_GUESSES) throw rejected('guess_limit');
  const normalized = normalizeAnswer(text);
  // The route only admits guesses with a letter or digit; nothing else can match an answer.
  if (normalized.length === 0) throw rejected('empty_guess');
  if (isAcceptedGuess(round.accepted, normalized)) {
    return { correct: true, state: settle(s, { outcome: 'solved', clues: s.n, points: pointsFor(s.n) }, totalRounds) };
  }
  const g = s.g + 1;
  if (g >= MAX_WRONG_GUESSES) return { correct: false, state: settle({ ...s, g }, { outcome: 'missed', clues: s.n, points: 0 }, totalRounds) };
  return { correct: false, state: pack({ ...s, g, c: Math.min(CLUES_PER_ROUND, s.n + LAST_CHANCE_CLUES) }) };
}

export function giveUp(s: RunState, totalRounds: number): RunState {
  assertOpen(s);
  return settle(s, { outcome: 'missed', clues: s.n, points: 0 }, totalRounds);
}

export function next(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.s) throw rejected('round_not_settled');
  return pack({ ...s, r: s.r + 1, n: 1, g: 0, c: null, s: null });
}

/**
 * The state an unfinished run keeps when a correction moves it onto new content. A settled round moves
 * on first: its answer on the new content is one the player never typed.
 */
export const rebase = (s: RunState): RunState => (s.s && !s.done ? next(s) : pack(s));

export const score = (s: RunState): number => s.res.reduce((sum, r) => sum + r.points, 0);

export const solved = (s: RunState): number => s.res.filter((r) => r.outcome === 'solved').length;

/**
 * Only the revealed clues of the current round. A settled round shows its answer when the player
 * solved it (they typed it), or when `disclose` allows (the day is closed by the database clock).
 */
export function publicState(s: RunState, day: string, round: IndexedRound | null, extra: { ranked: boolean; disclose: boolean; rank?: number }): PublicRunState {
  const showAnswer = s.s !== null && round !== null && (s.s.outcome === 'solved' || extra.disclose);
  return {
    day,
    round: s.r,
    totalRounds: ROUNDS_PER_DAY,
    clues: round ? round.clues.slice(0, s.n).map(copyClue) : [],
    revealed: s.n,
    pointsInPlay: pointsFor(s.n),
    wrongGuesses: s.g > 0 ? 1 : 0,
    ceiling: s.c,
    canReveal: canReveal(s),
    settled: s.s ? { outcome: s.s.outcome, clues: s.s.clues, points: s.s.points, answer: showAnswer ? { display: copyText(round!.display) } : null } : null,
    results: s.res.map((r) => ({ outcome: r.outcome, clues: r.clues, points: r.points })),
    done: s.done,
    score: score(s),
    solved: solved(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
