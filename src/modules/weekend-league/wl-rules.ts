/**
 * Weekend League game rules — pure constants and functions shared by the live
 * engine, the results/recovery paths, and (mirrored) the frontend. Everything
 * here must stay deterministic and side-effect-free: recovery re-derives
 * scores and ranks from persisted answers using exactly these functions.
 */

import { calculatePoints } from '../../realtime/scoring.js';

export const WL_QUESTION_TIME_MS = 10_000;
/** Uniform head start stamped by the deliverer: playableAt = redisNow + LEAD. */
export const WL_DISPATCH_LEAD_MS = 1200;
export const WL_FINALISTS = 24;
export const WL_BREAK_MS = 2 * 60 * 1000;
export const WL_CHECKIN_WINDOW_MS = 10 * 60 * 1000;
export const WL_GAMES_PER_QUALIFIER = 3;

export type WlRoundKind = 'true_false' | 'higher_lower' | 'mcq' | 'career_path' | 'who_am_i';

export const WL_ROUND_ORDER: readonly WlRoundKind[] = [
  'true_false',
  'higher_lower',
  'mcq',
  'career_path',
  'who_am_i',
];

export const WL_QUESTIONS_PER_ROUND: Record<WlRoundKind, number> = {
  true_false: 5,
  higher_lower: 3,
  mcq: 5,
  career_path: 5,
  who_am_i: 1,
};

/** Per-step maximum for the timed kinds; who_am_i scores by clue instead. */
export const WL_STEP_MAX_POINTS: Record<Exclude<WlRoundKind, 'who_am_i'>, number> = {
  true_false: 30,
  higher_lower: 50,
  mcq: 40,
  career_path: 40,
};

export const WL_WHO_AM_I_CLUE_POINTS: readonly number[] = [300, 240, 180, 120, 60];

export const WL_GAME_MAX_POINTS = 1000;

/**
 * Speed points for one timed step: the ranked 10-bucket curve (incl. its 500ms
 * full-points grace) scaled from 100 down to the step maximum, floored to an
 * integer so per-game totals stay exact.
 */
export function wlStepPoints(
  kind: Exclude<WlRoundKind, 'who_am_i'>,
  isCorrect: boolean,
  elapsedMs: number
): number {
  const base = calculatePoints(isCorrect, elapsedMs, WL_QUESTION_TIME_MS);
  return Math.floor((base * WL_STEP_MAX_POINTS[kind]) / 100);
}

export function wlWhoAmIPoints(isCorrect: boolean, clueIndex: number): number {
  if (!isCorrect) return 0;
  const idx = Math.min(Math.max(Math.floor(clueIndex), 0), WL_WHO_AM_I_CLUE_POINTS.length - 1);
  return WL_WHO_AM_I_CLUE_POINTS[idx] ?? 0;
}

/**
 * Tie-break time charge: a missed step charges the full clock so absence never
 * outranks a wrong-but-present answer at equal points; wrong answers charge
 * their actual elapsed time.
 */
export function wlTimeChargeMs(answered: boolean, elapsedMs: number): number {
  if (!answered) return WL_QUESTION_TIME_MS;
  return Math.min(Math.max(elapsedMs, 0), WL_QUESTION_TIME_MS);
}

/**
 * ZSET score encoding: higher is better, points dominate, lower cumulative
 * time wins ties. One point unit (1e8) strictly exceeds the whole time range
 * (< 1e8), so no time difference can ever outweigh a single point. Max
 * encoded value ~1.001e11, well inside the 53-bit exact range Redis doubles
 * preserve.
 */
export const WL_TIME_ENCODING_CEILING = 99_999_999;

export function wlEncodeScore(points: number, timeMsTotal: number): number {
  return points * 1e8 + (WL_TIME_ENCODING_CEILING - Math.min(timeMsTotal, WL_TIME_ENCODING_CEILING));
}

/**
 * The one canonical ranking comparator (points DESC, time ASC, user_id ASC).
 * Redis ZSET order is never trusted at equal encoded scores — every selection
 * of advancers/ranks sorts with this exact function.
 */
export function wlCompareStanding(
  a: { points: number; timeMsTotal: number; userId: string },
  b: { points: number; timeMsTotal: number; userId: string }
): number {
  if (a.points !== b.points) return b.points - a.points;
  if (a.timeMsTotal !== b.timeMsTotal) return a.timeMsTotal - b.timeMsTotal;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * Qualifier ladder for any field size: advance targets after games 1..3.
 * Shape mirrors the product ladder 600 → 200 → 100 → 24 (÷3, ÷2, cut to 24)
 * and degrades deterministically for small fields — nobody is eliminated while
 * the field is at or under the finalist count.
 */
export function wlBuildLadder(fieldSize: number): [number, number, number] {
  const n = Math.max(0, Math.floor(fieldSize));
  const a1 = Math.min(n, Math.max(WL_FINALISTS, Math.round(n / 3)));
  const a2 = Math.min(a1, Math.max(WL_FINALISTS, Math.round(a1 / 2)));
  const a3 = Math.min(a2, WL_FINALISTS);
  return [a1, a2, a3];
}
