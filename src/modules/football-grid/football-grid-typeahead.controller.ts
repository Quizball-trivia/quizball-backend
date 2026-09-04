import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { sql } from '../../db/index.js';

export interface FootballGridTypeaheadPlayer {
  id: string;
  nameEn: string;
  nameKa: string | null;
}

interface TypeaheadPayload {
  releaseId: string;
  /** Every published release that contributed players; the cache key, since any of them can change the roster. */
  releaseKey: string;
  players: FootballGridTypeaheadPlayer[];
}

// One payload per release, refreshed lazily: the roster only changes when a
// new content release is published, so a short in-process TTL just bounds how
// long a freshly published release takes to reach clients.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { payload: TypeaheadPayload; expiresAt: number } | null = null;

/** Admin renames drop this replica's roster at once; others refresh within the TTL. */
export function resetFootballGridTypeaheadCache(): void {
  cached = null;
}

// Board selection draws from EVERY published release (activation does not
// retire the previous one), so the roster must too — otherwise a match on an
// older board has valid answers the suggestions never show. The newest
// published release still identifies the payload for caching.
async function loadTypeaheadPayload(): Promise<TypeaheadPayload | null> {
  const rows = await sql<Array<{ release_id: string; release_key: string; id: string; name_en: string; name_ka: string | null }>>`
    WITH newest AS (
      SELECT id FROM football_grid_content_releases
      WHERE status = 'published'
      ORDER BY version DESC
      LIMIT 1
    )
    SELECT DISTINCT ON (ba.football_player_id)
      (SELECT id FROM newest) AS release_id,
      (SELECT string_agg(id::text, ',' ORDER BY id) FROM football_grid_content_releases WHERE status = 'published')
        || ':' || (SELECT md5(string_agg(coalesce(player_name_en, '') || '|' || coalesce(player_name_ka, ''), ',' ORDER BY board_id, cell_index, football_player_id))
                     FROM football_grid_board_answers) AS release_key,
      ba.football_player_id AS id,
      ba.player_name_en AS name_en,
      ba.player_name_ka AS name_ka
    FROM football_grid_board_answers ba
    JOIN football_grid_boards b ON b.id = ba.board_id
    JOIN football_grid_content_releases r ON r.id = b.release_id
    WHERE r.status = 'published'
      AND ba.player_name_en IS NOT NULL
    ORDER BY ba.football_player_id, (b.release_id = (SELECT id FROM newest)) DESC, ba.recognizable_rank ASC NULLS LAST
  `;
  if (rows.length === 0) return null;
  return {
    releaseId: rows[0].release_id,
    releaseKey: rows[0].release_key,
    players: rows
      .map((row) => ({ id: row.id, nameEn: row.name_en, nameKa: row.name_ka }))
      .sort((a, b) => a.nameEn.localeCompare(b.nameEn)),
  };
}

export const footballGridTypeaheadController = {
  /**
   * The full searchable roster for the active content release: every player
   * that appears as an answer on any published board, with bilingual display
   * names. Clients download it once per release and filter locally as the
   * user types — suggestions carry no information about which players are
   * valid for a given cell, so the list leaks nothing about the live board.
   */
  async getPlayers(req: Request, res: Response): Promise<void> {
    const now = Date.now();
    if (!cached || cached.expiresAt <= now) {
      const payload = await loadTypeaheadPayload();
      if (!payload) {
        res.json({ releaseId: null, players: [] });
        return;
      }
      cached = { payload, expiresAt: now + CACHE_TTL_MS };
    }
    const etag = `"grid-typeahead-${createHash('sha1').update(cached.payload.releaseKey).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.json(cached.payload);
  },
};
