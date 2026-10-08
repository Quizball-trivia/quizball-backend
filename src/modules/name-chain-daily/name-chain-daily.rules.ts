import { rejected } from '../daily/daily.errors.js';
import type { Universe } from '../footballers/footballers.universe.js';
import { draw, examplesOn, judge, letterExhausted, pickStart, type Verdict } from '../room/games/name-chain/name-chain.core.js';
import { ANSWER_GRACE_MS } from '../wordgame-daily/wordgame-daily.shared.js';

/**
 * The footballer name chain, solo: three chains a day, each from a fresh well-known name and each ending when its
 * clock runs out (or the player gives it up); the score is every footballer named in the three together. Pure: time
 * comes in as `now` (the database clock) and every start name follows from the day's seed and a counter.
 */
export const CHAINS_PER_DAY = 3;
export const TURN_START_MS = 10_000;
export const TURN_MIN_MS = 6_000;
/** The turn gets a second shorter every few answers, so a chain cannot go on for ever. */
export const SPEEDUP_EVERY = 5;
/** A chain is complete at this many names: the board has a ceiling. */
export const CHAIN_CAP = 30;
/** No answer is taken sooner than this after the last accepted one: nobody types a name faster. */
export const MIN_ANSWER_GAP_MS = 700;
/** The daily opens with start names of this half; rooms use the other. */
const DAILY_START_BUCKET = 0;
const EXAMPLES = 5;

export const turnMsFor = (named: number): number => Math.max(TURN_MIN_MS, TURN_START_MS - Math.floor(named / SPEEDUP_EVERY) * 1_000);

export type ChainEnd = 'time' | 'pass' | 'cap';
export interface Link { p: string; g: boolean }
export interface Feedback { n: number; kind: Verdict; text: string; p: string | null }

/**
 * name_chain_runs.state: c = chain index; open = its clock is running; dl = the deadline (epoch ms) while open;
 * ch = the chain being played (g: the game supplied the name); used = every footballer of the run so far;
 * att = answers judged on the current turn; at = when the last answer was accepted; n = names said per finished chain
 * (the current one included once it ended); d = random draws taken so far.
 */
export interface RunState {
  v: 1;
  c: number;
  open: boolean;
  dl: number | null;
  letter: string;
  ch: Link[];
  used: string[];
  att: number;
  at: number;
  last: Feedback | null;
  end: ChainEnd | null;
  n: number[];
  d: number;
  done: boolean;
}

export type AnswerResult = Verdict | 'late' | 'too_fast';

export function newState(): RunState {
  return { v: 1, c: 0, open: false, dl: null, letter: '', ch: [], used: [], att: 0, at: 0, last: null, end: null, n: [], d: 0, done: false };
}

const namedIn = (s: RunState): number => s.ch.filter((link) => !link.g).length;

function settle(s: RunState, reason: ChainEnd): RunState {
  const n = [...s.n, namedIn(s)];
  return { ...s, open: false, dl: null, end: reason, n, done: n.length >= CHAINS_PER_DAY };
}

/** The run as of `now`: an open clock that ran out (past the network grace) ends the chain. */
export function project(s: RunState, now: number): RunState {
  return s.open && s.dl !== null && now > s.dl + ANSWER_GRACE_MS ? settle(s, 'time') : s;
}

/** Starts the first chain, or the next one after a chain ended, from a fresh well-known name. */
export function next(s: RunState, universe: Universe, seed: number, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.open) throw rejected('chain_open');
  const start = pickStart(universe, new Set(s.used), DAILY_START_BUCKET, draw(seed, s.d));
  // The release has nobody left to start from: the run ends with what was named.
  if (start === null) return { ...s, done: true };
  return {
    ...s, c: s.end !== null ? s.c + 1 : s.c, open: true, dl: now + turnMsFor(0), letter: universe.last(start), ch: [{ p: start, g: true }], used: [...s.used, start],
    att: 0, at: 0, last: null, end: null, d: s.d + 1,
  };
}

