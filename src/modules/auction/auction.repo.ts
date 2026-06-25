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

// The admin CMS now reads/writes the content-pipeline schema:
//   table `player_clue_cards`  (inline clue_1/clue_2/clue_3, status lifecycle)
//   view  `player_clue_card_content_view`  (player facts + auction/starting price)
// The legacy `auction_cards` / `auction_card_clues` tables are NOT used here.
// Fields the old rich schema had but this schema lacks are projected as stable
// defaults in SQL (`*_DEFAULT` aliases below) so the response shapes the CMS
// frontend depends on still type-check and render.

const CARD_TYPE_DEFAULT = 'normal';
const VALUE_TYPE_DEFAULT = 'current';
const PLAYER_ACTIVE_STATUS_DEFAULT = 'unknown';
const PLAYER_DATA_QUALITY_DEFAULT = 'usable';

function buildListFilters(filter: AuctionCardListFilter | undefined) {
  const statusFilter = filter?.status ? sql`AND v.status = ${filter.status}` : sql``;
  const positionFilter = filter?.positionGroup
    ? sql`AND v.position_group = ${filter.positionGroup}`
    : sql``;
  const difficultyFilter = filter?.difficulty ? sql`AND v.difficulty = ${filter.difficulty}` : sql``;
  const searchTerm = filter?.search?.trim();
  const searchPattern = searchTerm ? `%${searchTerm}%` : null;
  const searchFilter = searchPattern
    ? sql`AND (
        v.name ILIKE ${searchPattern}
        OR COALESCE(v.current_club, '') ILIKE ${searchPattern}
        OR COALESCE(v.nationality, '') ILIKE ${searchPattern}
      )`
    : sql``;

  return {
    statusFilter,
    positionFilter,
    difficultyFilter,
    searchFilter,
  };
}

