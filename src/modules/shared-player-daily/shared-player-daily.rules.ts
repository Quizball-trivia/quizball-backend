import { rejected } from '../daily/daily.errors.js';
import type { Universe } from '../footballers/footballers.universe.js';
import type { SharedPlayerItem } from '../room/games/shared-player/shared-player.engine.js';
import { ANSWER_GRACE_MS } from '../wordgame-daily/wordgame-daily.shared.js';

/**
 * "Played for both", solo: ten club pairs a day, ten seconds each, one point per pair found. A wrong answer blocks the
 * input for a moment. Pure: time comes in as `now` (the database clock).
 */
export const PAIRS_PER_DAY = 10;
export const RACE_MS = 10_000;
export const WRONG_LOCK_MS = 1_000;
const EXAMPLES = 6;

export type PairEnd = 'found' | 'time';
export interface PairResult { pid: string | null; left: number }
export interface Feedback { n: number; kind: 'ok' | 'wrong'; text: string }

/**
 * shared_player_runs.state: r = pair index; open = its clock is running; dl = the deadline (epoch ms) while open;
 * lock = no answer is judged before this instant; att = answers judged on this pair; end = why the pair settled;
 * res = every settled pair (the current one included): the footballer found and the tenths of a second left.
 */
export interface RunState {
  v: 1;
  r: number;
  open: boolean;
  dl: number | null;
  lock: number;
  att: number;
  last: Feedback | null;
  end: PairEnd | null;
  res: PairResult[];
  done: boolean;
}

export type AnswerResult = 'ok' | 'wrong' | 'locked' | 'late';

export function newState(): RunState {
  return { v: 1, r: 0, open: false, dl: null, lock: 0, att: 0, last: null, end: null, res: [], done: false };
}

function settle(s: RunState, pid: string | null, left: number): RunState {
  const res = [...s.res, { pid, left }];
  return { ...s, open: false, dl: null, lock: 0, end: pid ? 'found' : 'time', res, done: res.length >= PAIRS_PER_DAY };
}

/** The run as of `now`: an open clock that ran out (past the network grace) is the pair lost to time. */
export function project(s: RunState, now: number): RunState {
  return s.open && s.dl !== null && now > s.dl + ANSWER_GRACE_MS ? settle(s, null, 0) : s;
}

/** Opens the next pair: the first one, or the one after a settled pair. Its clubs are shown from here. */
export function next(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.open) throw rejected('pair_open');
  const started = s.end !== null;
  return { ...s, r: started ? s.r + 1 : s.r, open: true, dl: now + RACE_MS, lock: 0, att: 0, last: null, end: null };
}

/** One typed answer against the (already projected) run. */
export function answer(s: RunState, pair: SharedPlayerItem, universe: Universe, text: string, now: number): { state: RunState; result: AnswerResult } {
  if (s.done) throw rejected('run_done');
  if (!s.open || s.dl === null) throw rejected('pair_closed');
  if (now < s.lock) return { state: s, result: 'locked' };
  const shown = text.trim().slice(0, 60);
  const pid = universe.pickAmong(text, pair.accepted);
  if (pid === null) return { state: { ...s, att: s.att + 1, lock: now + WRONG_LOCK_MS, last: { n: s.att, kind: 'wrong', text: shown } }, result: 'wrong' };
  const left = Math.max(0, Math.min(RACE_MS / 100, Math.round((s.dl - now) / 100)));
  return { state: { ...settle(s, pid, left), att: s.att + 1, last: { n: s.att, kind: 'ok', text: universe.player(pid)?.name ?? shown } }, result: 'ok' };
}

/** A correction moves an unfinished run onto new content from scratch (the kit also unranks it). */
export const rebase = (_s: RunState): RunState => newState();

/** When `project` settled the pair by time: the instant its clock (with the grace) ran out. */
export const settledAt = (stored: RunState, projected: RunState): number | null =>
  (stored.open && !projected.open && stored.dl !== null ? stored.dl + ANSWER_GRACE_MS : null);

export const score = (s: RunState): number => s.res.filter((r) => r.pid !== null).length;
/** Tenths of a second left over the pairs found: the board's tie-break (faster ranks higher). */
export const speed = (s: RunState): number => s.res.reduce((sum, r) => sum + (r.pid !== null ? r.left : 0), 0);

type ClubView = { key: string; name: Record<'es' | 'en' | 'ka' | 'tr', string>; crest: string };
const clubView = (club: SharedPlayerItem['a']): ClubView => ({ key: club.key, name: club.label, crest: club.crest });

export interface PublicPairResult {
  clubs: [ClubView, ClubView] | null;
  found: string | null;
  /** Valid answers the pair has. */
  total: number | null;
  /** A few of them, only once the day is closed (today's answers are never handed out). */
  examples: string[] | null;
}

export interface PublicRunState {
  day: string;
  pair: number;
  totalPairs: number;
  raceMs: number;
  /** The pair on screen: only once it was opened. */
  clubs: [ClubView, ClubView] | null;
  open: boolean;
  /** ISO; the web counts down against `serverNow`. */
  deadline: string | null;
  lockedUntil: string | null;
  serverNow: string;
  attempt: number;
  last: Feedback | null;
  settled: (PublicPairResult & { reason: PairEnd }) | null;
  results: PublicPairResult[];
  done: boolean;
  score: number;
  ranked: boolean;
  rank?: number;
}

/** What the player sees; `s` must already be projected to `now`. `pairs` is null on other content (a corrected day). */
export function publicState(
  s: RunState, day: string, pairs: readonly SharedPlayerItem[] | null, universe: Universe | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number },
): PublicRunState {
  const nameOf = (pid: string | null) => (pid && universe ? universe.player(pid)?.name ?? null : null);
  const resultView = (r: PairResult, index: number): PublicPairResult => {
    const pair = pairs?.[index] ?? null;
    const examples = pair && extra.disclose ? pair.accepted.slice(0, Math.min(EXAMPLES, pair.examples || EXAMPLES)).map(nameOf).filter((name): name is string => name !== null) : null;
    return { clubs: pair ? [clubView(pair.a), clubView(pair.b)] : null, found: nameOf(r.pid), total: pair ? pair.accepted.length : null, examples };
  };
  const current = pairs?.[s.r] ?? null;
  const started = s.open || s.end !== null;
  return {
    day,
    pair: s.r,
    totalPairs: PAIRS_PER_DAY,
    raceMs: RACE_MS,
    clubs: started && current ? [clubView(current.a), clubView(current.b)] : null,
    open: s.open,
    deadline: s.open && s.dl !== null ? new Date(s.dl).toISOString() : null,
    lockedUntil: s.open && s.lock > now ? new Date(s.lock).toISOString() : null,
    serverNow: new Date(now).toISOString(),
    attempt: s.att,
    last: s.last,
    settled: s.end ? { ...resultView(s.res[s.res.length - 1], s.r), reason: s.end } : null,
    results: s.res.map(resultView),
    done: s.done,
    score: score(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
