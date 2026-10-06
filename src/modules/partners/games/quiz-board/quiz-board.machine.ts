/**
 * Quiz Board for Freecroco (contract §7.7) — solo state machine.
 *
 * Board: 9 tiles, 3 categories (columns) × 3 rows worth 100 / 200 / 300 (easy / medium / hard). Tile index =
 * category * 3 + row.
 *
 * Phases (one board row, one active tile at most):
 *   pick     — the player chooses an open tile. Deadline: PICK_IDLE_MS after the phase opened.
 *   answer   — the player answers the picked tile. Deadline: ANSWER_MS after the pick.
 *   finished — terminal; `endReason` says why.
 *
 * Transitions:
 *   pick(tile)                  pick → answer(tile)
 *   answer: right               the tile's value is banked → pick (or finished('completed') after the 9th tile)
 *   answer: wrong / timeout     the tile is used for 0 → pick (or finished('completed') after the 9th tile)
 *   pick deadline passed        finished('idle') at the deadline: the player left (closed the game / lost connection)
 *   leave                       finished('left') now, an unanswered active tile counts 0
 *   play cancelled (block)      finished('cancelled'): the kit sends no event
 *
 * Deadlines are logical: whoever advances the board later (the next request or the sweeper) applies an expired
 * deadline at the deadline's own instant, so `finishedAt` (the event's `occurredAt`) never depends on when the server
 * got round to it. An answer is accepted up to GRACE_MS after its deadline (network); a deadline counts as expired only
 * after that grace.
 *
 * Score (contract §7.7): the sum of the tiles answered right; at most 1,800. Leaving early keeps what was banked.
 */

import { createHmac } from 'node:crypto';

export const QUIZ_BOARD_TILES = 9;
export const QUIZ_BOARD_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type QuizBoardDifficulty = (typeof QUIZ_BOARD_DIFFICULTIES)[number];
export const QUIZ_BOARD_VALUES: Record<QuizBoardDifficulty, number> = { easy: 100, medium: 200, hard: 300 };
export const QUIZ_BOARD_OPTIONS = 4;

export const ANSWER_MS = 20_000;
export const GRACE_MS = 1_000;
export const PICK_IDLE_MS = 90_000;

export type QuizBoardPhase = 'pick' | 'answer' | 'finished';
/** 'player' = answered right, 'none' = answered wrong or timed out. */
export type QuizBoardOwner = 'player' | 'none';
export type QuizBoardEndReason = 'completed' | 'left' | 'idle' | 'cancelled';

export interface QuizBoardTile {
  tile: number;
  difficulty: QuizBoardDifficulty;
  value: number;
  /** Index of the right option in display order. */
  correctIndex: number;
  owner: QuizBoardOwner | null;
  usedAt: Date | null;
}

export interface QuizBoardState {
  phase: QuizBoardPhase;
  activeTile: number | null;
  /** Increments on every transition; requests echo it so a retried or stale request changes nothing. */
  turn: number;
  deadlineAt: Date | null;
  playerScore: number;
  endReason: QuizBoardEndReason | null;
  finishedAt: Date | null;
  tiles: QuizBoardTile[];
}

export type QuizBoardEventKind =
  | 'pick' // player picked `tile`
  | 'answer' // player answered `tile`: `choice`, `correct`, `points`
  | 'timeout' // player's time on `tile` ran out
  | 'end';

export interface QuizBoardEvent {
  actor: 'player' | 'system';
  kind: QuizBoardEventKind;
  tile: number | null;
  correct: boolean | null;
  choice: number | null;
  points: number;
  at: Date;
}

export interface Transition {
  state: QuizBoardState;
  events: QuizBoardEvent[];
}

export class QuizBoardMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuizBoardMoveError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded option order

/** A uniform number in [0, 1) fixed by the seed and the label. */
export function seededUnit(seed: string, label: string): number {
  const digest = createHmac('sha256', seed).update(label).digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/** Display order of a tile's options (indices into the stored order), fixed by the seed. */
export function seededOptionOrder(seed: string, tile: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => i)
    .map((i) => ({ i, key: seededUnit(seed, `option:${tile}:${i}`) }))
    .sort((a, b) => a.key - b.key)
    .map((o) => o.i);
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions (pure: they return a new state and the events to persist)

const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);

function clone(state: QuizBoardState): QuizBoardState {
  return { ...state, tiles: state.tiles.map((t) => ({ ...t })) };
}

function tileAt(state: QuizBoardState, tile: number): QuizBoardTile {
  const found = state.tiles.find((t) => t.tile === tile);
  if (!found) throw new QuizBoardMoveError(`tile ${tile} does not exist`);
  return found;
}

export function playerScoreOf(state: QuizBoardState): number {
  return state.tiles.reduce((sum, t) => sum + (t.owner === 'player' ? t.value : 0), 0);
}

