/**
 * Weekend League game rules — pure constants and functions shared by the live
 * engine, the results/recovery paths, and (mirrored) the frontend. Everything
 * here must stay deterministic and side-effect-free: recovery re-derives
 * scores and ranks from persisted answers using exactly these functions.
 */

import { calculatePoints, calculatePutInOrderScore } from '../../realtime/scoring.js';

export const WL_QUESTION_TIME_MS = 10_000;
/**
 * Reading grace before the answer window opens: the question is on screen and
 * the timer holds full until playableAt — the same 3s ranked gives via
 * FRONTEND_REVEAL_MS, so nobody has to answer a question they haven't read.
 */
export const WL_DISPATCH_LEAD_MS = 3_000;
/** Extra lead at ROUND starts so the round-intro overlay can play first. */
export const WL_ROUND_INTRO_MS = 2_200;
export const WL_FINALISTS = 24;
// 45s: two minutes of dead air between games bled a third of the field each
// break (Aug-22: 53 -> 39 -> 31 players); the break only needs to cover the
// result board read + a breath (owner call 2026-08-25).
export const WL_BREAK_MS = 45 * 1000;
/**
 * Pause after the LAST question of a round before the next round dispatches —
 * room for the verdict plus the round-end standings beat. Mid-round questions
 * have no extra hold.
 */
export const WL_ROUND_BREATHER_MS = 6_000;

export const WL_FINAL_GAME_INDEX = 3;

/** Late-join grace: a registered entrant (or marked-no_show finalist) who
 *  missed check-in may still join this long after the scheduled start —
 *  roughly round 1. Missed questions simply score 0 (standings are absolute
 *  over wl_answers). 2026-08-09: 6/28 finalists were locked out, several by
 *  seconds. */
export const WL_LATE_JOIN_MS = 150_000;
export const WL_CHECKIN_WINDOW_MS = 10 * 60 * 1000;
export const WL_GAMES_PER_QUALIFIER = 3;

/** who_am_i is retired from the round order (replaced by money_drop) but stays
 *  in the type: historic tournaments hold wl_questions rows of that kind. */
export type WlRoundKind = 'true_false' | 'higher_lower' | 'mcq' | 'career_path' | 'who_am_i' | 'money_drop' | 'put_in_order';

/** Owner's Aug-8 lineup (2026-08-07): put-in-order replaces higher/lower,
 *  who-am-i returns as the finale (curated puzzles). money_drop and
 *  higher_lower stay implemented — rotated out, not removed. */
export const WL_ROUND_ORDER: readonly WlRoundKind[] = [
  'true_false',
  'put_in_order',
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
  money_drop: 5,
  put_in_order: 5,
};

/** Per-step maximum for the timed kinds; who_am_i scores by clue instead. */
/**
 * Per-question maxima — RANKED PARITY (2026-08-25 rework): every question
 * scores exactly like a ranked question, up to 100 with the same 10-points-
 * per-remaining-second curve players already know ("+90 = answered in ~1s").
 * Perfect game: 4 rounds x 5 x 100 + 100 (who-am-i, one puzzle) = 2100.
 * The old skew (30/40-point steps + a 300-point who-am-i that decided finals
 * on one gamble) is gone: all questions are worth the same.
 */
export const WL_STEP_MAX_POINTS: Record<Exclude<WlRoundKind, 'who_am_i' | 'money_drop'>, number> = {
  true_false: 100,
  higher_lower: 100,
  mcq: 100,
  career_path: 100,
  put_in_order: 100,
};

/** One question's worth, paid by how few clues were needed — a finale, not a
 *  match-decider (was 300/240/180/120/60 = 30% of the game). */
export const WL_WHO_AM_I_CLUE_POINTS: readonly number[] = [100, 80, 60, 40, 20];

/**
 * Money Drop (final round, daily-challenge rules): a 500-point budget enters
 * question 1; each question the player spreads it across the options, keeps
 * only what sits on the correct one, and the survivor rides into the next
 * question. Whatever survives question 5 is the round's points — recorded on
 * the final answer row alone. Budget = 500 so a perfect money-drop round is
 * worth exactly as much as any other 5-question round (ranked parity).
 */
export const WL_MONEY_DROP_BUDGET = 500;
/** Betting window in base question windows — 20s at the prod 10s clock.
 *  10s tested too tight: spreading a budget across four sliders is a slower
 *  interaction than picking one option (playtest feedback 2026-08-07). */
export const WL_MONEY_DROP_WINDOW_STEPS = 2;
/** Mid-round pause after a money-drop reveal — the falling-bill theatre needs
 *  several seconds; the standard flow dispatches the next question instantly. */
export const WL_MONEY_DROP_REVEAL_HOLD_MS = 4_000;
/** Mid-round reveal hold for the instant-verdict kinds (tf/mcq/hl/career):
 *  without it the correct answer flashed for only the orchestrator-tick
 *  latency before the next question replaced it (playtest feedback). */
