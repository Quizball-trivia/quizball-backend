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

// Pinned matches can use older published releases, so keep their players in
// the roster. Read the small canonical-name alias set rather than scanning
// every answer placement across all releases on each cache refresh.
async function loadTypeaheadPayload(): Promise<TypeaheadPayload | null> {
  const rows = await sql<Array<{ release_id: string; release_key: string; id: string; name_en: string; name_ka: string | null }>>`
    WITH published AS MATERIALIZED (
      SELECT id, version FROM football_grid_content_releases
      WHERE status = 'published'
    ), georgian_names AS MATERIALIZED (
      SELECT DISTINCT ON (a.football_player_id)
        a.football_player_id, a.alias AS name_ka
      FROM football_grid_player_aliases a
      JOIN published r ON r.id = a.release_id
      WHERE a.locale = 'ka' AND a.alias_type = 'georgian' AND a.acceptance_policy = 'exact'
      ORDER BY a.football_player_id, r.version DESC, a.reviewed_at DESC, a.alias
    ), fallback_names AS (
      SELECT DISTINCT ON (a.football_player_id)
        a.football_player_id, a.alias AS name_ka
      FROM football_grid_player_aliases a
      JOIN published r ON r.id = a.release_id
      WHERE a.locale = 'ka' AND a.acceptance_policy = 'exact'
        AND a.alias_type <> 'georgian'
        AND NOT EXISTS (SELECT 1 FROM georgian_names g WHERE g.football_player_id = a.football_player_id)
      ORDER BY a.football_player_id, r.version DESC, a.reviewed_at DESC, a.alias
    ), names AS (
      SELECT * FROM georgian_names UNION ALL SELECT * FROM fallback_names
    )
    SELECT (SELECT id FROM published ORDER BY version DESC LIMIT 1) AS release_id,
      (SELECT string_agg(id::text, ',' ORDER BY id) FROM published)
        || ':' || coalesce((SELECT max(created_at)::text FROM football_grid_player_name_edits), '0') AS release_key,
      names.football_player_id AS id,
      coalesce(edits.name_en, players.name) AS name_en,
      coalesce(edits.name_ka, names.name_ka) AS name_ka
    FROM names
    JOIN football_players players ON players.id = names.football_player_id
    LEFT JOIN LATERAL (
      SELECT
        (SELECT name_en FROM football_grid_player_name_edits
          WHERE football_player_id = names.football_player_id AND name_en IS NOT NULL
          ORDER BY created_at DESC, id DESC LIMIT 1) AS name_en,
        (SELECT name_ka FROM football_grid_player_name_edits
          WHERE football_player_id = names.football_player_id AND name_ka IS NOT NULL
          ORDER BY created_at DESC, id DESC LIMIT 1) AS name_ka
    ) edits ON true
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
