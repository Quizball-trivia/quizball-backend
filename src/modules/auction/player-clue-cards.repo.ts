import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  ClueCardDifficulty,
  ClueCardLocale,
  ClueCardStatus,
  FootballPlayerCandidate,
  PlayerClueCardDetail,
  PlayerClueCardRow,
} from './player-clue-cards.types.js';
import { normalizeText, resolveAlias } from './player-clue-cards.aliases.js';

export interface FootballPlayerRow {
  id: string;
  transfermarkt_id: string | null;
  name: string;
  nationality: string | null;
  position_group: string | null;
  current_club: string | null;
  image_url: string | null;
  current_value_eur: string | number | null;
}

export interface MatchResult {
  matchStatus: 'matched' | 'ambiguous' | 'unmatched';
  matchedPlayer: FootballPlayerCandidate | null;
  candidates: FootballPlayerCandidate[];
  matchMethod: 'exact' | 'normalized' | 'alias' | null;
  matchConfidence: 'high' | 'medium' | 'low' | null;
}

function toCandidate(row: FootballPlayerRow): FootballPlayerCandidate {
  return {
    footballPlayerId: row.id,
    transfermarktId: row.transfermarkt_id ? parseInt(row.transfermarkt_id, 10) : null,
    name: row.name,
    currentClub: row.current_club,
    nationality: row.nationality,
    positionGroup: row.position_group,
    imageUrl: row.image_url,
    currentValueEur: row.current_value_eur === null ? null : Number(row.current_value_eur),
    normalizedName: normalizeText(row.name),
  };
}

