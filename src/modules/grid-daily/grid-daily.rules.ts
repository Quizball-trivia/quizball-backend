import { rejected } from '../daily/daily.errors.js';
import { CELLS, GUESSES, SPEED_CAP_SECONDS } from './grid-daily.constants.js';
import type { GridDailyCell, PublicRunState, RunState } from './grid-daily.types.js';

export function newState(): RunState {
  return { v: 1, cells: Array.from({ length: CELLS }, () => null), left: GUESSES, t0: null, t1: null, done: false };
}

const copyCell = (cell: GridDailyCell | null): GridDailyCell | null =>
  cell ? { playerId: cell.playerId, name: cell.name, nameKa: cell.nameKa, imageUrl: cell.imageUrl } : null;

/** Only the known fields. */
const pack = (s: RunState): RunState => ({ v: 1, cells: s.cells.map(copyCell), left: s.left, t0: s.t0, t1: s.t1, done: s.done });

export const score = (s: RunState): number => s.cells.filter(Boolean).length;

/** Seconds left of the hour, measured from the kick-off to the finish; 0 for a run that never kicked off. */
export function speed(s: RunState): number {
  if (s.t0 === null || s.t1 === null) return 0;
  return Math.max(0, SPEED_CAP_SECONDS - Math.floor(Math.max(0, s.t1 - s.t0) / 1_000));
}

/**
 * The player kicks off: from here the board is shown and the clock runs, so nobody studies the squares before
 * their time starts. A second kick-off changes nothing.
 */
export function kickOff(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  return s.t0 === null ? pack({ ...s, t0: now }) : s;
}

function assertOpen(s: RunState, cellIndex: number): void {
  if (s.done) throw rejected('run_done');
  if (s.t0 === null) throw rejected('not_started');
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= CELLS) throw rejected('bad_cell');
  if (s.cells[cellIndex]) throw rejected('cell_filled');
}

/** A guess spent; the run ends when the last one is, or when the board is full. */
function spend(s: RunState, now: number): RunState {
  const left = s.left - 1;
  const done = left <= 0 || score(s) >= CELLS;
  return pack({ ...s, left, t1: done ? now : null, done });
}

/** The named footballer fits the cell. No footballer fills two cells. */
export function fill(s: RunState, cellIndex: number, player: GridDailyCell, now: number): RunState {
  assertOpen(s, cellIndex);
  if (s.cells.some((cell) => cell?.playerId === player.playerId)) throw rejected('player_used');
  const cells = s.cells.map((cell, index) => (index === cellIndex ? copyCell(player) : cell));
  return spend({ ...s, cells }, now);
}

/** A name that does not fit (or was already used on this board): the guess is spent, the cell stays open. */
export function miss(s: RunState, cellIndex: number, now: number): RunState {
  assertOpen(s, cellIndex);
  return spend(s, now);
}

/** The player stops with guesses left. */
export function finish(s: RunState, now: number): RunState {
  if (s.done) throw rejected('run_done');
  if (s.t0 === null) throw rejected('not_started');
  return pack({ ...s, t1: now, done: true });
}

/** A correction moved the run onto another board: nothing filled on the old one carries over. */
export const rebase = (): RunState => newState();

export function publicState(
  s: RunState,
  day: string,
  content: { number: number; boardId: string } | null,
  extra: { ranked: boolean; rank?: number; serverNow: number },
): PublicRunState {
  return {
    day,
    number: content?.number ?? null,
    boardId: content?.boardId ?? null,
    cells: s.cells.map(copyCell),
    guessesLeft: s.left,
    totalGuesses: GUESSES,
    startedAt: s.t0,
    finishedAt: s.t1,
    done: s.done,
    score: score(s),
    speed: speed(s),
    ranked: extra.ranked,
    serverNow: extra.serverNow,
    ...(extra.rank !== undefined && { rank: extra.rank }),
  };
}
