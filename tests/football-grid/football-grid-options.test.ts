import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/index.js', () => ({ sql: vi.fn() }));

import {
  buildFootballGridOptions as build,
  footballGridMatchOptionSeed,
  type FootballGridBoardPlayer,
} from '../../src/modules/football-grid/football-grid-options.js';
import { resolvePickedOption } from '../../src/modules/football-grid/football-grid.service.js';

const SECRET = 'test-secret-for-option-order-0001';
const buildFootballGridOptions = (input: Omit<Parameters<typeof build>[0], 'secret'>) => build({ ...input, secret: SECRET });

function player(cellIndex: number, id: string, name = id): FootballGridBoardPlayer {
  return { cellIndex, playerId: id, name, nameKa: null, imageUrl: null };
}

// Cell 0 shares a row with cells 1-2 and a column with cells 3 and 6.
function board(): Map<number, FootballGridBoardPlayer[]> {
  return new Map([
    [0, [player(0, 'right-a'), player(0, 'right-b'), player(0, 'both')]],
    [1, [player(1, 'row-a'), player(1, 'both')]],
    [2, [player(2, 'row-b')]],
    [3, [player(3, 'col-a')]],
    [6, [player(6, 'col-b')]],
    [4, [player(4, 'far-a')]],
    [8, [player(8, 'far-b')]],
  ]);
}

describe('Football Tic Tac Toe pick-from-four options', () => {
  it('offers exactly one footballer who fits the cell, with three who share a category but do not', () => {
    const options = buildFootballGridOptions({ players: board(), cellIndex: 0, usedPlayerIds: new Set(), seed: 'seed-1' })!;
    expect(options).toHaveLength(4);
    const valid = options.filter((option) => ['right-a', 'right-b', 'both'].includes(option.playerId));
    expect(valid).toHaveLength(1);
    for (const option of options.filter((entry) => !valid.includes(entry))) {
      expect(['row-a', 'row-b', 'col-a', 'col-b']).toContain(option.playerId);
    }
    expect(new Set(options.map((option) => option.playerId)).size).toBe(4);
  });

  it('gives the same four for the same turn and cell, so asking again is not a re-roll', () => {
    const seed = footballGridMatchOptionSeed('match', 3, 0);
    const first = buildFootballGridOptions({ players: board(), cellIndex: 0, usedPlayerIds: new Set(), seed });
    const second = buildFootballGridOptions({ players: board(), cellIndex: 0, usedPlayerIds: new Set(), seed });
    expect(second).toEqual(first);
    expect(footballGridMatchOptionSeed('match', 4, 0)).not.toBe(seed);
  });

  it('never offers a footballer already on the board, right or wrong', () => {
    const used = new Set(['right-a', 'row-a']);
    for (let turn = 0; turn < 20; turn += 1) {
      const options = buildFootballGridOptions({ players: board(), cellIndex: 0, usedPlayerIds: used, seed: `s-${turn}` })!;
      expect(options.some((option) => used.has(option.playerId))).toBe(false);
    }
  });

  it('falls back to the rest of the board when the neighbours cannot fill three wrong options', () => {
    const players = board();
    players.delete(2);
    players.delete(3);
    const options = buildFootballGridOptions({ players, cellIndex: 0, usedPlayerIds: new Set(), seed: 'seed-2' })!;
    expect(options).toHaveLength(4);
    expect(options.some((option) => option.playerId.startsWith('far-'))).toBe(true);
  });

  it('offers nothing when every answer of the cell is used, or four distinct names do not exist', () => {
    expect(buildFootballGridOptions({
      players: board(), cellIndex: 0, usedPlayerIds: new Set(['right-a', 'right-b', 'both']), seed: 'x',
    })).toBeNull();
    const thin = new Map([[0, [player(0, 'right-a')]], [1, [player(1, 'row-a')]]]);
    expect(buildFootballGridOptions({ players: thin, cellIndex: 0, usedPlayerIds: new Set(), seed: 'x' })).toBeNull();
  });

  it('does not show two options under the same name', () => {
    const players = new Map([
      [0, [player(0, 'right-a', 'Sam Kerrow')]],
      [1, [player(1, 'twin', 'Sam Kerrow'), player(1, 'row-a', 'Ivo Dalen')]],
      [2, [player(2, 'row-b', 'Nilo Ardent')]],
      [3, [player(3, 'col-a', 'Jarek Molt')]],
    ]);
    const options = buildFootballGridOptions({ players, cellIndex: 0, usedPlayerIds: new Set(), seed: 'seed-3' })!;
    expect(options.map((option) => option.name).sort()).toEqual(['Ivo Dalen', 'Jarek Molt', 'Nilo Ardent', 'Sam Kerrow']);
    expect(options.find((option) => option.name === 'Sam Kerrow')!.playerId).toBe('right-a');
  });

  it('does not show two options under the same Georgian label either', () => {
    const players = new Map([
      [0, [{ ...player(0, 'right-a', 'Davit Mern'), nameKa: 'დავით' }]],
      [1, [{ ...player(1, 'twin', 'David Merne'), nameKa: 'დავით' }, player(1, 'row-a', 'Ivo Dalen')]],
      [2, [player(2, 'row-b', 'Nilo Ardent')]],
      [3, [player(3, 'col-a', 'Jarek Molt')]],
    ]);
    const options = buildFootballGridOptions({ players, cellIndex: 0, usedPlayerIds: new Set(), seed: 'seed-4' })!;
    expect(options.filter((option) => option.nameKa === 'დავით')).toHaveLength(1);
  });

  it('orders the four by a server secret, so the public seed alone does not give the right one away', () => {
    const wide = new Map(board());
    wide.set(1, [player(1, 'row-a'), player(1, 'row-c'), player(1, 'row-d')]);
    const positions = new Set<string>();
    for (const secret of ['secret-one-0000000000000000000001', 'secret-two-0000000000000000000002', 'secret-three-00000000000000000003', 'secret-four-000000000000000000004']) {
      const options = build({ players: wide, cellIndex: 0, usedPlayerIds: new Set(), seed: 'match:0:0', secret })!;
      positions.add(options.map((option) => option.playerId).join(','));
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  it('judges a pick by the footballer picked, whatever name was sent with it', () => {
    expect(resolvePickedOption('right-a', ['right-a', 'right-b'], 'Anything')).toMatchObject({ outcome: 'correct', playerId: 'right-a' });
    expect(resolvePickedOption('row-a', ['right-a', 'right-b'], 'right-a')).toMatchObject({ outcome: 'wrong', playerId: null });
  });
});