// Maps one `player_clue_card_content_view` row onto the AuctionCardColumns +
// AuctionPlayerColumns shape. `verification_status` is derived from the clue
// card status because the new schema has no separate verification step.
const cardSelect = sql`
  v.clue_card_id AS id,
  v.football_player_id AS player_id,
  v.position_group,
  v.auction_price_eur AS true_value_eur,
  v.starting_price_eur,
  ${VALUE_TYPE_DEFAULT}::text AS value_type,
  ${CARD_TYPE_DEFAULT}::text AS card_type,
  v.difficulty,
  v.status,
  v.generation_model AS generator_model,
  NULL::text AS verifier_model,
  v.prompt_version,
  NULL::uuid AS generation_run_id,
  CASE
    WHEN v.status IN ('approved', 'published') THEN 'passed'
    WHEN v.status = 'rejected' THEN 'failed'
    ELSE 'needs_review'
  END AS verification_status,
  v.review_notes AS verification_notes,
  v.review_notes AS editor_notes,
  CASE WHEN v.status = 'published' THEN v.updated_at ELSE NULL END AS published_at,
  NULL::uuid AS published_by,
  v.created_at,
  v.updated_at,
  v.football_player_id AS p_id,
  v.transfermarkt_id::text AS p_transfermarkt_id,
  NULL::text AS p_wikidata_id,
  v.name AS p_name,
  jsonb_build_object('en', v.name) AS p_display_name,
  v.nationality AS p_nationality,
  NULL::text AS p_nationality_code,
  v.position_group AS p_position_group,
  v.current_club AS p_current_club,
  NULL::text AS p_date_of_birth,
  ${PLAYER_ACTIVE_STATUS_DEFAULT}::text AS p_active_status,
  v.image_url AS p_image_url,
  v.current_value_eur AS p_current_value_eur,
  v.peak_value_eur AS p_peak_value_eur,
  NULL::numeric AS p_fame_score,
  NULL::text AS p_fame_bucket,
  ${PLAYER_DATA_QUALITY_DEFAULT}::text AS p_data_quality_status,
  '{}'::jsonb AS p_source_payload,
  v.created_at AS p_created_at,
  v.updated_at AS p_updated_at
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
        3 AS clue_count
      FROM player_clue_card_content_view v
      WHERE 1=1
        AND v.locale = 'en'
        ${filters.statusFilter}
        ${filters.positionFilter}
        ${filters.difficultyFilter}
        ${filters.searchFilter}
      ORDER BY v.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const countQuery = sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total
      FROM player_clue_card_content_view v
      WHERE 1=1
        AND v.locale = 'en'
        ${filters.statusFilter}
        ${filters.positionFilter}
        ${filters.difficultyFilter}
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
        NULL::uuid AS gr_id,
        NULL::text AS gr_job_name,
        NULL::text AS gr_model_name,
        NULL::text AS gr_model_role,
        NULL::text AS gr_prompt_version,
        NULL::text AS gr_status,
        NULL::text AS gr_error_message,
        NULL::int AS gr_latency_ms,
        NULL::jsonb AS gr_token_usage,
        NULL::numeric AS gr_cost_estimate,
        NULL::int AS gr_editor_rating,
        NULL::boolean AS gr_editor_selected,
        NULL::timestamptz AS gr_created_at
      FROM player_clue_card_content_view v
      WHERE v.clue_card_id = ${id}
    `;
    return row ?? null;
  },

  async getClues(cardId: string): Promise<AuctionCardClueRow[]> {
    // player_clue_cards is per-locale: the requested card is the `en` row; its
    // `ka` sibling (same football_player_id, locale='ka') holds the Georgian
    // clues. Pull the EN clues from this card and the KA clues from the sibling
    // so the editor shows clue_en + clue_ka side by side. (clue_kind is a
    // constant and supported_fact_ids empty — no per-clue metadata in this schema.)
    const [card] = await sql<
      { clue_1: string; clue_2: string; clue_3: string; locale: string; football_player_id: string }[]
    >`
      SELECT clue_1, clue_2, clue_3, locale, football_player_id
      FROM player_clue_cards
      WHERE id = ${cardId}
    `;
    if (!card) return [];

    // The sibling in the OTHER locale (en card -> ka sibling, and vice versa).
    const siblingLocale = card.locale === 'en' ? 'ka' : 'en';
    const [sibling] = await sql<{ clue_1: string; clue_2: string; clue_3: string }[]>`
      SELECT clue_1, clue_2, clue_3
      FROM player_clue_cards
      WHERE football_player_id = ${card.football_player_id} AND locale = ${siblingLocale}
      LIMIT 1
    `;

    const enClues = card.locale === 'en'
      ? [card.clue_1, card.clue_2, card.clue_3]
      : [sibling?.clue_1, sibling?.clue_2, sibling?.clue_3];
    const kaClues = card.locale === 'en'
      ? [sibling?.clue_1, sibling?.clue_2, sibling?.clue_3]
      : [card.clue_1, card.clue_2, card.clue_3];

    return [0, 1, 2].map((index) => ({
      id: `${cardId}:${index + 1}`,
      auction_card_id: cardId,
      clue_order: index + 1,
      clue_en: enClues[index] ?? '',
      clue_ka: kaClues[index] ?? '',
      clue_kind: 'fact',
      supported_fact_ids: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }));
  },

  async getFactsByIdsForPlayer(_playerId: string, _factIds: string[]): Promise<PlayerFactRow[]> {
    // player_clue_cards has no player_facts linkage; clue editing never
    // references fact ids in this schema, so there is nothing to validate.
    return [];
  },

  async updateCardAndReplaceClues(
    id: string,
    input: UpdateAuctionCardRequest
  ): Promise<AuctionCardColumns | null> {
    return sql.begin(async (tx) => {
      return updateCardFields(tx, id, input);
    });
  },

  async updateStatus(
    id: string,
    status: AuctionCardStatus,
    publishedBy?: string,
    options?: { force?: boolean }
  ): Promise<AuctionCardColumns | null> {
    const forceNote =
      status === 'published' && options?.force === true
        ? `[force_publish] ${new Date().toISOString()} by ${publishedBy ?? 'unknown'}`
        : null;

    // player_clue_cards is per-locale: an `en` card and its `ka` sibling share
    // football_player_id but are separate rows. Setting the `en` card to
    // `published` must also publish its `ka` sibling so Georgian players get the
    // content at the same moment (otherwise ka rows sit in needs_review forever
    // and the game returns auction_content_unavailable). We do both writes in one
    // transaction so they commit atomically. Status changes OTHER than publish on
    // an `en` card do NOT propagate — the ka sibling is reviewed/published on its
    // own lifecycle; only the publish gate is mirrored. A ka card updated directly
    // still updates exactly one row (the sibling lookup keys off an `en` source).
    const rowId = await sql.begin(async (tx) => {
      const rows = await tx.unsafe<
        { id: string; locale: string; football_player_id: string }[]
      >(
        `UPDATE player_clue_cards
         SET
           status = $2,
           review_notes = CASE
             WHEN $3::text IS NOT NULL
             THEN concat_ws(E'\n', NULLIF(review_notes, ''), $3)
             ELSE review_notes
           END,
           updated_at = NOW()
         WHERE id = $1
         RETURNING id, locale, football_player_id`,
        [id, status, forceNote]
      );
      const [row] = rows;
      if (!row) return null;

      // Auto-publish the ka sibling only when publishing an en card. Idempotent:
      // the WHERE filters out a sibling already published, and propagating the
      // same force note is harmless. We never down-publish the sibling here.
      if (status === 'published' && row.locale === 'en') {
        await tx.unsafe(
          `UPDATE player_clue_cards
           SET
             status = 'published',
             review_notes = CASE
               WHEN $2::text IS NOT NULL
               THEN concat_ws(E'\n', NULLIF(review_notes, ''), $2)
               ELSE review_notes
             END,
             updated_at = NOW()
           WHERE football_player_id = $1
             AND locale = 'ka'
             AND status <> 'published'`,
          [row.football_player_id, forceNote]
        );
      }

      return row.id;
    });

    if (!rowId) return null;
    return auctionRepo.getCardDetail(id);
  },
};

