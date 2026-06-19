import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  AuctionCardStatus,
  AuctionCardType,
  AuctionDifficulty,
  AuctionFameBucket,
  AuctionPositionGroup,
  AuctionVerificationStatus,
  UpdateAuctionCardRequest,
} from './auction.schemas.js';

export interface AuctionCardListFilter {
  status?: AuctionCardStatus;
  positionGroup?: AuctionPositionGroup;
  cardType?: AuctionCardType;
  difficulty?: AuctionDifficulty;
  fameBucket?: AuctionFameBucket;
  verificationStatus?: AuctionVerificationStatus;
  search?: string;
}

export interface AuctionPlayerColumns {
  p_id: string;
  p_transfermarkt_id: string | null;
  p_wikidata_id: string | null;
  p_name: string;
  p_display_name: Json;
  p_nationality: string | null;
  p_nationality_code: string | null;
  p_position_group: string | null;
  p_current_club: string | null;
  p_date_of_birth: string | null;
  p_active_status: string;
  p_image_url: string | null;
  p_current_value_eur: string | number | null;
  p_peak_value_eur: string | number | null;
  p_fame_score: string | number | null;
  p_fame_bucket: string | null;
  p_data_quality_status: string;
  p_source_payload: Json;
  p_created_at: string;
  p_updated_at: string;
}

export interface AuctionCardColumns {
  id: string;
  player_id: string;
  position_group: string;
  true_value_eur: string | number;
  starting_price_eur: string | number;
  value_type: string;
  card_type: string;
  difficulty: string;
  status: string;
  generator_model: string | null;
  verifier_model: string | null;
  prompt_version: string | null;
  generation_run_id: string | null;
  verification_status: string;
  verification_notes: string | null;
  editor_notes: string | null;
  published_at: string | null;
  published_by: string | null;
  created_at: string;
  updated_at: string;
}

export type AuctionCardSummaryRow = AuctionCardColumns & AuctionPlayerColumns & {
  clue_count: number;
};

export type AuctionCardDetailRow = AuctionCardColumns & AuctionPlayerColumns & {
  gr_id: string | null;
  gr_job_name: string | null;
  gr_model_name: string | null;
  gr_model_role: string | null;
  gr_prompt_version: string | null;
  gr_status: string | null;
  gr_error_message: string | null;
  gr_latency_ms: number | null;
  gr_token_usage: Json | null;
  gr_cost_estimate: string | number | null;
  gr_editor_rating: number | null;
  gr_editor_selected: boolean | null;
  gr_created_at: string | null;
};

