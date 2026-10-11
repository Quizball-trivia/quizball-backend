import type { FootballGridDifficulty } from './football-grid.types.js';

/** Answers a category's family rate is worth when smoothing that category's own rate. */
export const GRID_DIFFICULTY_CRITERION_PRIOR = 25;
/** Answers the prediction is worth against a board's own answers. */
export const GRID_DIFFICULTY_BOARD_PRIOR = 30;
/** Answers the prediction is worth against one cell's own answers. */
export const GRID_DIFFICULTY_CELL_PRIOR = 8;
/** A board with fewer typed answers is scored mostly by prediction and reported as such. */
export const GRID_DIFFICULTY_MEASURED_MIN_ANSWERS = 30;
export const GRID_DIFFICULTY_EASY_MIN = 0.65;
export const GRID_DIFFICULTY_NORMAL_MIN = 0.5;
/** An easy board may not hide a cell most players cannot answer. */
export const GRID_DIFFICULTY_EASY_WEAKEST_MIN = 0.35;
/** A label within this distance of a band edge is left alone, so boards do not flip on a few answers. */
export const GRID_DIFFICULTY_KEEP_MARGIN = 0.02;
/** A cell answered this rarely, over at least this many tries, makes the board one to retire. */
export const GRID_DIFFICULTY_DEAD_CELL_MAX = 0.1;
export const GRID_DIFFICULTY_DEAD_CELL_MIN_ANSWERS = 12;

const RATE_FLOOR = 0.02;
const RATE_CEIL = 0.98;

export interface GridDifficultyCellKey {
  rowKey: string;
  rowFamily: string;
  colKey: string;
  colFamily: string;
}

export interface GridDifficultySample extends GridDifficultyCellKey {
  answers: number;
  correct: number;
}

export interface GridDifficultyCriterionStat {
  criterionKey: string;
  family: string;
  answers: number;
  correct: number;
  rate: number;
}

export interface GridDifficultyModel {
  globalRate: number;
  familyRates: Record<string, number>;
  criteria: Map<string, GridDifficultyCriterionStat>;
  /** Log-odds correction per family pair ("club|manager"): what two families do together beyond each alone. */
  pairAdjustments: Record<string, number>;
}

export interface GridDifficultyBoardInput {
  boardId: string;
  label: FootballGridDifficulty;
  cells: Array<GridDifficultyCellKey & { cellIndex: number; answers: number; correct: number }>;
}

export interface GridDifficultyCellScore {
  cell: number;
  answers: number;
  correct: number;
  predicted: number;
  rate: number;
}

export type GridDifficultyVerdict = 'keep' | 'move' | 'retire';

export interface GridDifficultyBoardScore {
  boardId: string;
  label: FootballGridDifficulty;
  answers: number;
  correct: number;
  predictedRate: number;
  score: number;
  weakestCellIndex: number;
  weakestCellRate: number;
  basis: 'measured' | 'predicted';
  suggested: FootballGridDifficulty;
  verdict: GridDifficultyVerdict;
  cells: GridDifficultyCellScore[];
}

function clampRate(rate: number): number {
  return Math.min(RATE_CEIL, Math.max(RATE_FLOOR, rate));
}