async function updateCardFields(
  tx: TransactionSql,
  id: string,
  input: UpdateAuctionCardRequest
): Promise<AuctionCardColumns | null> {
  // The new schema has no card_type / value_type / true_value / starting_price /
  // verification columns to write, and clues are inline. We persist the editable
  // fields that exist on player_clue_cards: the 3 inline clues, difficulty, and
  // review_notes (mapped from editor_notes ?? verification_notes).
  const clue1 = input.clues?.find((c) => c.clue_order === 1)?.clue_en;
  const clue2 = input.clues?.find((c) => c.clue_order === 2)?.clue_en;
  const clue3 = input.clues?.find((c) => c.clue_order === 3)?.clue_en;
  const clueKa1 = input.clues?.find((c) => c.clue_order === 1)?.clue_ka;
  const clueKa2 = input.clues?.find((c) => c.clue_order === 2)?.clue_ka;
  const clueKa3 = input.clues?.find((c) => c.clue_order === 3)?.clue_ka;
  const reviewNotes =
    input.editor_notes !== undefined
      ? input.editor_notes
      : input.verification_notes !== undefined
        ? input.verification_notes
        : undefined;

  const rows = await tx.unsafe<{ id: string }[]>(
    `UPDATE player_clue_cards
     SET
       clue_1 = CASE WHEN $2 THEN $3 ELSE clue_1 END,
       clue_2 = CASE WHEN $4 THEN $5 ELSE clue_2 END,
       clue_3 = CASE WHEN $6 THEN $7 ELSE clue_3 END,
       difficulty = CASE WHEN $8 THEN $9 ELSE difficulty END,
       review_notes = CASE WHEN $10 THEN $11 ELSE review_notes END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING id`,
    [
      id,
      clue1 !== undefined,
      clue1 ?? '',
      clue2 !== undefined,
      clue2 ?? '',
      clue3 !== undefined,
      clue3 ?? '',
      input.difficulty !== undefined,
      input.difficulty ?? 'medium',
      reviewNotes !== undefined,
      reviewNotes ?? null,
    ]
  );
  const [row] = rows;
  if (!row) return null;

  // Edited Georgian clues persist to the ka sibling row (same football_player_id,
  // locale='ka'), since clues are stored per-locale. Only writes provided values.
  if (clueKa1 !== undefined || clueKa2 !== undefined || clueKa3 !== undefined) {
    await tx.unsafe(
      `UPDATE player_clue_cards ka
       SET
         clue_1 = CASE WHEN $2 THEN $3 ELSE clue_1 END,
         clue_2 = CASE WHEN $4 THEN $5 ELSE clue_2 END,
         clue_3 = CASE WHEN $6 THEN $7 ELSE clue_3 END,
         updated_at = NOW()
       FROM player_clue_cards en
       WHERE en.id = $1
         AND ka.football_player_id = en.football_player_id
         AND ka.locale = 'ka'`,
      [
        id,
        clueKa1 !== undefined,
        clueKa1 ?? '',
        clueKa2 !== undefined,
        clueKa2 ?? '',
        clueKa3 !== undefined,
        clueKa3 ?? '',
      ]
    );
  }

  return auctionRepo.getCardDetail(id);
}
