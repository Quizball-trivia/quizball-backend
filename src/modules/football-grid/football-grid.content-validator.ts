import { createHash } from 'node:crypto';
import type {
  FootballGridBoardCandidate,
  FootballGridDifficulty,
} from './football-grid.types.js';

export interface FootballGridContentValidationResult {
  valid: boolean;
  errors: string[];
}

function hasDistinctCellMatching(cells: FootballGridBoardCandidate['cells']): boolean {
  const playerToCell = new Map<string, number>();
  const visit = (cellIndex: number, seen: Set<string>): boolean => {
    for (const playerId of cells[cellIndex].playerIds) {
      if (seen.has(playerId)) continue;
      seen.add(playerId);
      const occupiedCell = playerToCell.get(playerId);
      if (occupiedCell === undefined || visit(occupiedCell, seen)) {
        playerToCell.set(playerId, cellIndex);
        return true;
      }
    }
    return false;
  };
  return cells.every((_cell, index) => visit(index, new Set()));
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sorted(values: string[]): string[] {
  return [...values].sort(compareCodePoints);
}

export function canonicalFootballGridBoardChecksum(
  rowCriterionKeys: [string, string, string],
  columnCriterionKeys: [string, string, string],
): string {
  const normal = `${sorted(rowCriterionKeys).join('|')}::${sorted(columnCriterionKeys).join('|')}`;
  const transposed = `${sorted(columnCriterionKeys).join('|')}::${sorted(rowCriterionKeys).join('|')}`;
  const canonical = [normal, transposed].sort(compareCodePoints)[0];
  return createHash('sha256').update(canonical).digest('hex');
}

export function validateFootballGridBoard(
  board: FootballGridBoardCandidate,
): FootballGridContentValidationResult {
  const errors: string[] = [];
  if (board.cells.length !== 9) errors.push('Board must contain exactly nine cells');
  const criterionIds = [...board.rows, ...board.columns].map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== 6) errors.push('Board criteria must be unique');
  if (board.rows.filter((criterion) => criterion.difficulty === 'hard').length > 1) {
    errors.push('Row axis contains more than one hard criterion');
  }
  if (board.columns.filter((criterion) => criterion.difficulty === 'hard').length > 1) {
    errors.push('Column axis contains more than one hard criterion');
  }
  board.cells.forEach((cell, index) => {
    if (new Set(cell.playerIds).size < 9) errors.push(`Cell ${index} has fewer than nine distinct answers`);
    const recognizable = new Set(cell.recognizablePlayerIds.filter((playerId) => cell.playerIds.includes(playerId)));
    if (recognizable.size < 2) errors.push(`Cell ${index} has fewer than two recognizable answers`);
  });
  if (board.cells.length === 9 && !hasDistinctCellMatching(board.cells)) {
    errors.push('Board does not have a nine-player distinct matching');
  }
  const expectedChecksum = canonicalFootballGridBoardChecksum(
    board.rows.map((criterion) => criterion.key) as [string, string, string],
    board.columns.map((criterion) => criterion.key) as [string, string, string],
  );
  if (board.checksum !== expectedChecksum) errors.push('Board checksum is not canonical');
  return { valid: errors.length === 0, errors };
}

export function validateFootballGridRelease(input: {
  boards: FootballGridBoardCandidate[];
  exactEnglishPlayerIds: Set<string>;
  exactGeorgianPlayerIds: Set<string>;
  tolerancePercentagePoints?: number;
}): FootballGridContentValidationResult {
  const errors = input.boards.flatMap((board) =>
    validateFootballGridBoard(board).errors.map((error) => `${board.boardId}: ${error}`),
  );
  const exposedPlayerIds = new Set(input.boards.flatMap((board) => board.cells.flatMap((cell) => cell.playerIds)));
  for (const playerId of exposedPlayerIds) {
    if (!input.exactEnglishPlayerIds.has(playerId)) errors.push(`Player ${playerId} lacks an exact English alias`);
    if (!input.exactGeorgianPlayerIds.has(playerId)) errors.push(`Player ${playerId} lacks an exact Georgian alias`);
  }
  if (input.boards.length < 1) errors.push('Release contains no boards');
  const targets: Record<FootballGridDifficulty, number> = { easy: 25, normal: 60, hard: 15 };
  const tolerance = input.tolerancePercentagePoints ?? 2;
  for (const difficulty of Object.keys(targets) as FootballGridDifficulty[]) {
    const actual = input.boards.length === 0
      ? 0
      : input.boards.filter((board) => board.difficulty === difficulty).length / input.boards.length * 100;
    if (Math.abs(actual - targets[difficulty]) > tolerance) {
      errors.push(`${difficulty} board distribution is ${actual.toFixed(2)}%, expected ${targets[difficulty]}% +/- ${tolerance}%`);
    }
  }
  return { valid: errors.length === 0, errors };
}
