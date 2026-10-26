import { z } from 'zod';
import type { RoomEngineStanding, RoomSeatChange, RoomSeatStatus } from '../../room.engine.js';
import {
  CX_DECOYS, CX_GROUP_SIZE, CX_TILES, cxBoardSchema, judge, publicGroup, publicTile, remaining, textIn, tryKey, validFour,
  type CxBoard, type CxDifficulty, type CxPublicGroup, type CxPublicTile, type CxVerdict,
} from './conexiones.rules.js';

/**
 * Conexiones futboleras 1v1 (a room of exactly two), pure: five boards, the opener alternates per board. One try per
 * turn, hit or miss, then the turn passes; +1 a group. With three groups out, the seat on turn names the last link from
 * four options (+1 if right). Six misses end a board (the rest is shown, unscored). A turn or a naming that runs out is
 * a miss; two in a row by the same seat forfeit the match.
 */

export const INTRO_MS = 3_000;
export const TURN_MS = 60_000;
export const NAME_MS = 30_000;
export const REVEAL_MS = 5_000;
/** A deadline this far overdue is an outage: the open turn gets a fresh window, nobody is charged. */
export const OUTAGE_MS = 5_000;
export const CX_MATCH_BOARDS = 5;
export const CX_BOARD_MISSES = 6;
export const CX_FORFEIT_TIMEOUTS = 2;
/** The difficulty of each board of a match, in order. */
export const CX_MATCH_ORDER: readonly CxDifficulty[] = ['easy', 'medium', 'medium', 'medium', 'hard'];

const tileId = z.string().regex(/^[a-z0-9]{8}$/);
const perm = (n: number) => z.array(z.number().int().min(0).max(n - 1)).length(n).refine((xs) => new Set(xs).size === n, 'Not a permutation');

/** One board of a match: the board, its tiles in the order this match shows them, and the naming options' order (0 = the link). */
const matchBoardSchema = z.object({
  board: cxBoardSchema,
  order: z.array(tileId).length(CX_TILES),
  options: perm(CX_DECOYS + 1),
}).strict().refine((b) => new Set(b.order).size === CX_TILES && b.order.every((id) => b.board.tiles.some((t) => t.id === id)), 'The order must list every tile once');

export const conexionesPackSchema = z.object({
  /** The seat that opens board 1 (board 2 the other, and so on). */
  first: z.union([z.literal(0), z.literal(1)]),
  boards: z.array(matchBoardSchema).length(CX_MATCH_BOARDS),
}).strict().refine((p) => new Set(p.boards.map((b) => b.board.id)).size === CX_MATCH_BOARDS, 'A board appears twice');
export type ConexionesContent = z.infer<typeof conexionesPackSchema>;

const boardNo = z.number().int().min(0).max(CX_MATCH_BOARDS - 1);
/** `n`: moves made on this board (from the view), so a late or repeated send never lands on the next turn. */
const moveNo = z.number().int().min(0).max(100);
export const conexionesCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('try'), board: boardNo, n: moveNo, ids: z.array(tileId).length(CX_GROUP_SIZE) }).strict(),
  z.object({ type: z.literal('name'), board: boardNo, n: moveNo, pick: z.number().int().min(0).max(CX_DECOYS) }).strict(),
]);
export type ConexionesCommand = z.infer<typeof conexionesCommandSchema>;

export type CxPhase = 'intro' | 'turn' | 'name' | 'reveal' | 'over' | 'cancelled';
export interface CxTry { seat: number; ids: string[] | null; verdict: CxVerdict | 'timeout' }
/** A group out of play: `by` the seat it went to, null when nobody scored it (named wrong, run out, revealed). */
export interface CxOut { group: string; by: number | null }
/** The last group's naming: the option picked (null = the clock ran out). */
export interface CxNamed { seat: number; pick: number | null; right: boolean }
export interface CxEnd { reason: 'score' | 'forfeit' | 'left'; loser: number | null }

export interface ConexionesState {
  phase: CxPhase;
  board: number;
  turn: number;
  n: number;
  deadline: number;
  status: RoomSeatStatus[];
  out: CxOut[];
  tries: CxTry[];
  misses: number;
  /** Clock run-outs in a row, per seat (any move of the seat clears its count). */
  timeouts: number[];
  /** Points per board started, per seat. */
  points: number[][];
  /** Groups found by a try, per seat, over the match (a naming scores a point, not a group). */
  found?: number[];
  named: CxNamed | null;
  end: CxEnd | null;
}

