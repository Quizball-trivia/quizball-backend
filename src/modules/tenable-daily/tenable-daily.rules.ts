import { rejected } from '../daily/daily.errors.js';
import type { TenableList } from '../tenable/tenable.content.js';
import { judge, type Directory, type Verdict } from '../tenable/tenable.identify.js';

/**
 * Football Tenable's solo daily, pure: one hidden top-10 list, 3 lives, no clock. A right answer takes its slot; a
 * wrong one (a real entity that is not on the list) costs a life; everything else is free. Done at 10/10, at 0 lives
 * or on giving up. Score = slots found; the board's tie-break is lives left.
 */
export const LIVES = 3;

export type EndReason = 'complete' | 'lives' | 'gaveUp';
export type LastKind = Verdict['kind'] | 'repeatWrong';

/**
 * tenable_runs.state: f = entity ids found, in the order found; w = wrong entity ids, in order; l = lives left;
 * end = why the run finished; last = the latest answer's verdict; k = answers judged (any kind).
 */
export interface RunState {
  v: 1;
  f: string[];
  w: string[];
  l: number;
  done: boolean;
  end: EndReason | null;
  last: { kind: LastKind; text: string; eid: string | null } | null;
  k: number;
}

export const newState = (): RunState => ({ v: 1, f: [], w: [], l: LIVES, done: false, end: null, last: null, k: 0 });
/** No clock: nothing ever settles by itself. */
export const project = (s: RunState): RunState => s;
/** A corrected list: an unfinished run starts again on it (its finds may not be on the new list). */
export const rebase = (): RunState => newState();
export const completion = (s: RunState): { score: number; stat: number } | null => (s.done ? { score: s.f.length, stat: s.l } : null);

export function say(s: RunState, list: TenableList, directory: Directory, text: string, pick: string | null): RunState {
  // A finished run is never saved again (that would rewrite its completion time, the board's tiebreak).
  if (s.done) throw rejected('run_done');
  const eids = list.slots.map((slot) => slot.eid);
  const found = new Set(s.f.map((eid) => eids.indexOf(eid)).filter((i) => i >= 0));
  const verdict = judge(directory, eids, found, text, pick);
  const k = s.k + 1;
  const trimmed = text.trim().slice(0, 60);
  if (verdict.kind === 'right') {
    const f = [...s.f, verdict.eid];
    const complete = f.length === eids.length;
    return { ...s, f, k, done: complete, end: complete ? 'complete' : null, last: { kind: 'right', text: trimmed, eid: verdict.eid } };
  }
  if (verdict.kind === 'wrong') {
    // The same wrong entity twice costs nothing: the player already paid for it.
    if (s.w.includes(verdict.eid)) return { ...s, k, last: { kind: 'repeatWrong', text: trimmed, eid: verdict.eid } };
    const l = s.l - 1;
    return { ...s, w: [...s.w, verdict.eid], l, k, done: l <= 0, end: l <= 0 ? 'lives' : null, last: { kind: 'wrong', text: trimmed, eid: verdict.eid } };
  }
  return { ...s, k, last: { kind: verdict.kind, text: trimmed, eid: verdict.kind === 'repeat' ? verdict.eid : null } };
}

export function giveUp(s: RunState): RunState {
  if (s.done) throw rejected('run_done');
  return { ...s, done: true, end: 'gaveUp' };
}

type Localized = { es: string; en: string; ka: string; tr: string };
export interface PublicSlot { rank: number; name: string | null; figure: TenableList['slots'][number]['figure'] | null; found: boolean }
export interface PublicRunState {
  day: string;
  list: { title: Localized; note: Localized | null; asOf: string | null; kind: TenableList['kind']; release: string };
  /** Every slot's rank; names and figures only of slots this run found, or of every slot once the day is closed. */
  slots: PublicSlot[];
  lives: number;
  maxLives: number;
  /** Names the wrong answers were read as. */
  misses: string[];
  last: { kind: LastKind; text: string; name: string | null; rank: number | null; n: number } | null;
  done: boolean;
  end: EndReason | null;
  score: number;
  /** The rest of the list is shown once the day is over (never while today's ranking is open). */
  disclosed: boolean;
  /** The kit's daily-game wire contract: this game has no clock. */
  open: false;
  deadline: null;
  serverNow: string;
  ranked: boolean;
  rank?: number;
}

export function publicState(s: RunState, day: string, content: { list: TenableList; directory: Directory } | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number }): PublicRunState {
  const list = content?.list;
  const nameOf = (eid: string | null) => (eid && content ? content.directory.entity(eid)?.name ?? null : null);
  const eids = list ? list.slots.map((slot) => slot.eid) : [];
  const found = new Set(s.f);
  return {
    day,
    list: list
      ? { title: list.title, note: list.note, asOf: list.asOf, kind: list.kind, release: list.release }
      : { title: { es: '', en: '', ka: '', tr: '' }, note: null, asOf: null, kind: 'player', release: '' },
    slots: (list?.slots ?? []).map((slot, i) => {
      const mine = found.has(slot.eid);
      // A closed day is shown whole only at the end of the run: while it is played, its answers are the game.
      const shown = mine || (extra.disclose && s.done);
      return { rank: i + 1, name: shown ? nameOf(slot.eid) : null, figure: shown ? slot.figure : null, found: mine };
    }),
    lives: s.l,
    maxLives: LIVES,
    misses: s.w.map((eid) => nameOf(eid) ?? '?'),
    last: s.last && { kind: s.last.kind, text: s.last.text, name: nameOf(s.last.eid), rank: s.last.eid && eids.includes(s.last.eid) && found.has(s.last.eid) ? eids.indexOf(s.last.eid) + 1 : null, n: s.k },
    done: s.done,
    end: s.end,
    score: s.f.length,
    disclosed: extra.disclose && s.done,
    open: false,
    deadline: null,
    serverNow: new Date(now).toISOString(),
    ranked: extra.ranked,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