function logit(rate: number): number {
  const p = clampRate(rate);
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function additiveLogit(model: Omit<GridDifficultyModel, 'pairAdjustments'>, cell: GridDifficultyCellKey): number {
  const row = model.criteria.get(cell.rowKey)?.rate ?? model.familyRates[cell.rowFamily] ?? model.globalRate;
  const col = model.criteria.get(cell.colKey)?.rate ?? model.familyRates[cell.colFamily] ?? model.globalRate;
  return logit(row) + logit(col) - logit(model.globalRate);
}

/**
 * Learns how hard each category is from typed answers. A cell's chance of a right answer is modelled as the two
 * categories' own rates combined in log-odds, plus a correction per family pair.
 */
export function fitGridDifficultyModel(samples: readonly GridDifficultySample[]): GridDifficultyModel {
  let answers = 0;
  let correct = 0;
  const families = new Map<string, { answers: number; correct: number }>();
  const criteria = new Map<string, { family: string; answers: number; correct: number }>();
  for (const sample of samples) {
    if (sample.answers <= 0) continue;
    answers += sample.answers;
    correct += sample.correct;
    for (const [key, family] of [[sample.rowKey, sample.rowFamily], [sample.colKey, sample.colFamily]] as const) {
      const familyTotals = families.get(family) ?? { answers: 0, correct: 0 };
      familyTotals.answers += sample.answers;
      familyTotals.correct += sample.correct;
      families.set(family, familyTotals);
      const criterionTotals = criteria.get(key) ?? { family, answers: 0, correct: 0 };
      criterionTotals.answers += sample.answers;
      criterionTotals.correct += sample.correct;
      criteria.set(key, criterionTotals);
    }
  }
  const globalRate = answers > 0 ? correct / answers : 0.5;
  const prior = GRID_DIFFICULTY_CRITERION_PRIOR;
  const familyRates: Record<string, number> = {};
  for (const [family, totals] of families) {
    familyRates[family] = (totals.correct + globalRate * prior) / (totals.answers + prior);
  }
  const criterionStats = new Map<string, GridDifficultyCriterionStat>();
  for (const [criterionKey, totals] of criteria) {
    const familyRate = familyRates[totals.family] ?? globalRate;
    criterionStats.set(criterionKey, {
      criterionKey,
      family: totals.family,
      answers: totals.answers,
      correct: totals.correct,
      rate: (totals.correct + familyRate * prior) / (totals.answers + prior),
    });
  }
  const base = { globalRate, familyRates, criteria: criterionStats };
  const pairs = new Map<string, { answers: number; correct: number; expected: number }>();
  for (const sample of samples) {
    if (sample.answers <= 0) continue;
    const key = pairKey(sample.rowFamily, sample.colFamily);
    const totals = pairs.get(key) ?? { answers: 0, correct: 0, expected: 0 };
    totals.answers += sample.answers;
    totals.correct += sample.correct;
    totals.expected += sample.answers * sigmoid(additiveLogit(base, sample));
    pairs.set(key, totals);
  }
  const pairAdjustments: Record<string, number> = {};
  for (const [key, totals] of pairs) {
    const seen = (totals.correct + globalRate * prior) / (totals.answers + prior);
    const expected = (totals.expected + globalRate * prior) / (totals.answers + prior);
    pairAdjustments[key] = logit(seen) - logit(expected);
  }
  return { ...base, pairAdjustments };
}

export function predictGridCellRate(model: GridDifficultyModel, cell: GridDifficultyCellKey): number {
  const adjustment = model.pairAdjustments[pairKey(cell.rowFamily, cell.colFamily)] ?? 0;
  return sigmoid(additiveLogit(model, cell) + adjustment);
}

export function gridDifficultyBand(score: number, weakestCellRate: number): FootballGridDifficulty {
  if (score >= GRID_DIFFICULTY_EASY_MIN) {
    return weakestCellRate >= GRID_DIFFICULTY_EASY_WEAKEST_MIN ? 'easy' : 'normal';
  }
  return score >= GRID_DIFFICULTY_NORMAL_MIN ? 'normal' : 'hard';
}

/** A label is kept while the board is within the margin of its band, on every edge, so a few answers do not flip it. */
export function gridLabelStillFits(label: FootballGridDifficulty, score: number, weakestCellRate: number): boolean {
  const margin = GRID_DIFFICULTY_KEEP_MARGIN;
  if (label === 'easy') {
    return score >= GRID_DIFFICULTY_EASY_MIN - margin && weakestCellRate >= GRID_DIFFICULTY_EASY_WEAKEST_MIN - margin;
  }
  if (label === 'normal') {
    return score >= GRID_DIFFICULTY_NORMAL_MIN - margin
      && (score < GRID_DIFFICULTY_EASY_MIN + margin || weakestCellRate < GRID_DIFFICULTY_EASY_WEAKEST_MIN + margin);
  }
  return score < GRID_DIFFICULTY_NORMAL_MIN + margin;
}

export function scoreGridBoard(model: GridDifficultyModel, board: GridDifficultyBoardInput): GridDifficultyBoardScore {
  let answers = 0;
  let correct = 0;
  let predictedSum = 0;
  let deadCell = false;
  const cells: GridDifficultyCellScore[] = [];
  for (const cell of board.cells) {
    const predicted = predictGridCellRate(model, cell);
    const rate = (cell.correct + predicted * GRID_DIFFICULTY_CELL_PRIOR) / (cell.answers + GRID_DIFFICULTY_CELL_PRIOR);
    answers += cell.answers;
    correct += cell.correct;
    predictedSum += predicted;
    if (cell.answers >= GRID_DIFFICULTY_DEAD_CELL_MIN_ANSWERS && cell.correct / cell.answers < GRID_DIFFICULTY_DEAD_CELL_MAX) {
      deadCell = true;
    }
    cells.push({ cell: cell.cellIndex, answers: cell.answers, correct: cell.correct, predicted, rate });
  }
  cells.sort((a, b) => a.cell - b.cell);
  const predictedRate = cells.length > 0 ? predictedSum / cells.length : model.globalRate;
  const score = (correct + predictedRate * GRID_DIFFICULTY_BOARD_PRIOR) / (answers + GRID_DIFFICULTY_BOARD_PRIOR);
  const weakest = cells.reduce((low, cell) => (cell.rate < low.rate ? cell : low), cells[0] ?? {
    cell: 0, answers: 0, correct: 0, predicted: predictedRate, rate: predictedRate,
  });
  const suggested = gridDifficultyBand(score, weakest.rate);
  const fits = gridLabelStillFits(board.label, score, weakest.rate);
  return {
    boardId: board.boardId,
    label: board.label,
    answers,
    correct,
    predictedRate,
    score,
    weakestCellIndex: weakest.cell,
    weakestCellRate: weakest.rate,
    basis: answers >= GRID_DIFFICULTY_MEASURED_MIN_ANSWERS ? 'measured' : 'predicted',
    // A board to retire still gets dealt until someone retires it, so it is never offered as easy or normal.
    suggested: deadCell ? 'hard' : fits ? board.label : suggested,
    verdict: deadCell ? 'retire' : fits ? 'keep' : 'move',
    cells,
  };
}

/**
 * Where a square's play history is kept: the board's content checksum and the two criteria that cross there. The
 * checksum is the same for a board whose rows or columns were reordered or swapped, so a square's position is not
 * part of the key.
 */
export function gridDifficultyCellKey(checksum: string, rowKey: string, colKey: string): string {
  const [first, second] = rowKey < colKey ? [rowKey, colKey] : [colKey, rowKey];
  return `${checksum}:${first}|${second}`;
}
