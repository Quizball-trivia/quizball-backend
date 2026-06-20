import {
  auctionContentRepo,
  type AuctionContentLocale,
  type PublishedAuctionCardRow,
  type RandomPublishedAuctionCardOptions,
} from './auction-content.repo.js';
import {
  AuctionContentUnavailableError,
  AuctionStartingPriceUnavailableError,
} from './auction.errors.js';
import type { AuctionFootballer, PositionGroup } from './auction.types.js';

export interface PublishedAuctionCard extends AuctionFootballer {
  id: string;
  footballPlayerId: string;
  clueCardId: string;
  transfermarktId: string | null;
  positionLabelEn: string | null;
  positionLabelKa: string | null;
  currentValueEur: number;
  peakValueEur: number | null;
  trueValueEur: number;
  auctionPriceEur: number;
  startingPriceEur: number;
  locale: AuctionContentLocale;
  difficulty: 'easy' | 'medium' | 'hard';
  generationProvider: string | null;
  generationModel: string | null;
  promptVersion: string;
  evidence: unknown;
  reviewNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function requirePositivePrice(
  value: string | number | null,
  field: 'auction_price_eur' | 'starting_price_eur',
  row: PublishedAuctionCardRow
): number {
  const parsed = toNumber(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AuctionStartingPriceUnavailableError({
      code: 'auction_starting_price_unavailable',
      field,
      clue_card_id: row.clue_card_id,
    });
  }
  return parsed;
}

function mapPublishedAuctionCard(row: PublishedAuctionCardRow): PublishedAuctionCard {
  const auctionPriceEur = requirePositivePrice(row.auction_price_eur, 'auction_price_eur', row);
  const startingPriceEur = requirePositivePrice(row.starting_price_eur, 'starting_price_eur', row);
  const currentValueEur = requirePositivePrice(row.current_value_eur, 'auction_price_eur', row);

  return {
    id: row.football_player_id,
    footballPlayerId: row.football_player_id,
    clueCardId: row.clue_card_id,
    transfermarktId: row.transfermarkt_id === null ? null : String(row.transfermarkt_id),
    name: row.name,
    imageUrl: row.image_url,
    positionGroup: row.position_group as PositionGroup,
    positionLabelEn: row.position_label_en,
    positionLabelKa: row.position_label_ka,
    trueValue: auctionPriceEur,
    trueValueEur: auctionPriceEur,
    auctionPriceEur,
    startingPrice: startingPriceEur,
    startingPriceEur,
    currentValueEur,
    peakValueEur: toNumber(row.peak_value_eur),
    currentClub: row.current_club,
    nationality: row.nationality,
    clues: [row.clue_1, row.clue_2, row.clue_3],
    locale: row.locale as AuctionContentLocale,
    difficulty: row.difficulty as PublishedAuctionCard['difficulty'],
    generationProvider: row.generation_provider,
    generationModel: row.generation_model,
    promptVersion: row.prompt_version,
    evidence: row.evidence,
    reviewNotes: row.review_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertPublishedAuctionContentAvailable(locale: AuctionContentLocale): Promise<void> {
  const availability = await auctionContentRepo.getPublishedCardAvailability(locale);

  if (availability.usable_count > 0) return;

  if (availability.base_count > 0 && availability.missing_price_count > 0) {
    throw new AuctionStartingPriceUnavailableError({
      code: 'auction_starting_price_unavailable',
      locale,
      ...availability,
    });
  }

  throw new AuctionContentUnavailableError({
    code: 'auction_content_unavailable',
    locale,
    ...availability,
  });
}

export const auctionContentService = {
  async getPublishedCardCount(locale: AuctionContentLocale): Promise<number> {
    return auctionContentRepo.getPublishedCardCount(locale);
  },

  async getRandomPublishedAuctionCard(
    options: RandomPublishedAuctionCardOptions
  ): Promise<PublishedAuctionCard> {
    const row = await auctionContentRepo.getRandomPublishedAuctionCard(options);

    if (!row) {
      await assertPublishedAuctionContentAvailable(options.locale);
      throw new AuctionContentUnavailableError({
        code: 'auction_content_unavailable',
        locale: options.locale,
        position_group: options.positionGroup ?? null,
        excluded_clue_card_count: options.excludeClueCardIds?.length ?? 0,
      });
    }

    return mapPublishedAuctionCard(row);
  },

  async getPublishedAuctionCardById(clueCardId: string): Promise<PublishedAuctionCard> {
    const row = await auctionContentRepo.getPublishedAuctionCardById(clueCardId);
    if (!row) {
      throw new AuctionContentUnavailableError({
        code: 'auction_content_unavailable',
        clue_card_id: clueCardId,
      });
    }
    return mapPublishedAuctionCard(row);
  },

  assertPublishedAuctionContentAvailable,
};

export type { AuctionContentLocale };