export const playerClueCardsRepo = {
  async matchPlayerByName(answerName: string): Promise<MatchResult> {
    const normalized = normalizeText(answerName);
    if (!normalized) {
      return { matchStatus: 'unmatched', matchedPlayer: null, candidates: [], matchMethod: null, matchConfidence: null };
    }

    const exactRows = await sql<FootballPlayerRow[]>`
      SELECT id, transfermarkt_id, name, nationality, position_group, current_club, image_url, current_value_eur
      FROM football_players
      WHERE LOWER(name) = LOWER(${answerName})
      LIMIT 10
    `;

    if (exactRows.length === 1) {
      return {
        matchStatus: 'matched',
        matchedPlayer: toCandidate(exactRows[0]),
        candidates: [],
        matchMethod: 'exact',
        matchConfidence: 'high',
      };
    }
    if (exactRows.length > 1) {
      return {
        matchStatus: 'ambiguous',
        matchedPlayer: null,
        candidates: exactRows.map(toCandidate),
        matchMethod: 'exact',
        matchConfidence: 'medium',
      };
    }

    const aliasResolved = resolveAlias(answerName);
    if (aliasResolved) {
      const aliasRows = await sql<FootballPlayerRow[]>`
        SELECT id, transfermarkt_id, name, nationality, position_group, current_club, image_url, current_value_eur
        FROM football_players
        WHERE LOWER(name) = LOWER(${aliasResolved})
        LIMIT 10
      `;

      if (aliasRows.length === 1) {
        return {
          matchStatus: 'matched',
          matchedPlayer: toCandidate(aliasRows[0]),
          candidates: [],
          matchMethod: 'alias',
          matchConfidence: 'high',
        };
      }
      if (aliasRows.length > 1) {
        return {
          matchStatus: 'ambiguous',
          matchedPlayer: null,
          candidates: aliasRows.map(toCandidate),
          matchMethod: 'alias',
          matchConfidence: 'medium',
        };
      }
    }

    const normalizedRows = await sql<FootballPlayerRow[]>`
      SELECT id, transfermarkt_id, name, nationality, position_group, current_club, image_url, current_value_eur
      FROM football_players
      WHERE LOWER(
        translate(
          unaccent(name),
          'áàâäãåéèêëíìîïóòôöõúùûüçñÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÇÑ',
          'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'
        )
      ) = ${normalized}
      LIMIT 10
    `;

    if (normalizedRows.length === 1) {
      return {
        matchStatus: 'matched',
        matchedPlayer: toCandidate(normalizedRows[0]),
        candidates: [],
        matchMethod: 'normalized',
        matchConfidence: 'high',
      };
    }
    if (normalizedRows.length > 1) {
      return {
        matchStatus: 'ambiguous',
        matchedPlayer: null,
        candidates: normalizedRows.map(toCandidate),
        matchMethod: 'normalized',
        matchConfidence: 'medium',
      };
    }

    const searchRows = await sql<FootballPlayerRow[]>`
      SELECT id, transfermarkt_id, name, nationality, position_group, current_club, image_url, current_value_eur
      FROM football_players
      WHERE name ILIKE ${'%' + answerName + '%'}
      LIMIT 10
    `;

    if (searchRows.length >= 1) {
      return {
        matchStatus: searchRows.length === 1 ? 'matched' : 'ambiguous',
        matchedPlayer: searchRows.length === 1 ? toCandidate(searchRows[0]) : null,
        candidates: searchRows.map(toCandidate),
        matchMethod: 'normalized',
        matchConfidence: searchRows.length === 1 ? 'low' : 'low',
      };
    }

    return {
      matchStatus: 'unmatched',
      matchedPlayer: null,
      candidates: [],
      matchMethod: null,
      matchConfidence: null,
    };
  },

  async upsertPlayerClueCard(params: {
    footballPlayerId: string;
    locale: ClueCardLocale;
    clue1: string;
    clue2: string;
    clue3: string;
    difficulty: ClueCardDifficulty;
    status: ClueCardStatus;
    source: 'cms' | 'imported';
    generationProvider: string;
    generationModel: string;
    promptVersion: string;
    evidence: Record<string, unknown>;
    sourcePayload: Record<string, unknown>;
    force: boolean;
  }): Promise<{ row: PlayerClueCardRow | null; action: 'inserted' | 'updated' | 'skipped_existing' }> {
    const conflictTarget = '(football_player_id, locale, prompt_version)';

    if (params.force) {
      const [row] = await sql<PlayerClueCardRow[]>`
        INSERT INTO player_clue_cards (
          football_player_id, locale, clue_1, clue_2, clue_3,
          difficulty, status, source, generation_provider, generation_model,
          prompt_version, evidence, source_payload
        )
        VALUES (
          ${params.footballPlayerId}, ${params.locale}, ${params.clue1}, ${params.clue2}, ${params.clue3},
          ${params.difficulty}, ${params.status}, ${params.source}, ${params.generationProvider}, ${params.generationModel},
          ${params.promptVersion}, ${sql.json(params.evidence as unknown as Json)}, ${sql.json(params.sourcePayload as unknown as Json)}
        )
        ON CONFLICT ${sql.unsafe(conflictTarget)} DO UPDATE SET
          clue_1 = EXCLUDED.clue_1,
          clue_2 = EXCLUDED.clue_2,
          clue_3 = EXCLUDED.clue_3,
          difficulty = EXCLUDED.difficulty,
          status = EXCLUDED.status,
          source = EXCLUDED.source,
          generation_provider = EXCLUDED.generation_provider,
          generation_model = EXCLUDED.generation_model,
          evidence = EXCLUDED.evidence,
          source_payload = EXCLUDED.source_payload,
          updated_at = NOW()
        RETURNING *
      `;
      const wasInsert = row && row.created_at === row.updated_at;
      return { row: row ?? null, action: wasInsert ? 'inserted' : 'updated' };
    }

    const [row] = await sql<PlayerClueCardRow[]>`
      INSERT INTO player_clue_cards (
        football_player_id, locale, clue_1, clue_2, clue_3,
        difficulty, status, source, generation_provider, generation_model,
        prompt_version, evidence, source_payload
      )
      VALUES (
        ${params.footballPlayerId}, ${params.locale}, ${params.clue1}, ${params.clue2}, ${params.clue3},
        ${params.difficulty}, ${params.status}, ${params.source}, ${params.generationProvider}, ${params.generationModel},
        ${params.promptVersion}, ${sql.json(params.evidence as unknown as Json)}, ${sql.json(params.sourcePayload as unknown as Json)}
      )
      ON CONFLICT ${sql.unsafe(conflictTarget)} DO NOTHING
      RETURNING *
    `;

    if (row) {
      return { row, action: 'inserted' };
    }
    return { row: null, action: 'skipped_existing' };
  },

  async getPlayerClueCardById(id: string): Promise<PlayerClueCardDetail | null> {
    const [row] = await sql<Array<PlayerClueCardRow & {
      player_name: string;
      player_image_url: string | null;
      player_position_group: string | null;
      player_nationality: string | null;
      player_current_club: string | null;
    }>>`
      SELECT pcc.*, fp.name AS player_name, fp.image_url AS player_image_url,
             fp.position_group AS player_position_group, fp.nationality AS player_nationality,
             fp.current_club AS player_current_club
      FROM player_clue_cards pcc
      JOIN football_players fp ON fp.id = pcc.football_player_id
      WHERE pcc.id = ${id}
    `;

    if (!row) return null;

    const { player_name, player_image_url, player_position_group, player_nationality, player_current_club, ...cardRow } = row;

    return {
      ...cardRow,
      evidence: cardRow.evidence as Record<string, unknown>,
      source_payload: cardRow.source_payload as Record<string, unknown>,
      playerName: player_name,
      playerImageUrl: player_image_url,
      playerPositionGroup: player_position_group,
      playerNationality: player_nationality,
      playerCurrentClub: player_current_club,
    };
  },

  async updatePlayerClueCardStatus(
    id: string,
    status: ClueCardStatus,
    reviewNotes: string | null,
    rejectionReason: string | null
  ): Promise<PlayerClueCardRow | null> {
    // player_clue_cards is per-locale: an `en` card and its `ka` sibling share
    // football_player_id but are separate rows. Publishing an `en` card must also
    // publish its `ka` sibling (same as the auction review endpoint) so Georgian
    // players get the content at the same moment — otherwise ka rows sit in
    // needs_review forever and the game returns auction_content_unavailable.
    // Both writes run in one transaction. Only the publish gate is mirrored.
    return sql.begin(async (tx) => {
      const [row] = await tx.unsafe<PlayerClueCardRow[]>(
        `UPDATE player_clue_cards
         SET status = $2, review_notes = $3, rejection_reason = $4, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, status, reviewNotes, rejectionReason]
      );
      if (!row) return null;

      if (status === 'published' && row.locale === 'en') {
        await tx.unsafe(
          `UPDATE player_clue_cards
           SET status = 'published', updated_at = NOW()
           WHERE football_player_id = $1 AND locale = 'ka' AND status <> 'published'`,
          [row.football_player_id]
        );
      }
      return row;
    });
  },

  async bulkUpdateStatus(
    ids: string[],
    status: ClueCardStatus,
    reviewNotes: string | null
  ): Promise<number> {
    return sql.begin(async (tx) => {
      const result = await tx.unsafe(
        `UPDATE player_clue_cards
         SET status = $2, review_notes = $3, updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [ids, status, reviewNotes]
      );

      // Cascade publish to the ka siblings of every en card just published.
      if (status === 'published') {
        await tx.unsafe(
          `UPDATE player_clue_cards ka
           SET status = 'published', updated_at = NOW()
           FROM player_clue_cards en
           WHERE en.id = ANY($1::uuid[])
             AND en.locale = 'en'
             AND ka.football_player_id = en.football_player_id
             AND ka.locale = 'ka'
             AND ka.status <> 'published'`,
          [ids]
        );
      }
      return result.count;
    });
  },
};