const other = (seat: number) => (seat === 0 ? 1 : 0);
/** Groups found per seat; a state saved before the count existed reads as none yet. */
const foundOf = (s: ConexionesState): number[] => s.found ?? [0, 0];
const replace = <T>(list: readonly T[], at: number, value: T): T[] => list.map((v, i) => (i === at ? value : v));
const ended = (s: ConexionesState) => s.phase === 'over' || s.phase === 'cancelled';
export const opener = (content: ConexionesContent, board: number) => (board % 2 === 0 ? content.first : other(content.first));
const boardOf = (content: ConexionesContent, s: ConexionesState): CxBoard => content.boards[s.board].board;
const inPlay = (content: ConexionesContent, s: ConexionesState) => remaining(content.boards[s.board].order, boardOf(content, s), s.out.map((o) => o.group));
const lastGroup = (content: ConexionesContent, s: ConexionesState) => boardOf(content, s).groups.find((g) => !s.out.some((o) => o.group === g.id))!;

export function startMatch(seats: number, content: ConexionesContent, nowMs: number): ConexionesState {
  if (seats !== 2) throw new Error('A Conexiones room needs exactly 2 admitted seats');
  return {
    phase: 'intro', board: 0, turn: content.first, n: 0, deadline: nowMs + INTRO_MS, status: ['in', 'in'],
    out: [], tries: [], misses: 0, timeouts: [0, 0], points: [], found: [0, 0], named: null, end: null,
  };
}

function openBoard(s: ConexionesState, content: ConexionesContent, board: number, nowMs: number): ConexionesState {
  return {
    ...s, phase: 'turn', board, turn: opener(content, board), n: 0, deadline: nowMs + TURN_MS,
    out: [], tries: [], misses: 0, named: null, points: [...s.points, [0, 0]],
  };
}

const award = (s: ConexionesState, seat: number): number[][] =>
  s.points.map((p, i) => (i === s.board ? replace(p, seat, p[seat] + 1) : p));

/** Everything not out yet is shown, scored by nobody. */
function reveal(s: ConexionesState, content: ConexionesContent, nowMs: number): ConexionesState {
  const rest = boardOf(content, s).groups.filter((g) => !s.out.some((o) => o.group === g.id)).map((g): CxOut => ({ group: g.id, by: null }));
  return { ...s, phase: 'reveal', out: [...s.out, ...rest], deadline: nowMs + REVEAL_MS };
}

/** After a move: the board ends after its misses, three groups out turn to naming, otherwise the next turn. */
function afterMove(s: ConexionesState, content: ConexionesContent, nowMs: number): ConexionesState {
  if (s.misses >= CX_BOARD_MISSES) return reveal(s, content, nowMs);
  if (s.out.length === boardOf(content, s).groups.length - 1) return { ...s, phase: 'name', deadline: nowMs + NAME_MS };
  return { ...s, phase: 'turn', deadline: nowMs + TURN_MS };
}

function timeout(s: ConexionesState, content: ConexionesContent, nowMs: number): ConexionesState {
  const seat = s.turn;
  const timeouts = replace(s.timeouts, seat, s.timeouts[seat] + 1);
  // The win goes to a seat that is here: with the other seat away (or gone), the run-out is only a miss and the
  // presence rules settle the match.
  if (timeouts[seat] >= CX_FORFEIT_TIMEOUTS && s.status[other(seat)] === 'in') return { ...s, timeouts, phase: 'over', end: { reason: 'forfeit', loser: seat } };
  if (s.phase === 'name') {
    const g = lastGroup(content, s);
    return { ...s, timeouts, n: s.n + 1, named: { seat, pick: null, right: false }, out: [...s.out, { group: g.id, by: null }], phase: 'reveal', deadline: nowMs + REVEAL_MS };
  }
  const next: ConexionesState = { ...s, timeouts, n: s.n + 1, turn: other(seat), misses: s.misses + 1, tries: [...s.tries, { seat, ids: null, verdict: 'timeout' }] };
  return afterMove(next, content, nowMs);
}

