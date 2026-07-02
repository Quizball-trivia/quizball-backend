import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import '../setup.js';

vi.mock('../../src/modules/auction/auction-content.repo.js', () => ({
  auctionContentRepo: {
    getPublishedCardCount: vi.fn(),
    getPublishedCardAvailability: vi.fn(),
    getRandomPublishedAuctionCard: vi.fn(),
    getPublishedAuctionCardById: vi.fn(),
  },
}));

import { auctionContentRepo, type PublishedAuctionCardRow } from '../../src/modules/auction/auction-content.repo.js';
import { AuctionContentErrorCode } from '../../src/modules/auction/auction.errors.js';
import { auctionContentService } from '../../src/modules/auction/auction-content.service.js';

const CLUE_CARD_ID = '11111111-1111-1111-1111-111111111111';
const PLAYER_ID = '22222222-2222-2222-2222-222222222222';

const basePublishedCard = {
  clue_card_id: CLUE_CARD_ID,
  football_player_id: PLAYER_ID,
  transfermarkt_id: 123,
  name: 'Erling Haaland',
  image_url: 'https://img.example/haaland.jpg',
  position_group: 'FWD',
  position_label_en: 'Forward',
  position_label_ka: 'ფორვარდი',
  current_club: 'Manchester City',
  nationality: 'Norway',
  current_value_eur: 180_000_000,
  peak_value_eur: 200_000_000,
  locale: 'en',
  clue_1: 'Scored heavily in his first Premier League campaign.',
  clue_2: 'Won the Champions League with a Manchester club.',
  clue_3: 'Represents Norway at international level.',
  difficulty: 'easy',
  status: 'published',
  source: 'generated',
  generation_provider: 'openrouter',
  generation_model: 'google/gemini-3-flash-preview',
  prompt_version: 'v2-openrouter-localgate',
  evidence: { local_quality_passed: true },
  review_notes: null,
  created_at: '2026-06-20T00:00:00.000Z',
  updated_at: '2026-06-20T00:00:00.000Z',
  auction_price_eur: 180_000_000,
  starting_price_eur: 30_000_000,
} satisfies PublishedAuctionCardRow;

describe('auctionContentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps published card rows to runtime footballer units and currency fields', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result).toMatchObject({
      id: PLAYER_ID,
      footballPlayerId: PLAYER_ID,
      clueCardId: CLUE_CARD_ID,
      transfermarktId: '123',
      name: 'Erling Haaland',
      positionGroup: 'FWD',
      trueValue: 180_000_000,
      trueValueEur: 180_000_000,
      startingPrice: 30_000_000,
      startingPriceEur: 30_000_000,
      currentValueEur: 180_000_000,
      imageUrl: 'https://img.example/haaland.jpg',
      clues: [
        'Scored heavily in his first Premier League campaign.',
        'Won the Champions League with a Manchester club.',
        'Represents Norway at international level.',
      ],
    });
  });

  it('throws a typed no-content error when there are no published usable rows', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(null);
    (auctionContentRepo.getPublishedCardAvailability as Mock).mockResolvedValue({
      base_count: 0,
      usable_count: 0,
      missing_price_count: 0,
    });

    await expect(
      auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' })
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.CONTENT_UNAVAILABLE,
    });
  });

  it('throws a typed price error when published rows are missing price fields', async () => {
    (auctionContentRepo.getPublishedCardAvailability as Mock).mockResolvedValue({
      base_count: 1,
      usable_count: 0,
      missing_price_count: 1,
    });

    await expect(
      auctionContentService.assertPublishedAuctionContentAvailable('en')
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('rejects a returned row with a missing starting price instead of inventing a fallback', async () => {
    (auctionContentRepo.getPublishedAuctionCardById as Mock).mockResolvedValue({
      ...basePublishedCard,
      starting_price_eur: null,
    });

    await expect(
      auctionContentService.getPublishedAuctionCardById(CLUE_CARD_ID)
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('rejects a returned row with a missing true auction price instead of using current value fallback', async () => {
    (auctionContentRepo.getPublishedAuctionCardById as Mock).mockResolvedValue({
      ...basePublishedCard,
      auction_price_eur: null,
    });

    await expect(
      auctionContentService.getPublishedAuctionCardById(CLUE_CARD_ID)
    ).rejects.toMatchObject({
      auctionCode: AuctionContentErrorCode.STARTING_PRICE_UNAVAILABLE,
    });
  });

  it('passes position filters and used card exclusions through to the repo', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue(basePublishedCard);

    await auctionContentService.getRandomPublishedAuctionCard({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
    });

    expect(auctionContentRepo.getRandomPublishedAuctionCard).toHaveBeenCalledWith({
      locale: 'en',
      positionGroup: 'FWD',
      excludeClueCardIds: [CLUE_CARD_ID],
    });
  });

  it('accepts a value-decorrelated 10M starting price from the content view', async () => {
    (auctionContentRepo.getRandomPublishedAuctionCard as Mock).mockResolvedValue({
      ...basePublishedCard,
      starting_price_eur: 10_000_000,
    });

    const result = await auctionContentService.getRandomPublishedAuctionCard({ locale: 'en' });

    expect(result.startingPrice).toBe(10_000_000);
    expect(result.trueValue).toBe(180_000_000);
  });
});