export const WL_STEP_REVEAL_HOLD_MS = 3_000;
/** Post-reveal hold for put-in-order: matches ranked's post-resolve stage
 *  (result hold + transition + celebration ≈ 9s) so the correct-sequence
 *  comparison is actually readable (playtest: 5s still read as a flash). */
export const WL_PUT_IN_ORDER_REVEAL_HOLD_MS = 9_000;

/** Ordering four items is a slower interaction than one tap — two base
 *  windows (20s at the prod 10s clock). Was 3 (ranked's 30s clock); 30s of
 *  forced watching for early finishers dragged the round (owner call
 *  2026-08-25 — scoring has no speed factor, so the shorter clock only trims
 *  dead time, not points). */
export const WL_PUT_IN_ORDER_WINDOW_STEPS = 2;

/**
 * Sanitize a client bet sheet against the server-known budget: non-negative
 * integers only, and a sheet that over-spends is scaled down proportionally
 * (floor) rather than rejected — honest clients never exceed, and a modified
 * one gains nothing.
 */
export function wlMoneyDropSanitizeBets(
  raw: unknown,
  budget: number
): Record<string, number> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const safeBudget = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
  if (safeBudget === 0) return {};
  // Stakes are capped per entry BEFORE summing: unbounded finite numbers
  // ("1e308") would push the sum to Infinity and turn every scaled stake —
  // and the stored points — into NaN, which the freeze insert cannot persist.
  const STAKE_CAP = 1_000_000_000;
  const entries = Object.entries(raw as Record<string, unknown>)
    .map(([id, v]) => [id, Math.floor(Number(v))] as const)
    .filter(([, v]) => Number.isSafeInteger(v) && v > 0)
    .map(([id, v]) => [id, Math.min(v, STAKE_CAP)] as const)
    .slice(0, 8);
  const sum = entries.reduce((acc, [, v]) => acc + v, 0);
  if (sum === 0) return {};
  const bets: Record<string, number> = {};
  // (v * budget) / sum in one expression: exact in doubles at these
  // magnitudes, where a precomputed budget/sum ratio floors a cent short.
  for (const [id, v] of entries) bets[id] = sum > safeBudget ? Math.floor((v * safeBudget) / sum) : v;
  return bets;
}

export const WL_GAME_MAX_POINTS = 2100;

/**
 * Speed points for one timed step: the ranked 10-bucket curve (incl. its 500ms
 * full-points grace) scaled from 100 down to the step maximum, floored to an
 * integer so per-game totals stay exact.
 */
export function wlStepPoints(
  kind: Exclude<WlRoundKind, 'who_am_i' | 'money_drop'>,
  isCorrect: boolean,
  elapsedMs: number,
  /** The attempt's REAL answer window. Defaults to the standard step, but
   *  put-in-order runs 2 steps — scoring against 10s zeroed any correct
   *  order submitted in the window's second half. */
  windowMs: number = WL_QUESTION_TIME_MS
): number {
  // Career path is a TYPED round: racing the clock while typing a name is
  // hostile UX, so a correct answer inside the window earns the full step —
  // no speed decay (owner call 2026-08-25). who_am_i, the other typed kind,
  // already scores by clue depth rather than speed.
  if (kind === 'career_path') return isCorrect ? WL_STEP_MAX_POINTS.career_path : 0;
  const base = calculatePoints(isCorrect, elapsedMs, Math.max(1_000, windowMs));
  return Math.floor((base * WL_STEP_MAX_POINTS[kind]) / 100);
}

/** Ranked-parity put-in-order scoring: proportional to matched positions
 *  (calculatePutInOrderScore), scaled to the WL step maximum. No speed
 *  factor — exactly as ranked scores the format. */
export function wlPutInOrderPoints(matchedPositions: number, totalItems: number): number {
  const base = calculatePutInOrderScore(matchedPositions, totalItems);
  return Math.floor((base * WL_STEP_MAX_POINTS.put_in_order) / 100);
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
  // Documented tiny-field exception: with 3 or fewer players there is no way to
  // cut three times and still have a final, so nobody is eliminated and the
  // games are played for seeding only. WL_MIN_FIELD (2) allows such an event to
  // run; raising it to 4 would make "every game cuts" hold universally.
  if (n <= 3) return [n, n, n];

  const finalTarget = Math.min(WL_FINALISTS, n - 3);
  // One continuous rule, so one extra entrant never swings a cut: take the
  // gentler of the product shape (n/3, n/6) and the equal-ratio spread. Large
  // fields are dominated by the thirds/sixths terms (600 -> ~200 -> ~100),
  // small ones by the geometric terms (54 -> 41 -> 31), and they meet smoothly.
  const ratio = Math.pow(finalTarget / n, 1 / 3);
  const a1 = Math.min(
    n - 1,
    Math.max(finalTarget + 2, Math.round(n / 3), Math.round(n * ratio)),
  );
  const a2 = Math.min(
    a1 - 1,
    Math.max(finalTarget + 1, Math.round(n / 6), Math.round(n * ratio * ratio)),
  );
  return [a1, a2, finalTarget];
}
