import type { Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { config } from '../../core/config.js';

const querySchema = z.object({
  theme: z.string().min(1).max(32).optional(),
  release: z.enum(['draft', 'published']).default('draft'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Content-review preview for league packs: boards of the latest DRAFT (or
 * published) release grouped by theme, with per-cell answer counts and sample
 * answers. Serves the /dev tic-tac-toe harness so the owner can eyeball a
 * pack before it is activated. Exposes board answers, so it stays behind an
 * explicit env flag and auth — never enabled on prod.
 */
export const footballGridPackPreviewController = {
  async getPreview(req: Request, res: Response): Promise<void> {
    // Review tooling only: it exposes board criteria and answer samples.
    if (!config.FOOTBALL_GRID_PACK_PREVIEW_ENABLED || config.NODE_ENV === 'prod') {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query' });
      return;
    }
    const { theme, release, limit } = parsed.data;

    // The publish pipeline stages new releases as 'feasibility' (pre-launch,
    // invisible to runtime); 'draft' in the query means "latest unactivated".
    const draftStatuses = ['draft', 'feasibility'];
    const releases = await sql<Array<{ id: string; version: number; status: string }>>`
      SELECT id, version, status FROM football_grid_content_releases
      WHERE status = ANY(${release === 'draft' ? draftStatuses : ['published']})
      ORDER BY version DESC LIMIT 1
    `;
    const releaseRow = releases[0];
    if (!releaseRow) {
      res.json({ release: null, themes: [], boards: [] });
      return;
    }

    const themes = await sql<Array<{ theme: string; boards: number }>>`
      SELECT theme, count(*)::int AS boards FROM football_grid_boards
      WHERE release_id = ${releaseRow.id} GROUP BY theme ORDER BY theme
    `;

    let boards: unknown[] = [];
    if (theme) {
      const boardRows = await sql<Array<{
        id: string; difficulty: string; familiarity_score: number;
        rows: unknown; columns: unknown;
      }>>`
        SELECT b.id, b.difficulty, b.familiarity_score,
          (SELECT json_agg(json_build_object(
             'key', c.criterion_key, 'family', c.family, 'labelEn', c.label_en,
             'labelKa', c.label_ka, 'assetKey', c.asset_key, 'difficulty', c.difficulty
           ) ORDER BY ord)
           FROM unnest(b.row_criteria) WITH ORDINALITY AS r(cid, ord)
           JOIN football_grid_criteria c ON c.id = r.cid) AS rows,
          (SELECT json_agg(json_build_object(
             'key', c.criterion_key, 'family', c.family, 'labelEn', c.label_en,
             'labelKa', c.label_ka, 'assetKey', c.asset_key, 'difficulty', c.difficulty
           ) ORDER BY ord)
           FROM unnest(b.column_criteria) WITH ORDINALITY AS r(cid, ord)
           JOIN football_grid_criteria c ON c.id = r.cid) AS columns
        FROM football_grid_boards b
        WHERE b.release_id = ${releaseRow.id} AND b.theme = ${theme}
        ORDER BY b.difficulty, b.familiarity_score DESC
        LIMIT ${limit}
      `;
      const boardIds = boardRows.map((board) => board.id);
      const cells = boardIds.length > 0
        ? await sql<Array<{ board_id: string; cell_index: number; answers: number; samples: string[] }>>`
            SELECT board_id, cell_index, count(*)::int AS answers,
                   (array_agg(player_name_en ORDER BY recognizable_rank ASC NULLS LAST))[1:3] AS samples
            FROM football_grid_board_answers
            WHERE board_id = ANY(${boardIds}::uuid[])
            GROUP BY board_id, cell_index
          `
        : [];
      const cellsByBoard = new Map<string, Array<{ cell_index: number; answers: number; samples: string[] }>>();
      for (const cell of cells) {
        if (!cellsByBoard.has(cell.board_id)) cellsByBoard.set(cell.board_id, []);
        cellsByBoard.get(cell.board_id)!.push(cell);
      }
      boards = boardRows.map((board) => ({
        id: board.id,
        difficulty: board.difficulty,
        familiarityScore: Number(board.familiarity_score),
        rows: board.rows,
        columns: board.columns,
        cells: (cellsByBoard.get(board.id) ?? [])
          .sort((a, b) => a.cell_index - b.cell_index)
          .map((cell) => ({ cellIndex: cell.cell_index, answers: cell.answers, samples: cell.samples })),
      }));
    }

    res.json({
      release: { version: releaseRow.version, status: releaseRow.status },
      themes,
      boards,
    });
  },
};