function finish(s: QuizBoardState, events: QuizBoardEvent[], reason: QuizBoardEndReason, at: Date): void {
  s.phase = 'finished';
  s.activeTile = null;
  s.deadlineAt = null;
  s.endReason = reason;
  s.finishedAt = at;
  s.turn += 1;
  events.push({ actor: 'system', kind: 'end', tile: null, correct: null, choice: null, points: 0, at });
}

/** The answer (`choice` null = the time ran out) on the active tile, at `at`; the 9th used tile closes the play. */
function resolveAnswer(state: QuizBoardState, choice: number | null, at: Date): Transition {
  const s = clone(state);
  const events: QuizBoardEvent[] = [];
  if (s.phase !== 'answer') throw new QuizBoardMoveError('no question is open');
  const tile = tileAt(s, s.activeTile!);
  const correct = choice !== null && choice === tile.correctIndex;
  events.push({
    actor: 'player',
    kind: choice === null ? 'timeout' : 'answer',
    tile: tile.tile,
    correct,
    choice,
    points: correct ? tile.value : 0,
    at,
  });
  tile.owner = correct ? 'player' : 'none';
  tile.usedAt = at;
  if (correct) s.playerScore += tile.value;
  if (s.tiles.every((t) => t.owner !== null)) {
    finish(s, events, 'completed', at);
  } else {
    s.phase = 'pick';
    s.activeTile = null;
    s.deadlineAt = plus(at, PICK_IDLE_MS);
    s.turn += 1;
  }
  return { state: s, events };
}

/** The network grace is for answers in flight only; the pick idle limit is exact. */
function graceFor(phase: QuizBoardState['phase']): number {
  return phase === 'answer' ? GRACE_MS : 0;
}

function expired(deadline: Date | null, now: Date, grace: number): boolean {
  return deadline !== null && now.getTime() > deadline.getTime() + grace;
}

/** Whether `state`'s deadline (plus the answer grace) has passed by `now`. */
export function due(state: QuizBoardState, now: Date): boolean {
  return state.phase !== 'finished' && expired(state.deadlineAt, now, graceFor(state.phase));
}

/** Applies every deadline that has passed by `now`, each at its own instant. */
export function advance(state: QuizBoardState, now: Date): Transition {
  let s = state;
  const events: QuizBoardEvent[] = [];
  while (due(s, now)) {
    if (s.phase === 'pick') {
      const next = clone(s);
      finish(next, events, 'idle', s.deadlineAt!);
      s = next;
    } else {
      const step = resolveAnswer(s, null, s.deadlineAt!);
      s = step.state;
      events.push(...step.events);
    }
  }
  return { state: s, events };
}

export function pickTile(state: QuizBoardState, tile: number, now: Date): Transition {
  if (state.phase !== 'pick') throw new QuizBoardMoveError('not your pick');
  if (expired(state.deadlineAt, now, 0)) throw new QuizBoardMoveError('the pick time has run out');
  const s = clone(state);
  const target = tileAt(s, tile);
  if (target.owner !== null) throw new QuizBoardMoveError('tile already used');
  s.phase = 'answer';
  s.activeTile = tile;
  s.deadlineAt = plus(now, ANSWER_MS);
  s.turn += 1;
  return {
    state: s,
    events: [{ actor: 'player', kind: 'pick', tile, correct: null, choice: null, points: 0, at: now }],
  };
}

export function answerTile(state: QuizBoardState, choice: number, now: Date): Transition {
  if (!Number.isInteger(choice) || choice < 0 || choice >= QUIZ_BOARD_OPTIONS) {
    throw new QuizBoardMoveError('choice out of range');
  }
  if (expired(state.deadlineAt, now, GRACE_MS)) throw new QuizBoardMoveError('the answer time has run out');
  return resolveAnswer(state, choice, now);
}

export function leaveBoard(state: QuizBoardState, now: Date): Transition {
  if (state.phase === 'finished') return { state, events: [] };
  const s = clone(state);
  const events: QuizBoardEvent[] = [];
  finish(s, events, 'left', now);
  return { state: s, events };
}

export function cancelBoard(state: QuizBoardState, now: Date): Transition {
  if (state.phase === 'finished') return { state, events: [] };
  const s = clone(state);
  const events: QuizBoardEvent[] = [];
  finish(s, events, 'cancelled', now);
  return { state: s, events };
}

/** A fresh board waiting for the first pick. */
export function initialState(tiles: QuizBoardTile[], now: Date): QuizBoardState {
  return {
    phase: 'pick',
    activeTile: null,
    turn: 0,
    deadlineAt: plus(now, PICK_IDLE_MS),
    playerScore: 0,
    endReason: null,
    finishedAt: null,
    tiles,
  };
}
