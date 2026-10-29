import { rejected } from '../daily/daily.errors.js';
import type { DailyStartContext } from '../daily/daily.service.js';
import type { Directory } from '../tenable/tenable.identify.js';
import { shownName } from '../tenable/tenable.names.js';
import { asD501Locale, textIn, type D501Category, type D501Locale } from '../darts501/darts501.content.js';
import { D501, entriesOf, finishes, outs, rankScore, readDart, type DartVerdict, type ThrownVerdict } from '../darts501/darts501.rules.js';

/**
 * Football Darts 501's solo daily, pure: one category, 10 darts, no clock. Done on a checkout, after the last dart, or on
 * giving up. The board ranks any checkout above every run without one, then fewer darts, then closer to 0.
 */
export type EndReason = 'checkout' | 'darts' | 'gaveUp';

/** One thrown dart: e = the footballer (null never happens for a thrown one, kept for the shape), x = value (null = miss). */
export interface StoredDart { e: string; t: string; v: Exclude<ThrownVerdict, 'time'>; x: number | null; b: number; a: number }

/**
 * darts501_runs.state: r = remaining; d = darts thrown, in order; done / end; last = the latest answer (thrown or free);
 * k = answers judged (any kind); lc = the language names are shown in (fixed at the start).
 */
export interface RunState {
  v: 1;
  r: number;
  d: StoredDart[];
  done: boolean;
  end: EndReason | null;
  last: { v: DartVerdict; t: string; e: string | null; x: number | null; b: number; a: number } | null;
  k: number;
  lc: D501Locale;
}

export interface Day { category: D501Category; directory: Directory; coverage: ReadonlySet<string> }

const MAX_TEXT = 60;

export const newState = (context?: DailyStartContext): RunState => ({ v: 1, r: D501.start, d: [], done: false, end: null, last: null, k: 0, lc: asD501Locale(context?.locale) });
export const project = (s: RunState): RunState => s;
/** A corrected category: an unfinished run starts again (its darts may have other numbers now), in its language. */
export const rebase = (s: RunState): RunState => newState({ locale: s.lc });

const checkedOut = (s: RunState) => s.end === 'checkout';
export const completion = (s: RunState): { score: number; stat: number } | null =>
  (s.done ? { score: rankScore(checkedOut(s), s.d.length, s.r), stat: s.d.length } : null);

const usedOf = (s: RunState) => new Set(s.d.map((d) => d.e));

export function say(s: RunState, day: Day, text: string, pick: string | null): RunState {
  // A finished run is never saved again (that would rewrite its completion time, the board's last tie-break).
  if (s.done) throw rejected('run_done');
  const trimmed = text.trim().slice(0, MAX_TEXT);
  const read = readDart({ directory: day.directory, coverage: day.coverage, entries: entriesOf(day.category) }, usedOf(s), s.r, trimmed, pick);
  const k = s.k + 1;
  if (read.free) return { ...s, k, last: { v: read.verdict, t: trimmed, e: read.eid, x: null, b: s.r, a: s.r } };
  const dart: StoredDart = { e: read.eid, t: trimmed, v: read.verdict, x: read.value, b: s.r, a: read.after };
  const d = [...s.d, dart];
  const end: EndReason | null = read.verdict === 'checkout' ? 'checkout' : d.length >= D501.darts ? 'darts' : null;
  return { ...s, r: read.after, d, k, done: end !== null, end, last: { v: dart.v, t: dart.t, e: dart.e, x: dart.x, b: dart.b, a: dart.a } };
}

export function giveUp(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  return { ...s, done: true, end: 'gaveUp' };
}

export interface PublicDart { name: string | null; text: string; verdict: DartVerdict; value: number | null; before: number; after: number }
export interface PublicRunState {
  day: string;
  category: { id: string; title: string; note: string | null; unit: D501Category['unit']; asOf: string; release: string; kind: 'player' } | null;
  remaining: number;
  darts: PublicDart[];
  maxDarts: number;
  /** Footballers not thrown yet who would check out from here (a count); null when no one dart can. */
  outs: number | null;
  last: (PublicDart & { n: number }) | null;
  done: boolean;
  end: EndReason | null;
  /** The board's number for this run (higher is better) once it is done; 0 until then. */
  score: number;
  /**
   * At the end, from the final score: how many footballers would have checked out, and (once the day is closed) up to
   * FINISHES of them. Today's names stay hidden: they are today's answers.
   */
  finishes: { count: number; shown: Array<{ name: string; value: number }> | null } | null;
  open: false;
  deadline: null;
  serverNow: string;
  ranked: boolean;
  rank?: number;
}

export const FINISHES = 6;

export function publicState(s: RunState, day: string, content: Day | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number }): PublicRunState {
  const nameOf = (eid: string | null) => (eid && content ? shownName(content.directory, eid, s.lc) : null);
  const toPublic = (d: { e: string | null; t: string; v: DartVerdict; x: number | null; b: number; a: number }): PublicDart =>
    ({ name: nameOf(d.e), text: d.t, verdict: d.v, value: d.x, before: d.b, after: d.a });
  const entries = content ? entriesOf(content.category) : null;
  const used = usedOf(s);
  const text = content ? textIn(content.category, s.lc) : null;
  // Nothing is left to finish after a checkout; a run ended on 0 lives or darts shows what it missed.
  const ending = s.done && s.end !== 'checkout' && entries;
  const finishCount = ending ? outs(entries, used, s.r) : null;
  return {
    day,
    category: content && text
      ? { id: content.category.id, title: text.title, note: text.note, unit: content.category.unit, asOf: content.category.asOf, release: content.category.release, kind: 'player' }
      : null,
    remaining: s.r,
    darts: s.d.map(toPublic),
    maxDarts: D501.darts,
    outs: !s.done && entries ? outs(entries, used, s.r) : null,
    last: s.last && { ...toPublic(s.last), n: s.k },
    done: s.done,
    end: s.end,
    score: completion(s)?.score ?? 0,
    finishes: ending && finishCount !== null
      ? { count: finishCount, shown: extra.disclose ? finishes(entries, used, s.r, FINISHES).map((f) => ({ name: nameOf(f.eid) ?? '?', value: f.value })) : null }
      : null,
    open: false,
    deadline: null,
    serverNow: new Date(now).toISOString(),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
