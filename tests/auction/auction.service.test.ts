import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BadRequestError } from '../../src/core/errors.js';
import '../setup.js';

vi.mock('../../src/modules/auction/auction.repo.js', () => ({
  auctionRepo: {
    listCards: vi.fn(),
    getCardDetail: vi.fn(),
    getClues: vi.fn(),
    getFactsByIdsForPlayer: vi.fn(),
    updateCardAndReplaceClues: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

import { auctionRepo, type AuctionCardDetailRow, type AuctionCardClueRow } from '../../src/modules/auction/auction.repo.js';
import { auctionService } from '../../src/modules/auction/auction.service.js';

const CARD_ID = '11111111-1111-1111-1111-111111111111';
const PLAYER_ID = '22222222-2222-2222-2222-222222222222';
const FACT_ID = '33333333-3333-3333-3333-333333333333';

const baseCard = {
  id: CARD_ID,
  player_id: PLAYER_ID,
  position_group: 'FWD',
  true_value_eur: 100_000_000,
  starting_price_eur: 20_000_000,
  value_type: 'current',
  card_type: 'normal',
  difficulty: 'medium',
  status: 'needs_review',
  generator_model: 'generator',
  verifier_model: 'verifier',
  prompt_version: 'auction-v1',
  generation_run_id: null,
  verification_status: 'needs_review',
  verification_notes: null,
  editor_notes: null,
  published_at: null,
  published_by: null,
  created_at: '2026-06-19T00:00:00.000Z',
  updated_at: '2026-06-19T00:00:00.000Z',
  p_id: PLAYER_ID,
  p_transfermarkt_id: 'tm-1',
  p_wikidata_id: 'Q1',
  p_name: 'Lionel Messi',
  p_display_name: { en: 'Lionel Messi', ka: 'ლიონელ მესი' },
  p_nationality: 'Argentina',
  p_nationality_code: 'AR',
  p_position_group: 'FWD',
  p_current_club: 'Inter Miami',
  p_date_of_birth: '1987-06-24',
  p_active_status: 'active',
  p_image_url: null,
  p_current_value_eur: 30_000_000,
  p_peak_value_eur: 180_000_000,
  p_fame_score: 100,
  p_fame_bucket: 'superstar',
  p_data_quality_status: 'usable',
  p_source_payload: {},
  p_created_at: '2026-06-19T00:00:00.000Z',
  p_updated_at: '2026-06-19T00:00:00.000Z',
  gr_id: null,
  gr_job_name: null,
  gr_model_name: null,
  gr_model_role: null,
  gr_prompt_version: null,
  gr_status: null,
  gr_error_message: null,
  gr_latency_ms: null,
  gr_token_usage: null,
  gr_cost_estimate: null,
  gr_editor_rating: null,
  gr_editor_selected: null,
  gr_created_at: null,
} satisfies AuctionCardDetailRow;

const threeClues: AuctionCardClueRow[] = [1, 2, 3].map((order) => ({
  id: `44444444-4444-4444-4444-44444444444${order}`,
  auction_card_id: CARD_ID,
  clue_order: order,
  clue_en: `Clue ${order}`,
  clue_ka: `მინიშნება ${order}`,
  clue_kind: 'fact',
  supported_fact_ids: [],
  created_at: '2026-06-19T00:00:00.000Z',
  updated_at: '2026-06-19T00:00:00.000Z',
}));

describe('auctionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (auctionRepo.getFactsByIdsForPlayer as Mock).mockResolvedValue([]);
  });

  it('blocks publish when verification has not passed unless force is true', async () => {
    (auctionRepo.getCardDetail as Mock).mockResolvedValue(baseCard);
    (auctionRepo.getClues as Mock).mockResolvedValue(threeClues);

    await expect(
      auctionService.updateStatus(CARD_ID, { status: 'published', force: false }, 'admin-user-id')
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(auctionRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('blocks publish when the card does not have exactly 3 clues', async () => {
    (auctionRepo.getCardDetail as Mock).mockResolvedValue({
      ...baseCard,
      verification_status: 'passed',
    });
    (auctionRepo.getClues as Mock).mockResolvedValue(threeClues.slice(0, 2));

    await expect(
      auctionService.updateStatus(CARD_ID, { status: 'published', force: false }, 'admin-user-id')
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(auctionRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('allows forced publish with non-passed verification when structural rules pass', async () => {
    (auctionRepo.getCardDetail as Mock)
      .mockResolvedValueOnce(baseCard)
      .mockResolvedValueOnce({
        ...baseCard,
        status: 'published',
        published_at: '2026-06-19T01:00:00.000Z',
        published_by: 'admin-user-id',
      });
    (auctionRepo.getClues as Mock).mockResolvedValue(threeClues);
    (auctionRepo.updateStatus as Mock).mockResolvedValue({
      ...baseCard,
      status: 'published',
    });

    const result = await auctionService.updateStatus(
      CARD_ID,
      { status: 'published', force: true },
      'admin-user-id'
    );

    expect(result.status).toBe('published');
    expect(auctionRepo.updateStatus).toHaveBeenCalledWith(CARD_ID, 'published', 'admin-user-id');
  });

  it('rejects clue fact ids that do not belong to the card player', async () => {
    (auctionRepo.getCardDetail as Mock).mockResolvedValue(baseCard);
    (auctionRepo.getFactsByIdsForPlayer as Mock).mockResolvedValue([]);

    await expect(
      auctionService.updateCard(CARD_ID, {
        clues: [
          { clue_order: 1, clue_en: 'A', clue_ka: 'ა', clue_kind: 'fact', supported_fact_ids: [FACT_ID] },
          { clue_order: 2, clue_en: 'B', clue_ka: 'ბ', clue_kind: 'fact', supported_fact_ids: [] },
          { clue_order: 3, clue_en: 'C', clue_ka: 'გ', clue_kind: 'fact', supported_fact_ids: [] },
        ],
      })
    ).rejects.toBeInstanceOf(BadRequestError);

    expect(auctionRepo.getFactsByIdsForPlayer).toHaveBeenCalledWith(PLAYER_ID, [FACT_ID]);
    expect(auctionRepo.updateCardAndReplaceClues).not.toHaveBeenCalled();
  });
});