const live = (s: ConexionesState) => s.status.flatMap((st, seat) => (st === 'withdrawn' ? [] : [seat]));
/** The one seat left is away: the match waits for it (back wins it, its absence running out cancels it). */
const loneAway = (s: ConexionesState) => {
  const seats = live(s);
  return seats.length === 1 && s.status[seats[0]] === 'away';
};

/**
 * A seat left: the other wins while it is here; if it is away too, the match waits for it. Nobody left cancels. A
 * seat that leaves after the other already left changes nothing.
 */
function settleTerminal(s: ConexionesState): ConexionesState {
  if (ended(s)) return s;
  const seats = live(s);
  if (seats.length === 2) return s;
  if (seats.length === 0) return { ...s, phase: 'cancelled' };
  const stayer = seats[0];
  return s.status[stayer] === 'in' ? { ...s, phase: 'over', end: { reason: 'left', loser: other(stayer) } } : s;
}

export function seatsChanged(s: ConexionesState, changes: readonly RoomSeatChange[]): ConexionesState {
  if (ended(s)) return s;
  const status = [...s.status];
  for (const { seat, change } of changes) {
    if (status[seat] === 'withdrawn') continue;
    status[seat] = change === 'leave' ? 'withdrawn' : change === 'away' ? 'away' : 'in';
  }
  return settleTerminal({ ...s, status });
}

/** Moves the clock: intro → board 1; a turn or naming runs out; reveal → next board or the end. */
export function tick(s: ConexionesState, content: ConexionesContent, nowMs: number): ConexionesState {
  if (ended(s) || nowMs < s.deadline) return s;
  if (loneAway(s)) return { ...s, deadline: nowMs + REVEAL_MS };
  if (s.phase === 'intro') return openBoard(s, content, 0, nowMs);
  if (s.phase === 'turn' || s.phase === 'name') {
    if (nowMs - s.deadline > OUTAGE_MS) return { ...s, deadline: nowMs + (s.phase === 'turn' ? TURN_MS : NAME_MS) };
    return timeout(s, content, nowMs);
  }
  if (s.board + 1 < content.boards.length) return openBoard(s, content, s.board + 1, nowMs);
  return { ...s, phase: 'over', end: { reason: 'score', loser: null } };
}

export function afterOutage(s: ConexionesState, nowMs: number): ConexionesState {
  if (s.phase === 'turn') return { ...s, deadline: nowMs + TURN_MS };
  if (s.phase === 'name') return { ...s, deadline: nowMs + NAME_MS };
  return s;
}

export type CxCommandError = 'not_open' | 'withdrawn' | 'stale' | 'not_your_turn' | 'bad_tiles' | 'repeat';

export function applyCommand(s: ConexionesState, content: ConexionesContent, seat: number, cmd: ConexionesCommand, nowMs: number): { state: ConexionesState; error?: CxCommandError } {
  if ((s.phase !== 'turn' && s.phase !== 'name') || nowMs >= s.deadline) return { state: s, error: 'not_open' };
  if (s.status[seat] === 'withdrawn') return { state: s, error: 'withdrawn' };
  if (cmd.board !== s.board || cmd.n !== s.n) return { state: s, error: 'stale' };
  if (s.turn !== seat) return { state: s, error: 'not_your_turn' };
  const timeouts = replace(s.timeouts, seat, 0);
  if (cmd.type === 'name') {
    if (s.phase !== 'name') return { state: s, error: 'not_open' };
    const g = lastGroup(content, s);
    const right = content.boards[s.board].options[cmd.pick] === 0;
    return {
      state: {
        ...s, timeouts, n: s.n + 1, named: { seat, pick: cmd.pick, right }, out: [...s.out, { group: g.id, by: right ? seat : null }],
        points: right ? award(s, seat) : s.points, phase: 'reveal', deadline: nowMs + REVEAL_MS,
      },
    };
  }
  if (s.phase !== 'turn') return { state: s, error: 'not_open' };
  if (!validFour(cmd.ids, inPlay(content, s))) return { state: s, error: 'bad_tiles' };
  // A four already tried on this board (by either seat) is refused, and the turn stays: it would tell nobody anything.
  const key = tryKey(cmd.ids);
  if (s.tries.some((t) => t.ids && tryKey(t.ids) === key)) return { state: s, error: 'repeat' };
  const { verdict, group } = judge(boardOf(content, s), cmd.ids);
  const moved: ConexionesState = { ...s, timeouts, n: s.n + 1, turn: other(seat), tries: [...s.tries, { seat, ids: [...cmd.ids], verdict }] };
  if (group) return { state: afterMove({ ...moved, out: [...s.out, { group: group.id, by: seat }], points: award(s, seat), found: replace(foundOf(s), seat, foundOf(s)[seat] + 1) }, content, nowMs) };
  return { state: afterMove({ ...moved, misses: s.misses + 1 }, content, nowMs) };
}

