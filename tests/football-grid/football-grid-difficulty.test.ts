import { describe, expect, it } from 'vitest';
import {
  fitGridDifficultyModel,
  gridDifficultyBand,
  predictGridCellRate,
  scoreGridBoard,
  type GridDifficultyBoardInput,
  type GridDifficultySample,
} from '../../src/modules/football-grid/football-grid-difficulty.js';
import { summarizeGridDifficulty } from '../../src/modules/football-grid/football-grid-difficulty.service.js';

function sample(rowKey: string, colKey: string, answers: number, correct: number): GridDifficultySample {
  return {
    rowKey, rowFamily: rowKey.split(':')[0], colKey, colFamily: colKey.split(':')[0], answers, correct,
  };
}

// Countries are easy, one manager is hard, clubs sit in between.
const SAMPLES: GridDifficultySample[] = [
  sample('country:aa', 'club:one', 400, 320),
  sample('country:aa', 'club:two', 400, 300),
  sample('country:bb', 'club:one', 400, 290),
  sample('manager:hard', 'club:one', 400, 80),
  sample('manager:hard', 'club:two', 400, 60),
  sample('manager:hard', 'country:aa', 400, 140),
  sample('club:one', 'club:two', 400, 220),
];

function board(
  label: GridDifficultyBoardInput['label'],
  rows: [string, string, string],
  columns: [string, string, string],
  counts: Record<number, [number, number]> = {},
): GridDifficultyBoardInput {
  return {
    boardId: 'board',
    label,
    cells: Array.from({ length: 9 }, (_, cellIndex) => ({
      cellIndex,
      rowKey: rows[Math.floor(cellIndex / 3)],
      rowFamily: rows[Math.floor(cellIndex / 3)].split(':')[0],
      colKey: columns[cellIndex % 3],
      colFamily: columns[cellIndex % 3].split(':')[0],
      answers: counts[cellIndex]?.[0] ?? 0,
      correct: counts[cellIndex]?.[1] ?? 0,
    })),
  };
}

describe('Football Tic Tac Toe board difficulty', () => {
  it('learns which categories are hard and predicts their cells lower', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    expect(model.criteria.get('manager:hard')!.rate).toBeLessThan(0.3);
    expect(model.criteria.get('country:aa')!.rate).toBeGreaterThan(0.6);
    const hardCell = predictGridCellRate(model, {
      rowKey: 'manager:hard', rowFamily: 'manager', colKey: 'club:one', colFamily: 'club',
    });
    const easyCell = predictGridCellRate(model, {
      rowKey: 'country:aa', rowFamily: 'country', colKey: 'club:one', colFamily: 'club',
    });
    expect(hardCell).toBeLessThan(0.35);
    expect(easyCell).toBeGreaterThan(0.65);
  });

  it('falls back to the family, then to the overall rate, for a category never played', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    const unseenManager = predictGridCellRate(model, {
      rowKey: 'manager:new', rowFamily: 'manager', colKey: 'club:one', colFamily: 'club',
    });
    const unseenFamily = predictGridCellRate(model, {
      rowKey: 'league:new', rowFamily: 'league', colKey: 'club:one', colFamily: 'club',
    });
    expect(unseenManager).toBeLessThan(unseenFamily);
    expect(unseenFamily).toBeGreaterThan(0.3);
    expect(unseenFamily).toBeLessThan(0.8);
  });

  it('survives no answers at all', () => {
    const model = fitGridDifficultyModel([]);
    expect(model.globalRate).toBe(0.5);
    const score = scoreGridBoard(model, board('normal', ['club:a', 'club:b', 'club:c'], ['country:a', 'country:b', 'country:c']));
    expect(score.basis).toBe('predicted');
    expect(score.score).toBeCloseTo(0.5, 5);
    expect(score.verdict).toBe('keep');
  });

  it('bands a score, and never calls a board easy while one cell is out of reach', () => {
    expect(gridDifficultyBand(0.7, 0.5)).toBe('easy');
    expect(gridDifficultyBand(0.7, 0.2)).toBe('normal');
    expect(gridDifficultyBand(0.55, 0.5)).toBe('normal');
    expect(gridDifficultyBand(0.4, 0.3)).toBe('hard');
  });

  it('moves an "easy" board built on a hard manager, from prediction alone', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    const score = scoreGridBoard(model, board('easy', ['manager:hard', 'country:aa', 'country:bb'], ['club:one', 'club:two', 'country:aa']));
    expect(score.basis).toBe('predicted');
    expect(score.verdict).toBe('move');
    expect(score.suggested).not.toBe('easy');
    expect(score.weakestCellIndex).toBeLessThan(3);
  });

  it('lets a board\'s own answers outweigh the prediction once there are enough', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    const rows: [string, string, string] = ['manager:hard', 'manager:hard2', 'manager:hard3'];
    const columns: [string, string, string] = ['club:one', 'club:two', 'club:three'];
    const unplayed = scoreGridBoard(model, board('hard', rows, columns));
    const counts = Object.fromEntries(Array.from({ length: 9 }, (_, cell) => [cell, [40, 34]])) as Record<number, [number, number]>;
    const played = scoreGridBoard(model, board('hard', rows, columns, counts));
    expect(unplayed.suggested).toBe('hard');
    expect(played.basis).toBe('measured');
    expect(played.score).toBeGreaterThan(0.7);
    expect(played.suggested).toBe('easy');
    expect(played.verdict).toBe('move');
  });

  it('keeps a label that is within the margin of its band edge', () => {
    const model = fitGridDifficultyModel([sample('club:a', 'country:a', 1000, 640)]);
    const counts = Object.fromEntries(Array.from({ length: 9 }, (_, cell) => [cell, [100, 64]])) as Record<number, [number, number]>;
    const score = scoreGridBoard(model, board('easy', ['club:a', 'club:a', 'club:a'], ['country:a', 'country:a', 'country:a'], counts));
    expect(score.score).toBeGreaterThan(0.63);
    expect(score.score).toBeLessThan(0.65);
    expect(score.verdict).toBe('keep');
    expect(score.suggested).toBe('easy');
  });

  it('marks a board for retirement when one cell is tried often and almost never answered', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    const counts: Record<number, [number, number]> = { 0: [20, 1], 4: [30, 25], 8: [30, 24] };
    const score = scoreGridBoard(model, board('easy', ['country:aa', 'country:bb', 'club:one'], ['club:one', 'club:two', 'country:aa'], counts));
    expect(score.verdict).toBe('retire');
    expect(score.suggested).toBe('hard');
    expect(score.weakestCellIndex).toBe(0);
  });

  it('summarises verdicts by the label in use', () => {
    const model = fitGridDifficultyModel(SAMPLES);
    const scores = [
      scoreGridBoard(model, board('easy', ['manager:hard', 'country:aa', 'country:bb'], ['club:one', 'club:two', 'country:aa'])),
      scoreGridBoard(model, board('easy', ['country:aa', 'country:bb', 'country:aa'], ['club:one', 'club:two', 'club:one'])),
    ];
    const summary = summarizeGridDifficulty(scores, model);
    expect(summary.boards).toBe(2);
    expect(summary.byLabel.easy.boards).toBe(2);
    expect(summary.byLabel.easy.move).toBe(1);
    expect(summary.byLabel.easy.keep).toBe(1);
    expect(summary.byLabel.easy.suggested.easy).toBe(1);
  });
});
