import { GOALS_PER_DAY } from './minuto.constants.js';
import { rejected } from './minuto.errors.js';
import { minuteValue, publicGoal, soloPoints, type MinutoGoal } from './minuto.goal.js';
import type { GoalResult, PublicRunState, RunState } from './minuto.types.js';

export function newState(): RunState {
  return { v: 1, r: 0, res: [], done: false };
}

/** Only the known fields. */
const pack = (s: RunState): RunState => ({ v: 1, r: s.r, res: s.res, done: s.done });

export const isSettled = (s: RunState): boolean => s.res.length > s.r;

const copyResult = (r: GoalResult): GoalResult => ({
  goal: r.goal, guess: r.guess, answer: { base: r.answer.base, added: r.answer.added }, diff: r.diff, points: r.points,
});

/**
 * One guess per goal, final: the result keeps the minute it was judged against, and the tenth guess finishes the
 * run in the same write.
 */
export function guess(s: RunState, goal: MinutoGoal, minute: number, totalGoals: number = GOALS_PER_DAY): RunState {
  if (s.done) throw rejected('run_done');
  if (isSettled(s)) throw rejected('goal_settled');
  const diff = Math.abs(minute - minuteValue(goal.minute));
  const result: GoalResult = { goal: goal.id, guess: minute, answer: { base: goal.minute.base, added: goal.minute.added }, diff, points: soloPoints(diff) };
  const res = [...s.res, result];
  return pack({ ...s, res, done: res.length >= totalGoals });
}

export function next(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  if (!isSettled(s)) throw rejected('goal_not_settled');
  return pack({ ...s, r: s.r + 1 });
}

/**
 * A correction moved the run onto new content. Settled results stay as they were judged (they carry their own
 * minute); a settled current goal moves on first, so the new content's goal at that position is one never guessed.
 */
export const rebase = (s: RunState): RunState => (isSettled(s) && !s.done ? next(s) : pack(s));

export const score = (s: RunState): number => s.res.reduce((sum, r) => sum + r.points, 0);
export const exactHits = (s: RunState): number => s.res.filter((r) => r.diff === 0).length;

/**
 * The current goal's card (never its minute until guessed) and every settled result. `goal` is the day's content for
 * this run's version, or null when it cannot describe the run (another content version).
 */
export function publicState(s: RunState, day: string, goals: readonly MinutoGoal[] | null, extra: { ranked: boolean; rank?: number }): PublicRunState {
  // A finished run keeps its last card on screen: its minute is already in the results.
  const current = goals ? goals[s.r] ?? null : null;
  return {
    day,
    round: s.r,
    totalRounds: GOALS_PER_DAY,
    goal: current ? publicGoal(current) : null,
    settled: isSettled(s) ? copyResult(s.res[s.r]) : null,
    results: s.res.map(copyResult),
    done: s.done,
    score: score(s),
    exact: exactHits(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