export interface AuctionCardClueRow {
  id: string;
  auction_card_id: string;
  clue_order: number;
  clue_en: string;
  clue_ka: string;
  clue_kind: string;
  supported_fact_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface PlayerFactRow {
  id: string;
  player_id: string;
  fact_type: string;
  fact_text_en: string;
  fact_text_ka: string | null;
  source_name: string | null;
  source_url: string | null;
  evidence_quote: string | null;
  confidence: string | number | null;
  status: string;
  discovered_by: string;
  verified_by_model: string | null;
  verifier_notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListAuctionCardsResult {
  cards: AuctionCardSummaryRow[];
  total: number;
}

function buildListFilters(filter: AuctionCardListFilter | undefined) {
  const statusFilter = filter?.status ? sql`AND ac.status = ${filter.status}` : sql``;
  const positionFilter = filter?.positionGroup ? sql`AND ac.position_group = ${filter.positionGroup}` : sql``;
  const cardTypeFilter = filter?.cardType ? sql`AND ac.card_type = ${filter.cardType}` : sql``;
  const difficultyFilter = filter?.difficulty ? sql`AND ac.difficulty = ${filter.difficulty}` : sql``;
  const fameBucketFilter = filter?.fameBucket ? sql`AND fp.fame_bucket = ${filter.fameBucket}` : sql``;
  const verificationFilter = filter?.verificationStatus
    ? sql`AND ac.verification_status = ${filter.verificationStatus}`
    : sql``;
  const searchTerm = filter?.search?.trim();
  const searchPattern = searchTerm ? `%${searchTerm}%` : null;
  const searchFilter = searchPattern
    ? sql`AND (
        fp.name ILIKE ${searchPattern}
        OR COALESCE(fp.display_name::text, '') ILIKE ${searchPattern}
        OR COALESCE(fp.current_club, '') ILIKE ${searchPattern}
        OR COALESCE(fp.nationality, '') ILIKE ${searchPattern}
      )`
    : sql``;

  return {
    statusFilter,
    positionFilter,
    cardTypeFilter,
    difficultyFilter,
    fameBucketFilter,
    verificationFilter,
    searchFilter,
  };
}

const cardSelect = sql`
  ac.id,
  ac.player_id,
  ac.position_group,
  ac.true_value_eur,
  ac.starting_price_eur,
  ac.value_type,
  ac.card_type,
  ac.difficulty,
  ac.status,
  ac.generator_model,
  ac.verifier_model,
  ac.prompt_version,
  ac.generation_run_id,
  ac.verification_status,
  ac.verification_notes,
  ac.editor_notes,
  ac.published_at,
  ac.published_by,
  ac.created_at,
  ac.updated_at,
  fp.id AS p_id,
  fp.transfermarkt_id AS p_transfermarkt_id,
  fp.wikidata_id AS p_wikidata_id,
  fp.name AS p_name,
  fp.display_name AS p_display_name,
  fp.nationality AS p_nationality,
  fp.nationality_code AS p_nationality_code,
  fp.position_group AS p_position_group,
  fp.current_club AS p_current_club,
  fp.date_of_birth AS p_date_of_birth,
  fp.active_status AS p_active_status,
  fp.image_url AS p_image_url,
  fp.current_value_eur AS p_current_value_eur,
  fp.peak_value_eur AS p_peak_value_eur,
  fp.fame_score AS p_fame_score,
  fp.fame_bucket AS p_fame_bucket,
  fp.data_quality_status AS p_data_quality_status,
  fp.source_payload AS p_source_payload,
  fp.created_at AS p_created_at,
  fp.updated_at AS p_updated_at
`;

export const auctionRepo = {
  async listCards(
    filter?: AuctionCardListFilter,
    page = 1,
    limit = 50
  ): Promise<ListAuctionCardsResult> {
    const offset = (page - 1) * limit;
    const filters = buildListFilters(filter);

    const cardsQuery = sql<AuctionCardSummaryRow[]>`
      SELECT
        ${cardSelect},
        COALESCE(clue_counts.clue_count, 0)::int AS clue_count
      FROM auction_cards ac
      JOIN football_players fp ON fp.id = ac.player_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS clue_count
        FROM auction_card_clues acl
        WHERE acl.auction_card_id = ac.id
      ) clue_counts ON true
      WHERE 1=1
        ${filters.statusFilter}
        ${filters.positionFilter}
        ${filters.cardTypeFilter}
        ${filters.difficultyFilter}
        ${filters.fameBucketFilter}
        ${filters.verificationFilter}
        ${filters.searchFilter}
      ORDER BY ac.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total
      FROM auction_cards ac
      JOIN football_players fp ON fp.id = ac.player_id
      WHERE 1=1
        ${filters.statusFilter}
        ${filters.positionFilter}
        ${filters.cardTypeFilter}
        ${filters.difficultyFilter}
        ${filters.fameBucketFilter}
        ${filters.verificationFilter}
        ${filters.searchFilter}
    `;

    const [cards, countRows] = await Promise.all([cardsQuery, countQuery]);
    return {
      cards,
      total: countRows.length > 0 ? Number.parseInt(countRows[0].total, 10) : 0,
    };
  },

  async getCardDetail(id: string): Promise<AuctionCardDetailRow | null> {
    const [row] = await sql<AuctionCardDetailRow[]>`
      SELECT
        ${cardSelect},
        gr.id AS gr_id,
        gr.job_name AS gr_job_name,
        gr.model_name AS gr_model_name,
        gr.model_role AS gr_model_role,
        gr.prompt_version AS gr_prompt_version,
        gr.status AS gr_status,
        gr.error_message AS gr_error_message,
        gr.latency_ms AS gr_latency_ms,
        gr.token_usage AS gr_token_usage,
        gr.cost_estimate AS gr_cost_estimate,
        gr.editor_rating AS gr_editor_rating,
        gr.editor_selected AS gr_editor_selected,
        gr.created_at AS gr_created_at
      FROM auction_cards ac
      JOIN football_players fp ON fp.id = ac.player_id
      LEFT JOIN llm_generation_runs gr ON gr.id = ac.generation_run_id
      WHERE ac.id = ${id}
    `;
    return row ?? null;
  },

  async getClues(cardId: string): Promise<AuctionCardClueRow[]> {
    return sql<AuctionCardClueRow[]>`
      SELECT *
      FROM auction_card_clues
      WHERE auction_card_id = ${cardId}
      ORDER BY clue_order ASC
    `;
  },

  async getFactsByIdsForPlayer(playerId: string, factIds: string[]): Promise<PlayerFactRow[]> {
    if (factIds.length === 0) return [];

    return sql<PlayerFactRow[]>`
      SELECT *
      FROM player_facts
      WHERE player_id = ${playerId}
        AND id = ANY(${sql.array(factIds)}::uuid[])
      ORDER BY created_at DESC
    `;
  },

  async updateCardAndReplaceClues(
    id: string,
    input: UpdateAuctionCardRequest
  ): Promise<AuctionCardColumns | null> {
    return sql.begin(async (tx) => {
      const card = await updateCardFields(tx, id, input);
      if (!card) return null;

      if (input.clues) {
        await tx.unsafe(
          `DELETE FROM auction_card_clues WHERE auction_card_id = $1`,
          [id]
        );

        for (const clue of input.clues) {
          await tx.unsafe(
            `INSERT INTO auction_card_clues (
              auction_card_id,
              clue_order,
              clue_en,
              clue_ka,
              clue_kind,
              supported_fact_ids
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6::uuid[]
            )`,
            [
              id,
              clue.clue_order,
              clue.clue_en,
              clue.clue_ka,
              clue.clue_kind,
              clue.supported_fact_ids,
            ]
          );
        }
      }

      return card;
    });
  },

  async updateStatus(
    id: string,
    status: AuctionCardStatus,
    publishedBy?: string,
    options?: { force?: boolean }
  ): Promise<AuctionCardColumns | null> {
    const [row] = await sql<AuctionCardColumns[]>`
      UPDATE auction_cards
      SET
        status = ${status},
        published_at = CASE WHEN ${status === 'published'} THEN NOW() ELSE published_at END,
        published_by = CASE WHEN ${status === 'published'} THEN ${publishedBy ?? null} ELSE published_by END,
        editor_notes = CASE
          WHEN ${status === 'published' && options?.force === true}::boolean
          THEN concat_ws(
            E'\n',
            NULLIF(editor_notes, ''),
            concat(
              '[force_publish] ',
              NOW()::text,
              ' by ',
              ${publishedBy ?? 'unknown'}::text,
              ' with verification_status=',
              verification_status
            )
          )
          ELSE editor_notes
        END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return row ?? null;
  },
};

async function updateCardFields(
  tx: TransactionSql,
  id: string,
  input: UpdateAuctionCardRequest
): Promise<AuctionCardColumns | null> {
  const rows = await tx.unsafe<AuctionCardColumns[]>(
    `UPDATE auction_cards
     SET
       true_value_eur = CASE WHEN $2 THEN $3 ELSE true_value_eur END,
       starting_price_eur = CASE WHEN $4 THEN $5 ELSE starting_price_eur END,
       value_type = CASE WHEN $6 THEN $7 ELSE value_type END,
       card_type = CASE WHEN $8 THEN $9 ELSE card_type END,
       difficulty = CASE WHEN $10 THEN $11 ELSE difficulty END,
       verification_status = CASE WHEN $12 THEN $13 ELSE verification_status END,
       verification_notes = CASE WHEN $14 THEN $15 ELSE verification_notes END,
       editor_notes = CASE WHEN $16 THEN $17 ELSE editor_notes END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      input.true_value_eur !== undefined,
      input.true_value_eur ?? 1,
      input.starting_price_eur !== undefined,
      input.starting_price_eur ?? 20_000_000,
      input.value_type !== undefined,
      input.value_type ?? 'current',
      input.card_type !== undefined,
      input.card_type ?? 'normal',
      input.difficulty !== undefined,
      input.difficulty ?? 'medium',
      input.verification_status !== undefined,
      input.verification_status ?? 'needs_review',
      input.verification_notes !== undefined,
      input.verification_notes ?? null,
      input.editor_notes !== undefined,
      input.editor_notes ?? null,
    ]
  );
  const [row] = rows;
  return row ?? null;
}