export const totals = (s: ConexionesState): number[] => s.status.map((_, seat) => s.points.reduce((sum, p) => sum + p[seat], 0));

/** The winner's seat, null for a draw or while the match is on. */
export function winnerOf(s: ConexionesState): number | null {
  if (s.phase !== 'over' || !s.end) return null;
  if (s.end.loser !== null) return other(s.end.loser);
  const [a, b] = totals(s);
  return a === b ? null : a > b ? 0 : 1;
}

/** Points first, a draw shares first place; a seat that forfeited or left is second whatever its points. */
export function standings(s: ConexionesState): RoomEngineStanding[] {
  const points = totals(s);
  const winner = winnerOf(s);
  return s.status.map((_, seat) => ({ seat, points: points[seat], roundWins: foundOf(s)[seat], place: winner === null || winner === seat ? 1 : 2 }));
}

export interface ConexionesView {
  phase: 'intro' | 'turn' | 'name' | 'reveal' | 'over';
  board: number;
  totalBoards: number;
  n: number;
  turn: number;
  mySeat: number;
  /** This board's tiles in the match's order (none during the intro). */
  tiles: CxPublicTile[];
  /** Groups out of play in the order they went, with who scored them. */
  out: Array<CxPublicGroup & { by: number | null }>;
  tries: CxTry[];
  missesLeft: number;
  /** The naming options in the reader's language, while naming and in the reveal after it. */
  options: string[] | null;
  /** The naming: what was picked and, once named, the right option. */
  named: (CxNamed & { answer: number }) | null;
  scores: number[];
  points: number[][];
  seats: Array<{ seat: number; status: RoomSeatStatus; timeouts: number }>;
  result: { winner: number | null; reason: CxEnd['reason'] } | null;
  standings: RoomEngineStanding[] | null;
  deadline: string | null;
}

/** What `seat` sees: never a group that is still in play (its members, tier, link or decoys), never which option is right before the naming. */
export function viewOf(s: ConexionesState, content: ConexionesContent, seat: number, locale: string): ConexionesView {
  const showing = s.phase !== 'intro' && s.phase !== 'cancelled';
  const mb = content.boards[s.board];
  const byId = new Map(mb.board.tiles.map((t) => [t.id, t]));
  const naming = s.phase === 'name' || (s.phase !== 'turn' && s.named !== null);
  const options = naming && showing ? mb.options.map((i) => {
    const g = s.phase === 'name' ? lastGroup(content, s) : mb.board.groups.find((x) => x.id === s.out[s.out.length - 1].group)!;
    return textIn(i === 0 ? g.link : g.decoys[i - 1], locale);
  }) : null;
  const over = s.phase === 'over' || s.phase === 'cancelled';
  return {
    phase: s.phase === 'cancelled' ? 'over' : s.phase,
    board: s.board,
    totalBoards: content.boards.length,
    n: s.n,
    turn: s.turn,
    mySeat: seat,
    tiles: showing ? mb.order.map((id) => publicTile(byId.get(id)!, locale)) : [],
    out: showing ? s.out.map((o) => ({ ...publicGroup(mb.board.groups.find((g) => g.id === o.group)!, locale), by: o.by })) : [],
    tries: showing ? s.tries : [],
    missesLeft: Math.max(0, CX_BOARD_MISSES - s.misses),
    options,
    named: s.named && options ? { ...s.named, answer: mb.options.indexOf(0) } : null,
    scores: totals(s),
    points: s.points,
    seats: s.status.map((status, x) => ({ seat: x, status, timeouts: s.timeouts[x] })),
    result: s.phase === 'over' && s.end ? { winner: winnerOf(s), reason: s.end.reason } : null,
    standings: over ? standings(s) : null,
    deadline: over ? null : new Date(s.deadline).toISOString(),
  };
}
