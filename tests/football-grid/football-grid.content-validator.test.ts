import { describe, expect, it, vi } from 'vitest';
import {
  canonicalFootballGridBoardChecksum,
  validateFootballGridBoard,
  validateFootballGridRelease,
  type FootballGridBoardCandidate,
} from '../../src/modules/football-grid/index.js';

function candidate(id: string, difficulty: FootballGridBoardCandidate['difficulty']): FootballGridBoardCandidate {
  const criterion = (key: string) => ({
    id: key,
    key,
    family: 'club' as const,
    labelEn: key,
    labelKa: key,
    assetKey: null,
    difficulty: 'normal' as const,
  });
  const rows = [criterion(`${id}-r1`), criterion(`${id}-r2`), criterion(`${id}-r3`)] as const;
  const columns = [criterion(`${id}-c1`), criterion(`${id}-c2`), criterion(`${id}-c3`)] as const;
  return {
    boardId: id,
    releaseId: 'release',
    version: 1,
    checksum: canonicalFootballGridBoardChecksum(
      rows.map((item) => item.key) as [string, string, string],
      columns.map((item) => item.key) as [string, string, string],
    ),
    difficulty,
    rows: [...rows],
    columns: [...columns],
    cells: Array.from({ length: 9 }, (_unused, cell) => ({
      playerIds: Array.from({ length: 9 }, (_value, player) => `p-${cell}-${player}`),
      recognizablePlayerIds: [`p-${cell}-0`, `p-${cell}-1`],
    })),
  };
}

describe('football grid content validation', () => {
  it('canonicalizes row/column ordering and transpose symmetry', () => {
    const first = canonicalFootballGridBoardChecksum(['a', 'b', 'c'], ['d', 'e', 'f']);
    const reordered = canonicalFootballGridBoardChecksum(['c', 'a', 'b'], ['f', 'd', 'e']);
    const transposed = canonicalFootballGridBoardChecksum(['d', 'e', 'f'], ['a', 'b', 'c']);
    expect(first).toBe(reordered);
    expect(first).toBe(transposed);
  });

  it('does not depend on runtime locale collation for persisted checksums', () => {
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
      throw new Error('locale collation must not be used');
    });
    try {
      expect(canonicalFootballGridBoardChecksum(
        ['თბილისი', 'a', 'é'],
        ['ზ', 'b', 'ä'],
      )).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      localeCompare.mockRestore();
    }
  });

  it('requires nine distinct and two recognizable answers in every cell', () => {
    const board = candidate('b1', 'normal');
    expect(validateFootballGridBoard(board)).toEqual({ valid: true, errors: [] });
    board.cells[3].playerIds = board.cells[3].playerIds.slice(0, 8);
    board.cells[4].recognizablePlayerIds = [board.cells[4].playerIds[0]];
    const result = validateFootballGridBoard(board);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Cell 3 has fewer than 9 distinct answers');
    expect(result.errors).toContain('Cell 4 has fewer than two recognizable answers');
  });

  it('validates release difficulty distribution and exact EN/KA coverage', () => {
    const boards = [
      ...Array.from({ length: 40 }, (_, index) => candidate(`easy-${index}`, 'easy')),
      ...Array.from({ length: 45 }, (_, index) => candidate(`normal-${index}`, 'normal')),
      ...Array.from({ length: 15 }, (_, index) => candidate(`hard-${index}`, 'hard')),
    ];
    const players = new Set(boards.flatMap((board) => board.cells.flatMap((cell) => cell.playerIds)));
    expect(validateFootballGridRelease({
      boards,
      exactEnglishPlayerIds: players,
      exactGeorgianPlayerIds: players,
    })).toEqual({ valid: true, errors: [] });
  });
});