/** One typed answer against the (already projected) run. A wrong answer costs only the time it took. */
export function answer(s: RunState, universe: Universe, seed: number, text: string, now: number): { state: RunState; result: AnswerResult } {
  if (s.done) throw rejected('run_done');
  if (!s.open) throw rejected('chain_closed');
  if (now - s.at < MIN_ANSWER_GAP_MS) return { state: s, result: 'too_fast' };
  const used = new Set(s.used);
  const judged = judge(universe, used, s.letter, text);
  const shown = text.trim().slice(0, 60);
  if (judged.verdict !== 'ok' || judged.pid === null) {
    return { state: { ...s, att: s.att + 1, last: { n: s.att, kind: judged.verdict, text: shown, p: judged.pid } }, result: judged.verdict };
  }
  used.add(judged.pid);
  let ch: Link[] = [...s.ch, { p: judged.pid, g: false }];
  let letter = universe.last(judged.pid);
  let d = s.d;
  const base = { ...s, used: [...used], att: 0, at: now, last: { n: s.att, kind: 'ok' as const, text: shown, p: judged.pid } };
  if (ch.filter((link) => !link.g).length >= CHAIN_CAP) return { state: settle({ ...base, ch, letter, d }, 'cap'), result: 'ok' };
  // Nobody left on this letter: the game supplies a fresh name, nobody is penalised, used names stay used.
  if (letterExhausted(universe, used, letter)) {
    const fresh = pickStart(universe, used, DAILY_START_BUCKET, draw(seed, d));
    d += 1;
    if (fresh === null) return { state: settle({ ...base, ch, letter, d }, 'cap'), result: 'ok' };
    used.add(fresh);
    ch = [...ch, { p: fresh, g: true }];
    letter = universe.last(fresh);
  }
  return { state: { ...base, used: [...used], ch, letter, d, dl: now + turnMsFor(ch.filter((link) => !link.g).length) }, result: 'ok' };
}

/** The player gives the chain up instead of waiting for the clock. */
export function pass(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  if (!s.open) throw rejected('chain_closed');
  return settle(s, 'pass');
}

/** A correction moves an unfinished run onto new content from scratch (the kit also unranks it). */
export const rebase = (_s: RunState): RunState => newState();

/** When `project` ended the chain by time: the instant its clock (with the grace) ran out. */
export const settledAt = (stored: RunState, projected: RunState): number | null =>
  (stored.open && !projected.open && stored.dl !== null ? stored.dl + ANSWER_GRACE_MS : null);

export const score = (s: RunState): number => s.n.reduce((sum, n) => sum + n, 0);
export const longest = (s: RunState): number => Math.max(0, ...s.n);

export interface PublicRunState {
  day: string;
  chain: number;
  totalChains: number;
  chainCap: number;
  /** The chain on screen: the name the footballer is known by decides the next letter. */
  links: Array<{ name: string; game: string; given: boolean }>;
  letter: string;
  open: boolean;
  /** ISO; the web counts down against `serverNow`. */
  deadline: string | null;
  serverNow: string;
  turnMs: number;
  attempt: number;
  last: { n: number; kind: Verdict; text: string; name: string | null; starts: string[] } | null;
  settled: { reason: ChainEnd; named: number; could: string[] } | null;
  /** Names said in each finished chain. */
  results: number[];
  done: boolean;
  score: number;
  longest: number;
  ranked: boolean;
  rank?: number;
}

/** What the player sees; `s` must already be projected to `now`. Nothing here is secret: every footballer is an answer. */
export function publicState(s: RunState, day: string, universe: Universe | null, now: number, extra: { ranked: boolean; rank?: number }): PublicRunState {
  const player = (pid: string | null) => (pid && universe ? universe.player(pid) ?? null : null);
  const last = s.last && {
    n: s.last.n, kind: s.last.kind, text: s.last.text, name: player(s.last.p)?.name ?? null,
    starts: s.last.p && s.last.kind === 'letter' && universe ? [...universe.starts(s.last.p)] : [],
  };
  return {
    day,
    chain: s.c,
    totalChains: CHAINS_PER_DAY,
    chainCap: CHAIN_CAP,
    links: s.ch.map((link) => ({ name: player(link.p)?.name ?? '', game: player(link.p)?.game ?? '', given: link.g })),
    letter: s.letter,
    open: s.open,
    deadline: s.open && s.dl !== null ? new Date(s.dl).toISOString() : null,
    serverNow: new Date(now).toISOString(),
    turnMs: turnMsFor(namedIn(s)),
    attempt: s.att,
    last,
    settled: s.end ? { reason: s.end, named: s.n[s.n.length - 1] ?? 0, could: universe && s.end !== 'cap' ? examplesOn(universe, new Set(s.used), s.letter, EXAMPLES) : [] } : null,
    results: s.n,
    done: s.done,
    score: score(s),
    longest: longest(s),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
