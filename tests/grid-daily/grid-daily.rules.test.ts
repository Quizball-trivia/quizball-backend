import { describe, expect, it } from 'vitest';
import { GUESSES, SPEED_CAP_SECONDS } from '../../src/modules/grid-daily/grid-daily.constants.js';
import { fill, finish, miss, newState, publicState, rebase, score, speed } from '../../src/modules/grid-daily/grid-daily.rules.js';

const footballer = (id: string) => ({ playerId: id, name: `Name ${id}`, nameKa: null, imageUrl: null });

describe('daily grid rules', () => {
  it('starts with nine empty cells and nine guesses', () => {
    const s = newState();
    expect(s.cells).toHaveLength(9);
    expect(s.left).toBe(GUESSES);
    expect(s.done).toBe(false);
  });

  it('fills a cell with a right name and spends a guess', () => {
    const s = fill(newState(), 4, footballer('a'), 1_000);
    expect(s.cells[4]?.playerId).toBe('a');
    expect(s.left).toBe(8);
    expect(s.t0).toBe(1_000);
    expect(score(s)).toBe(1);
  });

  it('spends a guess on a wrong name and leaves the cell open', () => {
    const s = miss(newState(), 4, 1_000);
    expect(s.cells[4]).toBeNull();
    expect(s.left).toBe(8);
  });

  it('refuses a filled cell, a footballer used twice, and a cell off the board', () => {
    const s = fill(newState(), 0, footballer('a'), 0);
    expect(() => fill(s, 0, footballer('b'), 0)).toThrow('cell_filled');
    expect(() => miss(s, 0, 0)).toThrow('cell_filled');
    expect(() => fill(s, 1, footballer('a'), 0)).toThrow('player_used');
    expect(() => miss(s, 9, 0)).toThrow('bad_cell');
  });

  it('ends on the ninth guess, right or wrong, and scores the cells filled', () => {
    let s = newState();
    for (let cell = 0; cell < 8; cell += 1) s = fill(s, cell, footballer(`p${cell}`), cell * 1_000);
    expect(s.done).toBe(false);
    const perfect = fill(s, 8, footballer('p8'), 60_000);
    expect(perfect.done).toBe(true);
    expect(score(perfect)).toBe(9);
    const eight = miss(s, 8, 60_000);
    expect(eight.done).toBe(true);
    expect(score(eight)).toBe(8);
    expect(() => miss(eight, 8, 61_000)).toThrow('run_done');
  });

  it('times a run from its first guess to its finish', () => {
    let s = fill(newState(), 0, footballer('a'), 10_000);
    s = finish(s, 100_000);
    expect(s.done).toBe(true);
    expect(speed(s)).toBe(SPEED_CAP_SECONDS - 90);
    expect(speed(finish(newState(), 5_000))).toBe(SPEED_CAP_SECONDS);
    const slow = finish(fill(newState(), 0, footballer('a'), 0), 5 * 3_600_000);
    expect(speed(slow)).toBe(0);
  });

  it('starts over when a correction gives the day another board', () => {
    expect(rebase()).toEqual(newState());
  });

  it('shows the board id only for the content the run was played on', () => {
    const s = fill(newState(), 0, footballer('a'), 0);
    expect(publicState(s, '2026-10-10', { number: 4, boardId: 'board' }, { ranked: true, rank: 2 })).toMatchObject({
      day: '2026-10-10', number: 4, boardId: 'board', guessesLeft: 8, totalGuesses: 9, score: 1, ranked: true, rank: 2, done: false,
    });
    expect(publicState(s, '2026-10-10', null, { ranked: false }).boardId).toBeNull();
  });
});
