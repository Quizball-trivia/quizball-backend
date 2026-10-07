import { describe, expect, it } from 'vitest';
import {
  advance,
  ANSWER_MS,
  answerTile,
  cancelBoard,
  GRACE_MS,
  initialState,
  leaveBoard,
  pickTile,
  PICK_IDLE_MS,
  playerScoreOf,
  QUIZ_BOARD_VALUES,
  QuizBoardMoveError,
  seededOptionOrder,
  type QuizBoardDifficulty,
  type QuizBoardState,
} from '../../../../src/modules/partners/games/quiz-board/quiz-board.machine.js';

const DIFFS: QuizBoardDifficulty[] = ['easy', 'medium', 'hard', 'easy', 'medium', 'hard', 'easy', 'medium', 'hard'];
const T0 = new Date('2026-10-06T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

/** Tiles with the right option at index 0. */
function board(): QuizBoardState {
  const tiles = DIFFS.map((difficulty, tile) => ({
    tile,
    difficulty,
    value: QUIZ_BOARD_VALUES[difficulty],
    correctIndex: 0,
    owner: null,
    usedAt: null,
  }));
  return initialState(tiles, T0);
}

describe('quiz-board machine (solo)', () => {
  it('a right answer banks the tile and opens the next pick', () => {
    const picked = pickTile(board(), 2, at(1000));
    expect(picked.state.phase).toBe('answer');
    expect(picked.state.deadlineAt).toEqual(at(1000 + ANSWER_MS));
    const answered = answerTile(picked.state, 0, at(5000));
    expect(answered.state.phase).toBe('pick');
    expect(answered.state.playerScore).toBe(300);
    expect(answered.state.tiles[2].owner).toBe('player');
    expect(answered.state.deadlineAt).toEqual(at(5000 + PICK_IDLE_MS));
    expect(answered.events).toEqual([
      { actor: 'player', kind: 'answer', tile: 2, correct: true, choice: 0, points: 300, at: at(5000) },
    ]);
  });

  it('the answer grace does not extend the 90 s pick limit', () => {
    // The first pick deadline is T0 + PICK_IDLE_MS (initialState).
    const late = at(PICK_IDLE_MS + 400);
    expect(() => pickTile(board(), 0, late)).toThrow(QuizBoardMoveError);
    const ended = advance(board(), late);
    expect(ended.state.phase).toBe('finished');
    // An answer 400 ms after its own deadline is still inside the grace.
    const picked = pickTile(board(), 0, at(0));
    expect(answerTile(picked.state, 0, at(ANSWER_MS + GRACE_MS - 600)).state.playerScore).toBe(100);
  });

  it('a wrong answer uses the tile for 0 and the player keeps picking', () => {
    const missed = answerTile(pickTile(board(), 4, at(0)).state, 3, at(1000));
    expect(missed.state).toMatchObject({ phase: 'pick', activeTile: null, playerScore: 0 });
    expect(missed.state.tiles[4]).toMatchObject({ owner: 'none', usedAt: at(1000) });
    expect(missed.events.map((e) => [e.actor, e.kind, e.tile, e.correct, e.points])).toEqual([
      ['player', 'answer', 4, false, 0],
    ]);
    expect(() => pickTile(missed.state, 4, at(2000))).toThrow(QuizBoardMoveError);
  });

  it('a timeout uses the tile for 0 at its deadline and the next pick runs from there', () => {
    const picked = pickTile(board(), 1, at(0)).state;
    const r = advance(picked, at(ANSWER_MS + GRACE_MS + 5));
    expect(r.events).toEqual([
      { actor: 'player', kind: 'timeout', tile: 1, correct: false, choice: null, points: 0, at: at(ANSWER_MS) },
    ]);
    expect(r.state).toMatchObject({ phase: 'pick', playerScore: 0 });
    expect(r.state.tiles[1].owner).toBe('none');
    expect(r.state.deadlineAt).toEqual(at(ANSWER_MS + PICK_IDLE_MS));
  });

  it('nine tiles: the score is the sum of the right ones and the play closes on the 9th answer', () => {
    let s = board();
    const right = new Set([0, 2, 4, 5, 8]);
    for (let tile = 0; tile < 9; tile += 1) {
      s = pickTile(s, tile, at(tile * 10_000)).state;
      const r = answerTile(s, right.has(tile) ? 0 : 1, at(tile * 10_000 + 2000));
      s = r.state;
      if (tile < 8) expect(s.phase).toBe('pick');
      else expect(r.events.map((e) => e.kind)).toEqual(['answer', 'end']);
    }
    expect(s).toMatchObject({ phase: 'finished', endReason: 'completed', deadlineAt: null, activeTile: null });
    expect(s.finishedAt).toEqual(at(8 * 10_000 + 2000));
    expect(s.playerScore).toBe(100 + 300 + 200 + 300 + 300);
    expect(s.playerScore).toBe(playerScoreOf(s));
  });

  it('all nine right = 1,800', () => {
    let s = board();
    for (let tile = 0; tile < 9; tile += 1) {
      s = pickTile(s, tile, at(tile * 10_000)).state;
      s = answerTile(s, 0, at(tile * 10_000 + 2000)).state;
    }
    expect(s).toMatchObject({ phase: 'finished', endReason: 'completed', playerScore: 1800 });
  });

  it('a timed-out 9th tile closes the play at that deadline, not when the server noticed', () => {
    let s = board();
    for (let tile = 0; tile < 8; tile += 1) {
      s = pickTile(s, tile, at(tile * 10_000)).state;
      s = answerTile(s, 0, at(tile * 10_000 + 1000)).state;
    }
    s = pickTile(s, 8, at(90_000)).state;
    const late = at(60 * 60_000);
    const r = advance(s, late);
    expect(r.events.map((e) => [e.kind, e.at])).toEqual([
      ['timeout', at(90_000 + ANSWER_MS)],
      ['end', at(90_000 + ANSWER_MS)],
    ]);
    expect(r.state).toMatchObject({ phase: 'finished', endReason: 'completed', playerScore: 1500 });
    expect(r.state.finishedAt).toEqual(at(90_000 + ANSWER_MS));
  });

  it('an abandoned question times out, then the idle pick ends the play at its own deadline', () => {
    const picked = pickTile(board(), 0, at(0)).state;
    expect(advance(picked, at(ANSWER_MS + GRACE_MS)).events).toEqual([]);
    const late = at(60 * 60_000);
    const r = advance(picked, late);
    expect(r.events.map((e) => [e.kind, e.at])).toEqual([
      ['timeout', at(ANSWER_MS)],
      ['end', at(ANSWER_MS + PICK_IDLE_MS)],
    ]);
    expect(r.state).toMatchObject({ phase: 'finished', endReason: 'idle', finishedAt: at(ANSWER_MS + PICK_IDLE_MS) });
  });

  it('keeps what was banked when the player leaves or the pick goes idle', () => {
    const banked = answerTile(pickTile(board(), 8, at(0)).state, 0, at(1000)).state;
    const left = leaveBoard(banked, at(2000));
    expect(left.state).toMatchObject({ phase: 'finished', endReason: 'left', playerScore: 300, finishedAt: at(2000) });
    const idle = advance(banked, at(1000 + PICK_IDLE_MS + 1));
    expect(idle.state).toMatchObject({ phase: 'finished', endReason: 'idle', playerScore: 300 });
    expect(idle.state.finishedAt).toEqual(at(1000 + PICK_IDLE_MS));
    expect(advance(banked, at(1000 + PICK_IDLE_MS)).events).toEqual([]);
    expect(leaveBoard(left.state, at(3000)).events).toEqual([]);
    // Leaving with a question open: that tile counts 0.
    const open = pickTile(banked, 7, at(3000)).state;
    expect(leaveBoard(open, at(4000)).state).toMatchObject({ endReason: 'left', playerScore: 300 });
  });

  it('a cancel (block) ends the play in any phase; a finished play stays as it is', () => {
    const s = board();
    expect(cancelBoard(s, at(1)).state).toMatchObject({ phase: 'finished', endReason: 'cancelled' });
    const open = pickTile(s, 0, at(0)).state;
    expect(cancelBoard(open, at(1)).state.endReason).toBe('cancelled');
    const left = leaveBoard(s, at(1)).state;
    expect(cancelBoard(left, at(2))).toEqual({ state: left, events: [] });
  });

  it('accepts an answer up to 1 s after its deadline (contract §7), not later', () => {
    expect(GRACE_MS).toBe(1_000);
    const picked = pickTile(board(), 0, at(0)).state;
    expect(answerTile(picked, 0, at(ANSWER_MS + 1_000)).state.playerScore).toBe(100);
    expect(() => answerTile(picked, 0, at(ANSWER_MS + 1_001))).toThrow(QuizBoardMoveError);
    expect(advance(picked, at(ANSWER_MS + 1_000)).events).toEqual([]);
    expect(advance(picked, at(ANSWER_MS + 1_001)).events[0]).toMatchObject({ kind: 'timeout', at: at(ANSWER_MS) });
  });

  it('rejects moves out of turn', () => {
    const s = board();
    expect(() => answerTile(s, 0, at(0))).toThrow(QuizBoardMoveError);
    const picked = pickTile(s, 0, at(0)).state;
    expect(() => pickTile(picked, 1, at(0))).toThrow(QuizBoardMoveError);
    expect(() => answerTile(picked, 4, at(0))).toThrow(QuizBoardMoveError);
    expect(() => pickTile(s, 9, at(0))).toThrow(QuizBoardMoveError);
    expect(() => pickTile(s, 0, at(PICK_IDLE_MS + GRACE_MS + 1))).toThrow(QuizBoardMoveError);
    const done = leaveBoard(s, at(1)).state;
    expect(() => pickTile(done, 0, at(2000))).toThrow(QuizBoardMoveError);
  });

  it('the bank always equals the right tiles, whatever the order and answers', () => {
    for (let run = 0; run < 30; run += 1) {
      let s = board();
      const order = seededOptionOrder(`seed-${run}`, 0, 9);
      let clock = 0;
      for (const tile of order) {
        clock += 1000;
        s = pickTile(s, tile, at(clock)).state;
        clock += 1000;
        s = answerTile(s, (run + tile) % 4, at(clock)).state;
      }
      expect(s.phase).toBe('finished');
      expect(s.playerScore).toBe(playerScoreOf(s));
      expect(s.playerScore).toBeLessThanOrEqual(1800);
      expect(s.tiles.every((t) => t.owner !== null)).toBe(true);
    }
  });
});

describe('quiz-board seeded option order', () => {
  it('is fixed by the seed and a permutation', () => {
    expect(seededOptionOrder('abc', 3, 4)).toEqual(seededOptionOrder('abc', 3, 4));
    expect([...seededOptionOrder('xyz', 0, 4)].sort()).toEqual([0, 1, 2, 3]);
  });
});
