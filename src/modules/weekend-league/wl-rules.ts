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
/**
 * Pause after the LAST question of a round before the next round dispatches —
 * room for the verdict plus the round-end standings beat. Mid-round questions
 * have no extra hold.
 */
export const WL_ROUND_BREATHER_MS = 6_000;
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
  higher_lower: 5,
  mcq: 5,
  career_path: 5,
  // One puzzle played across 5 clue windows — the round is still 5 beats long.
  who_am_i: 1,
};

/** Per-step maximum for the timed kinds; who_am_i scores by clue instead. */
/**
 * Per-question maxima. The five rounds must total WL_GAME_MAX_POINTS for a
 * perfect game: 5x30 + 5x30 + 5x40 + 5x40 + 300 (who-am-i, one puzzle) = 1000.
 * Changing a count here means rebalancing these.
 */
export const WL_STEP_MAX_POINTS: Record<Exclude<WlRoundKind, 'who_am_i'>, number> = {
  true_false: 30,
  higher_lower: 30,
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
 *
 * EVERY game must eliminate someone — a game whose cut is empty is dead air
 * for the players still in it. So:
 *  - Big fields keep the product shape (600 -> 200 -> 100 -> 24): thirds, then
 *    halves, then the finalist cut.
 *  - Smaller fields, where /3 then /6 would land at or under the finalist
 *    count and leave games 2-3 with nothing to cut, spread the reduction
 *    geometrically instead so all three games cut a real share
 *    (54 -> 41 -> 31 -> 24).
 *  - Below WL_FINALISTS + 3 the arithmetic cannot produce three distinct cuts
 *    ending at 24, so the final target drops just enough to keep every game
 *    meaningful rather than promising a cut that cannot happen.
 */
export function wlBuildLadder(fieldSize: number): [number, number, number] {
  const n = Math.max(0, Math.floor(fieldSize));
  if (n <= 3) return [n, n, n];

  const finalTarget = Math.min(WL_FINALISTS, n - 3);
  const byThirds = Math.round(n / 3);
  const bySixths = Math.round(n / 6);
  if (bySixths > finalTarget) return [byThirds, bySixths, finalTarget];

  // Equal ratio per game: n * r, n * r^2, finalTarget with r = (target/n)^(1/3).
  const ratio = Math.pow(finalTarget / n, 1 / 3);
  const a1 = Math.min(n - 1, Math.max(finalTarget + 2, Math.round(n * ratio)));
  const a2 = Math.min(a1 - 1, Math.max(finalTarget + 1, Math.round(n * ratio * ratio)));
  return [a1, a2, finalTarget];
}
