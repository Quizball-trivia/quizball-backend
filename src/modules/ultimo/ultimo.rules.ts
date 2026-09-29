import { ANSWER_GRACE_MS, CATEGORIES_PER_DAY, COMPLETE_BONUS, REVEAL_MS, UL_MAX_MISSES, turnMsFor } from './ultimo.constants.js';
import { rejected } from './ultimo.errors.js';
import { copyText, matchAnswer, type UltimoCategory } from './ultimo.match.js';
import type { CategoryResult, EndReason, PublicCategoryResult, PublicRunState, RunState } from './ultimo.types.js';

export type AnswerResult = 'ok' | 'wrong' | 'repeat' | 'ambiguous' | 'late';

export function newState(): RunState {
  return { v: 1, c: 0, open: false, said: [], m: 0, dl: null, end: null, res: [], done: false };
}

/** Only the known fields. */
const pack = (s: RunState): RunState => ({ v: 1, c: s.c, open: s.open, said: s.said, m: s.m, dl: s.dl, end: s.end, res: s.res, done: s.done });

export const pointsOf = (r: CategoryResult): number => r.named + (r.complete ? COMPLETE_BONUS : 0);

/** Settling appends the result at once; the last category's settlement finishes the run in the same write. */
function settle(s: RunState, reason: EndReason): RunState {
  const res = [...s.res, { named: s.said.length, complete: reason === 'complete', reason }];
  return pack({ ...s, open: false, dl: null, end: reason, res, done: res.length >= CATEGORIES_PER_DAY });
}

/**
 * The run as of `now`: an open clock that ran out (past the network grace) is the category lost to time. Every
 * read and every move sees this state, so a player who walked away finds the category over, never still open.
 */
export function project(s: RunState, now: number): RunState {
  return s.open && s.dl !== null && now > s.dl + ANSWER_GRACE_MS ? settle(s, 'time') : s;
}

/** Starts the current category: its title is shown from here and the first answer clock includes the reveal. */
export function begin(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.end) throw rejected('category_settled');
  if (s.open) throw rejected('category_open');
  return pack({ ...s, open: true, dl: now + REVEAL_MS + turnMsFor(0) });
}

/**
 * One typed answer against the (already projected) run. A new answer resets the misses and restarts the clock
 * shorter; naming the last one completes the list. A repeat or an unknown name is a miss on the same clock, the
 * third in a row ends the category. An ambiguous name (a shared surname) changes nothing.
 */
export function answer(s: RunState, category: UltimoCategory, text: string, now: number): { state: RunState; result: AnswerResult; index?: number } {
  if (s.done) throw rejected('run_done');
  if (s.end) throw rejected('category_settled');
  if (!s.open) throw rejected('category_closed');
  const match = matchAnswer(category, text);
  if (match.kind === 'ambiguous') return { state: s, result: 'ambiguous' };
  if (match.kind === 'answer' && !s.said.includes(match.index)) {
    const said = [...s.said, match.index];
    if (said.length >= category.answers.length) return { state: settle({ ...s, said, m: 0 }, 'complete'), result: 'ok', index: match.index };
    return { state: pack({ ...s, said, m: 0, dl: now + turnMsFor(said.length) }), result: 'ok', index: match.index };
  }
  const result: AnswerResult = match.kind === 'answer' ? 'repeat' : 'wrong';
  const m = s.m + 1;
  if (m >= UL_MAX_MISSES) return { state: settle({ ...s, m }, 'misses'), result };
  return { state: pack({ ...s, m }), result };
}

export function next(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.end) throw rejected('category_not_settled');
  return pack({ ...s, c: s.c + 1, open: false, said: [], m: 0, dl: null, end: null });
}

/**
 * The state an unfinished run keeps when a correction moves it onto new content: a fresh start (the kit also
 * unranks it). Answers are kept by position, so no progress can be carried onto a changed list safely.
 */
export const rebase = (_s: RunState): RunState => newState();

/** When `project` settled the category by time: the instant its clock (with the grace) ran out. */
export const settledAt = (stored: RunState, projected: RunState): number | null =>
  stored.open && !projected.open && stored.dl !== null ? stored.dl + ANSWER_GRACE_MS : null;

export const score = (s: RunState): number => s.res.reduce((sum, r) => sum + pointsOf(r), 0);
export const answers = (s: RunState): number => s.res.reduce((sum, r) => sum + r.named, 0);

const withPoints = (r: CategoryResult, played: UltimoCategory | null): PublicCategoryResult => ({
  named: r.named, complete: r.complete, reason: r.reason, points: pointsOf(r),
  title: played ? copyText(played.title) : null, total: played ? played.answers.length : null,
});

/**
 * What the player sees. The category's title, hint and size only once it was started; the names said; the
 * missing ones of a settled category only when `disclose` allows (the day is closed by the database clock).
 * `s` must already be projected to `now`.
 */
export function publicState(
  s: RunState, day: string, category: UltimoCategory | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number },
  /** The day's categories (for the results of the ones already played); none on other content. */
  categories: readonly UltimoCategory[] = [],
): PublicRunState {
  const started = s.open || s.end !== null;
  const shown = started && category !== null ? category : null;
  const last = s.end ? s.res[s.res.length - 1] : null;
  const missing = shown ? shown.answers.filter((_, i) => !s.said.includes(i)) : [];
  return {
    day,
    category: s.c,
    totalCategories: CATEGORIES_PER_DAY,
    title: shown ? copyText(shown.title) : null,
    hint: shown ? copyText(shown.hint) : null,
    total: shown ? shown.answers.length : null,
    open: s.open,
    deadline: s.open && s.dl !== null ? new Date(s.dl).toISOString() : null,
    serverNow: new Date(now).toISOString(),
    turnMs: turnMsFor(s.said.length),
    said: shown ? s.said.map((i) => copyText(shown.answers[i].display)) : [],
    misses: s.m,
    settled: last ? { ...withPoints(last, shown), missing: extra.disclose && shown ? missing.map((a) => copyText(a.display)) : null, missingCount: missing.length } : null,
    results: s.res.map((r, i) => withPoints(r, categories[i] ?? null)),
    done: s.done,
    score: score(s),
    answers: answers(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
