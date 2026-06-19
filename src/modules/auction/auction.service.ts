import { z } from 'zod';
import { AuthorizationError, BadRequestError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import {
  auctionRepo,
  type AuctionCardDetailRow,
  type AuctionCardListFilter,
  type AuctionCardSummaryRow,
  type AuctionCardClueRow,
  type PlayerFactRow,
} from './auction.repo.js';
import type {
  AuctionCardDetail,
  AuctionCardSummary,
  AuctionPlayerDetail,
  AuctionPlayerSummary,
  LlmGenerationRunSummary,
  PlayerFact,
  UpdateAuctionCardRequest,
  UpdateAuctionCardStatusRequest,
} from './auction.schemas.js';

const AUCTION_MIN_STARTING_PRICE_EUR = 20_000_000;
const uuidSchema = z.string().uuid();

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toPlayerSummary(row: AuctionCardSummaryRow | AuctionCardDetailRow): AuctionPlayerSummary {
  return {
    id: row.p_id,
    name: row.p_name,
    display_name: toJsonRecord(row.p_display_name),
    nationality: row.p_nationality,
    nationality_code: row.p_nationality_code,
    position_group: row.p_position_group as AuctionPlayerSummary['position_group'],
    current_club: row.p_current_club,
    active_status: row.p_active_status as AuctionPlayerSummary['active_status'],
    image_url: row.p_image_url,
    fame_score: toNumber(row.p_fame_score),
    fame_bucket: row.p_fame_bucket as AuctionPlayerSummary['fame_bucket'],
    data_quality_status: row.p_data_quality_status as AuctionPlayerSummary['data_quality_status'],
  };
}

function toPlayerDetail(row: AuctionCardDetailRow): AuctionPlayerDetail {
  return {
    ...toPlayerSummary(row),
    transfermarkt_id: row.p_transfermarkt_id,
    wikidata_id: row.p_wikidata_id,
    date_of_birth: row.p_date_of_birth,
    current_value_eur: toNumber(row.p_current_value_eur),
    peak_value_eur: toNumber(row.p_peak_value_eur),
    source_payload: toJsonRecord(row.p_source_payload),
    created_at: row.p_created_at,
    updated_at: row.p_updated_at,
  };
}

function toCardSummary(row: AuctionCardSummaryRow): AuctionCardSummary {
  return {
    id: row.id,
    player_id: row.player_id,
    position_group: row.position_group as AuctionCardSummary['position_group'],
    true_value_eur: toNumber(row.true_value_eur) ?? 0,
    starting_price_eur: toNumber(row.starting_price_eur) ?? 0,
    value_type: row.value_type as AuctionCardSummary['value_type'],
    card_type: row.card_type as AuctionCardSummary['card_type'],
    difficulty: row.difficulty as AuctionCardSummary['difficulty'],
    status: row.status as AuctionCardSummary['status'],
    verification_status: row.verification_status as AuctionCardSummary['verification_status'],
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    player: toPlayerSummary(row),
    clue_count: row.clue_count,
  };
}

function toClue(row: AuctionCardClueRow): AuctionCardDetail['clues'][number] {
  return {
    id: row.id,
    auction_card_id: row.auction_card_id,
    clue_order: row.clue_order,
    clue_en: row.clue_en,
    clue_ka: row.clue_ka,
    clue_kind: row.clue_kind,
    supported_fact_ids: row.supported_fact_ids,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toFact(row: PlayerFactRow): PlayerFact {
  return {
    id: row.id,
    player_id: row.player_id,
    fact_type: row.fact_type,
    fact_text_en: row.fact_text_en,
    fact_text_ka: row.fact_text_ka,
    source_name: row.source_name,
    source_url: row.source_url,
    evidence_quote: row.evidence_quote,
    confidence: toNumber(row.confidence),
    status: row.status as PlayerFact['status'],
    discovered_by: row.discovered_by as PlayerFact['discovered_by'],
    verified_by_model: row.verified_by_model,
    verifier_notes: row.verifier_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toGenerationRunSummary(row: AuctionCardDetailRow): LlmGenerationRunSummary | null {
  if (!row.gr_id) return null;
  return {
    id: row.gr_id,
    job_name: row.gr_job_name ?? '',
    model_name: row.gr_model_name ?? '',
    model_role: row.gr_model_role as LlmGenerationRunSummary['model_role'],
    prompt_version: row.gr_prompt_version ?? '',
    status: row.gr_status as LlmGenerationRunSummary['status'],
    error_message: row.gr_error_message,
    latency_ms: row.gr_latency_ms,
    token_usage: toJsonRecord(row.gr_token_usage),
    cost_estimate: toNumber(row.gr_cost_estimate),
    editor_rating: row.gr_editor_rating,
    editor_selected: row.gr_editor_selected ?? false,
    created_at: row.gr_created_at ?? row.created_at,
  };
}

function toCardDetail(
  row: AuctionCardDetailRow,
  clues: AuctionCardClueRow[],
  facts: PlayerFactRow[]
): AuctionCardDetail {
  return {
    id: row.id,
    player_id: row.player_id,
    position_group: row.position_group as AuctionCardDetail['position_group'],
    true_value_eur: toNumber(row.true_value_eur) ?? 0,
    starting_price_eur: toNumber(row.starting_price_eur) ?? 0,
    value_type: row.value_type as AuctionCardDetail['value_type'],
    card_type: row.card_type as AuctionCardDetail['card_type'],
    difficulty: row.difficulty as AuctionCardDetail['difficulty'],
    status: row.status as AuctionCardDetail['status'],
    generator_model: row.generator_model,
    verifier_model: row.verifier_model,
    prompt_version: row.prompt_version,
    generation_run_id: row.generation_run_id,
    verification_status: row.verification_status as AuctionCardDetail['verification_status'],
    verification_notes: row.verification_notes,
    editor_notes: row.editor_notes,
    published_at: row.published_at,
    published_by: row.published_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    player: toPlayerDetail(row),
    clues: clues.map(toClue),
    supported_facts: facts.map(toFact),
    generation_run: toGenerationRunSummary(row),
  };
}

function uniqueFactIds(input: UpdateAuctionCardRequest): string[] {
  const ids = input.clues?.flatMap((clue) => clue.supported_fact_ids) ?? [];
  return [...new Set(ids)];
}

function requirePublishUserId(userId: string | undefined): string {
  const result = uuidSchema.safeParse(userId);
  if (!result.success) {
    throw new AuthorizationError('A valid authenticated admin user is required to publish auction cards');
  }
  return result.data;
}

function validatePublishClues(clues: AuctionCardClueRow[]): string[] {
  const errors: string[] = [];

  if (clues.length !== 3) {
    errors.push('Card must have exactly 3 clues');
    return errors;
  }

  const orders = clues.map((clue) => clue.clue_order).sort((a, b) => a - b);
  if (orders[0] !== 1 || orders[1] !== 2 || orders[2] !== 3) {
    errors.push('clue_order values must be exactly 1, 2, and 3');
  }

  for (const clue of clues) {
    if (!clue.clue_en.trim()) {
      errors.push(`clue_en is required for clue_order ${clue.clue_order}`);
    }
    if (!clue.clue_ka.trim()) {
      errors.push(`clue_ka is required for clue_order ${clue.clue_order}`);
    }
  }

  return errors;
}

async function validateSupportedFactIds(playerId: string, input: UpdateAuctionCardRequest): Promise<void> {
  const factIds = uniqueFactIds(input);
  if (factIds.length === 0) return;

  const facts = await auctionRepo.getFactsByIdsForPlayer(playerId, factIds);
  const found = new Set(facts.map((fact) => fact.id));
  const missing = factIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BadRequestError('All supported_fact_ids must exist and belong to the card player', {
      missing_fact_ids: missing,
    });
  }
}

export const auctionService = {
  async listCards(
    filter?: AuctionCardListFilter,
    page = 1,
    limit = 50
  ) {
    const { cards, total } = await auctionRepo.listCards(filter, page, limit);
    return {
      data: cards.map(toCardSummary),
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    };
  },

  async getCardById(id: string): Promise<AuctionCardDetail> {
    const card = await auctionRepo.getCardDetail(id);
    if (!card) throw new NotFoundError('Auction card not found');

    const clues = await auctionRepo.getClues(id);
    const factIds = [...new Set(clues.flatMap((clue) => clue.supported_fact_ids))];
    const facts = await auctionRepo.getFactsByIdsForPlayer(card.player_id, factIds);

    return toCardDetail(card, clues, facts);
  },

  async updateCard(id: string, input: UpdateAuctionCardRequest): Promise<AuctionCardDetail> {
    const existing = await auctionRepo.getCardDetail(id);
    if (!existing) throw new NotFoundError('Auction card not found');

    await validateSupportedFactIds(existing.player_id, input);

    const updated = await auctionRepo.updateCardAndReplaceClues(id, input);
    if (!updated) throw new NotFoundError('Auction card not found');

    return auctionService.getCardById(id);
  },

  async updateStatus(
    id: string,
    input: UpdateAuctionCardStatusRequest,
    userId?: string
  ): Promise<AuctionCardDetail> {
    const existing = await auctionRepo.getCardDetail(id);
    if (!existing) throw new NotFoundError('Auction card not found');

    let publishedBy: string | undefined;
    if (input.status === 'published') {
      publishedBy = requirePublishUserId(userId);
      const clues = await auctionRepo.getClues(id);
      const errors: string[] = validatePublishClues(clues);

      if ((toNumber(existing.true_value_eur) ?? 0) <= 0) errors.push('true_value_eur must be greater than 0');
      if ((toNumber(existing.starting_price_eur) ?? 0) < AUCTION_MIN_STARTING_PRICE_EUR) {
        errors.push('starting_price_eur must be at least 20000000');
      }
      if (!input.force && existing.verification_status !== 'passed') {
        errors.push('verification_status must be passed to publish');
      }

      if (errors.length > 0) {
        throw new BadRequestError('Auction card is not publishable', { errors });
      }

      if (input.force) {
        logger.warn(
          {
            auctionCardId: id,
            userId: publishedBy,
            verificationStatus: existing.verification_status,
          },
          'Auction card force-published by admin'
        );
      }
    }

    const updated = await auctionRepo.updateStatus(
      id,
      input.status,
      publishedBy,
      { force: input.force }
    );
    if (!updated) throw new NotFoundError('Auction card not found');

    return auctionService.getCardById(id);
  },
};
