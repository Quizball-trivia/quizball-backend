import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { rejected } from '../daily/daily.errors.js';
import {
  CX_GROUPS, cxBoardSchema, judge, remaining, tierOf, tryKey, validFour,
  type CxBoard, type CxGroup, type CxLocalized, type CxName, type CxTier, type CxTile, type CxVerdict,
} from '../room/games/conexiones/conexiones.rules.js';

/**
 * Conexiones futboleras, solo: the same board for everyone each day. Four mistakes; a four already tried costs
 * nothing. Pure: time comes in as `now` (the database clock, read after the run's lock). The board shows once the run
 * is opened (the time counts from then); an unsolved group leaves the server only when the run is over.
 */
export const SOLO_MISTAKES = 4;
/** Seconds a run may take on the board (two days, the longest a day's run can stay open). */
export const MAX_SECS = 172_800;

export const dayBoardSchema = z.object({ board: cxBoardSchema }).strict();
export type DayBoard = z.infer<typeof dayBoardSchema>;

export interface CxRunTry { ids: string[]; verdict: CxVerdict }

/**
 * conexiones_runs.state: seed = this run's tile order; t0 / t1 = when the board was opened / the run ended (epoch ms,
 * database clock); solved = group ids in the order found; tries = every judged four.
 */
export interface RunState {
  v: 1;
  seed: string;
  t0: number | null;
  t1: number | null;
  solved: string[];
  mistakes: number;
  tries: CxRunTry[];
  done: boolean;
}

export const newState = (): RunState => ({ v: 1, seed: randomBytes(12).toString('hex'), t0: null, t1: null, solved: [], mistakes: 0, tries: [], done: false });

/** The run's own tile order, fixed by its seed (a reload shows the same board). */
export function orderOf(board: CxBoard, seed: string): string[] {
  const rank = (id: string) => createHash('sha256').update(`${seed}:${board.id}:${id}`).digest('hex');
  return board.tiles.map((t) => t.id).sort((a, b) => (rank(a) < rank(b) ? -1 : 1));
}

/** Shows the board and starts the time. */
export function open(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.t0 !== null) throw rejected('already_open');
  return { ...s, t0: now };
}

export function guess(s: RunState, board: CxBoard, ids: readonly string[], now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.t0 === null) throw rejected('not_open');
  if (!validFour(ids, remaining(board.tiles.map((t) => t.id), board, s.solved))) throw rejected('bad_tiles');
  const key = tryKey(ids);
  if (s.tries.some((t) => tryKey(t.ids) === key)) throw rejected('repeat');
  const { verdict, group } = judge(board, ids);
  const tries = [...s.tries, { ids: [...ids], verdict }];
  if (group) {
    const solved = [...s.solved, group.id];
    const done = solved.length === CX_GROUPS;
    return { ...s, tries, solved, done, t1: done ? now : null };
  }
  const mistakes = s.mistakes + 1;
  const done = mistakes >= SOLO_MISTAKES;
  return { ...s, tries, mistakes, done, t1: done ? now : null };
}

/** Nothing runs out: the clock never settles anything. */
export const project = (s: RunState, _now: number): RunState => s;
/** A correction moves an unfinished run onto new content from scratch (the kit also unranks it). */
export const rebase = (_s: RunState): RunState => newState();

export const won = (s: RunState) => s.solved.length === CX_GROUPS;
/** Groups first, then fewer mistakes: a lost run scores its groups (0–3), a won one 4 + mistakes left (5–8). */
export const score = (s: RunState): number => s.solved.length + (won(s) ? SOLO_MISTAKES - s.mistakes : 0);
export const secs = (s: RunState): number => (s.t0 !== null && s.t1 !== null ? Math.min(MAX_SECS, Math.max(0, Math.round((s.t1 - s.t0) / 1000))) : 0);

/** The daily serves every language at once (the web picks the player's): names and links as stored. */
export interface PublicTile { id: string; name: CxName; portrait: string | null }
export interface PublicGroup { id: string; tier: CxTier; link: CxLocalized; note: CxLocalized | null; members: string[]; missed: boolean }

const publicTile = (t: CxTile): PublicTile => ({ id: t.id, name: t.name, portrait: t.portrait });
const publicGroup = (g: CxGroup, missed: boolean): PublicGroup => ({ id: g.id, tier: g.tier, link: g.link, note: g.note ?? null, members: [...g.members], missed });

export interface PublicRunState {
  day: string;
  opened: boolean;
  /** The kit's clock fields: nothing in this game runs out. */
  open: false;
  deadline: null;
  /** Every tile in this run's order once the board is opened (solved groups' tiles included: their bands name them). */
  tiles: PublicTile[];
  /** Solved groups in the order found; once the day is closed, the missed ones after them. */
  groups: PublicGroup[];
  mistakes: number;
  mistakesLeft: number;
  tries: CxRunTry[];
  /** The tier of each tile of each try (the share grid), once the run is over; null for a tile of a missed group until
   * the day is closed (the tiers of a lost run's tries would give its groups away). */
  tiers: (CxTier | null)[][] | null;
  startedAt: string | null;
  serverNow: string;
  done: boolean;
  won: boolean;
  /** Groups found: the result needs it even when the run's day was corrected since (no groups are served then). */
  found: number;
  score: number;
  secs: number;
  ranked: boolean;
  disclosed: boolean;
  rank?: number;
}

/** What the player sees; `day` is null on other content (a corrected day). */
export function publicState(s: RunState, dayId: string, day: DayBoard | null, now: number, extra: { ranked: boolean; disclose: boolean; rank?: number }): PublicRunState {
  const board = day?.board ?? null;
  const byId = new Map(board?.tiles.map((t) => [t.id, t]) ?? []);
  const groupOf = (id: string) => board!.groups.find((g) => g.id === id)!;
  const missed = s.done && extra.disclose && board ? board.groups.filter((g) => !s.solved.includes(g.id)).sort((a, b) => a.tier - b.tier) : [];
  return {
    day: dayId,
    opened: s.t0 !== null,
    open: false,
    deadline: null,
    tiles: board && s.t0 !== null ? orderOf(board, s.seed).map((id) => publicTile(byId.get(id)!)) : [],
    groups: board ? [
      ...s.solved.map((id) => publicGroup(groupOf(id), false)),
      ...missed.map((g) => publicGroup(g, true)),
    ] : [],
    mistakes: s.mistakes,
    mistakesLeft: Math.max(0, SOLO_MISTAKES - s.mistakes),
    tries: s.tries,
    tiers: s.done && board ? s.tries.map((t) => t.ids.map((id) => (extra.disclose || s.solved.some((g) => groupOf(g).members.includes(id)) ? tierOf(board, id) : null))) : null,
    startedAt: s.t0 !== null ? new Date(s.t0).toISOString() : null,
    serverNow: new Date(now).toISOString(),
    done: s.done,
    won: won(s),
    found: s.solved.length,
    score: score(s),
    secs: secs(s),
    ranked: extra.ranked,
    disclosed: s.done && extra.disclose,
    ...(extra.rank !== undefined ? { rank: extra.rank } : {}),
  };
}
