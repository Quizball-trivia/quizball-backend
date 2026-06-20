import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { POSITION_GROUPS } from './auction.constants.js';
import type { PositionGroup } from './auction.types.js';

export type AuctionContentLocale = 'en' | 'ka';
export type AuctionContentDifficulty = 'easy' | 'medium' | 'hard';

export interface PublishedAuctionCardRow {
  clue_card_id: string;
  football_player_id: string;
  transfermarkt_id: string | number | null;
  name: string;
  image_url: string | null;
  position_group: string | null;
  position_label_en: string | null;
  position_label_ka: string | null;
  current_club: string | null;
  nationality: string | null;
  current_value_eur: string | number | null;
  peak_value_eur: string | number | null;
  locale: string;
  clue_1: string;
  clue_2: string;
  clue_3: string;
  difficulty: string;
  status: string;
  source: string;
  generation_provider: string | null;
  generation_model: string | null;
  prompt_version: string;
  evidence: Json;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
  auction_price_eur: string | number | null;
  starting_price_eur: string | number | null;
}

export interface PublishedAuctionContentAvailability {
  base_count: number;
  usable_count: number;
  missing_price_count: number;
}

export interface RandomPublishedAuctionCardOptions {
  locale: AuctionContentLocale;
  positionGroup?: PositionGroup;
  excludeClueCardIds?: string[];
}

const publishedEligiblePredicate = sql`
  status = 'published'
  AND image_url IS NOT NULL
  AND current_value_eur IS NOT NULL
  AND position_group IN ('GK', 'DEF', 'MID', 'FWD')
`;

const usablePricePredicate = sql`
  auction_price_eur IS NOT NULL
  AND starting_price_eur IS NOT NULL
`;

function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

export const auctionContentRepo = {
  async getPublishedCardCount(locale: AuctionContentLocale): Promise<number> {
    const [row] = await sql<{ count: string | number }[]>`
      SELECT COUNT(*)::text AS count
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND ${usablePricePredicate}
        AND locale = ${locale}
    `;

    return parseCount(row?.count);
  },

  async getPublishedCardAvailability(locale: AuctionContentLocale): Promise<PublishedAuctionContentAvailability> {
    const [row] = await sql<{
      base_count: string | number;
      usable_count: string | number;
      missing_price_count: string | number;
    }[]>`
      SELECT
        COUNT(*)::text AS base_count,
        COUNT(*) FILTER (
          WHERE ${usablePricePredicate}
        )::text AS usable_count,
        COUNT(*) FILTER (
          WHERE NOT (${usablePricePredicate})
        )::text AS missing_price_count
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND locale = ${locale}
    `;

    return {
      base_count: parseCount(row?.base_count),
      usable_count: parseCount(row?.usable_count),
      missing_price_count: parseCount(row?.missing_price_count),
    };
  },

  async getRandomPublishedAuctionCard(
    options: RandomPublishedAuctionCardOptions
  ): Promise<PublishedAuctionCardRow | null> {
    const excludeIds = options.excludeClueCardIds ?? [];
    const positionFilter = options.positionGroup
      ? sql`AND position_group = ${options.positionGroup}`
      : sql``;
    const excludeFilter = excludeIds.length > 0
      ? sql`AND clue_card_id <> ALL(${sql.array(excludeIds)}::uuid[])`
      : sql``;

    const [row] = await sql<PublishedAuctionCardRow[]>`
      SELECT *
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND ${usablePricePredicate}
        AND locale = ${options.locale}
        ${positionFilter}
        ${excludeFilter}
      ORDER BY random()
      LIMIT 1
    `;

    return row ?? null;
  },

  async getPublishedAuctionCardById(clueCardId: string): Promise<PublishedAuctionCardRow | null> {
    const [row] = await sql<PublishedAuctionCardRow[]>`
      SELECT *
      FROM player_clue_card_content_view
      WHERE ${publishedEligiblePredicate}
        AND locale IN ('en', 'ka')
        AND clue_card_id = ${clueCardId}
      LIMIT 1
    `;

    return row ?? null;
  },

  positionGroups(): readonly PositionGroup[] {
    return POSITION_GROUPS;
  },
};
