import { sql } from '../../db/index.js';

/** A footballer a published release holds in both clues of a board cell, where the board's own answer list lacks them. */
export interface FootballGridCarriedAnswer {
  cellIndex: number;
  playerId: string;
  /** The newest published release that holds both memberships: its aliases are the ones the name is read with. */
  releaseId: string;
  nameEn: string;
  nameKa: string | null;
  nameRu: string | null;
  imageUrl: string | null;
}

/**
 * A board's answer list is frozen with its release, so a reviewed correction (a club spell or league the source
 * lacked, published as a newer release) never reached a board that was already dealt: the daily grid pins its
 * boards for months. A cell is two clues, and criterion keys mean the same thing in every release, so a footballer
 * that any published release holds in both clues is right for the cell too. Answers are only ever added: the
 * board's own list stays authoritative for everything it holds.
 */
export async function loadFootballGridCarriedAnswers(boardId: string): Promise<FootballGridCarriedAnswer[]> {
  const rows = await sql<Array<{
    cell_index: number; football_player_id: string; release_id: string; name: string;
    name_ka: string | null; name_ru: string | null; image_url: string | null;
  }>>`
    WITH cells AS (
      SELECT r.i * 3 + c.i AS cell_index, rc.criterion_key AS row_key, cc.criterion_key AS col_key
        FROM football_grid_boards b
        CROSS JOIN generate_series(0, 2) AS r(i)
        CROSS JOIN generate_series(0, 2) AS c(i)
        JOIN football_grid_criteria rc ON rc.id = b.row_criteria[r.i + 1]
        JOIN football_grid_criteria cc ON cc.id = b.column_criteria[c.i + 1]
       WHERE b.id = ${boardId}
    ),
    carried AS (
      SELECT DISTINCT ON (cells.cell_index, mr.football_player_id)
             cells.cell_index, mr.football_player_id, rel.id AS release_id
        FROM cells
        JOIN football_grid_content_releases rel ON rel.status = 'published'
        JOIN football_grid_criteria rk ON rk.release_id = rel.id AND rk.criterion_key = cells.row_key
        JOIN football_grid_criteria ck ON ck.release_id = rel.id AND ck.criterion_key = cells.col_key
        JOIN football_grid_criterion_memberships mr ON mr.criterion_id = rk.id
        JOIN football_grid_criterion_memberships mc ON mc.criterion_id = ck.id AND mc.football_player_id = mr.football_player_id
       WHERE NOT EXISTS (
               SELECT 1 FROM football_grid_board_answers a
                WHERE a.board_id = ${boardId} AND a.cell_index = cells.cell_index AND a.football_player_id = mr.football_player_id
             )
       ORDER BY cells.cell_index, mr.football_player_id, rel.version DESC
    )
    SELECT carried.cell_index, carried.football_player_id, carried.release_id, fp.name, fp.image_url,
           (SELECT al.alias FROM football_grid_player_aliases al
             WHERE al.release_id = carried.release_id AND al.football_player_id = carried.football_player_id
               AND al.locale = 'ka' AND al.acceptance_policy = 'exact'
             ORDER BY al.reviewed_at DESC, al.alias LIMIT 1) AS name_ka,
           (SELECT al.alias FROM football_grid_player_aliases al
             WHERE al.release_id = carried.release_id AND al.football_player_id = carried.football_player_id
               AND al.locale = 'ru' AND al.alias_type = 'transliteration' AND al.acceptance_policy = 'exact'
             ORDER BY al.reviewed_at DESC, al.alias LIMIT 1) AS name_ru
      FROM carried
      JOIN football_players fp ON fp.id = carried.football_player_id
     ORDER BY carried.cell_index, fp.fame_score DESC NULLS LAST, carried.football_player_id
  `;
  return rows.map((row) => ({
    cellIndex: row.cell_index,
    playerId: row.football_player_id,
    releaseId: row.release_id,
    nameEn: row.name,
    nameKa: row.name_ka,
    nameRu: row.name_ru,
    imageUrl: row.image_url,
  }));
}
