import { z } from 'zod';
import { paginatedResponseSchema, paginationQuerySchema } from '../../http/schemas/shared.js';

export const auctionPositionGroupEnum = z.enum(['GK', 'DEF', 'MID', 'FWD']);
export type AuctionPositionGroup = z.infer<typeof auctionPositionGroupEnum>;

export const auctionFameBucketEnum = z.enum(['superstar', 'known', 'niche', 'obscure', 'legend']);
export type AuctionFameBucket = z.infer<typeof auctionFameBucketEnum>;

export const auctionValueTypeEnum = z.enum(['current', 'peak', 'synthetic']);
export type AuctionValueType = z.infer<typeof auctionValueTypeEnum>;

export const auctionCardTypeEnum = z.enum([
  'normal',
  'safe_star',
  'bargain',
  'trap',
  'obscure_gem',
  'lookalike_story',
  'legend',
]);
export type AuctionCardType = z.infer<typeof auctionCardTypeEnum>;

export const auctionDifficultyEnum = z.enum(['easy', 'medium', 'hard', 'expert']);
export type AuctionDifficulty = z.infer<typeof auctionDifficultyEnum>;

export const auctionCardStatusEnum = z.enum(['draft', 'needs_review', 'approved', 'published', 'rejected']);
export type AuctionCardStatus = z.infer<typeof auctionCardStatusEnum>;

export const auctionVerificationStatusEnum = z.enum(['passed', 'failed', 'needs_review']);
export type AuctionVerificationStatus = z.infer<typeof auctionVerificationStatusEnum>;

export const auctionPlayerActiveStatusEnum = z.enum(['active', 'retired', 'legend', 'unknown']);
export const auctionPlayerDataQualityStatusEnum = z.enum(['pending', 'usable', 'needs_review', 'rejected']);
export const playerFactStatusEnum = z.enum(['candidate', 'verified', 'rejected', 'needs_review']);
export const playerFactDiscoveredByEnum = z.enum([
  'transfermarkt_dataset',
  'wikidata',
  'wikipedia',
  'llm_research',
  'manual',
  'derived',
]);
export const llmGenerationStatusEnum = z.enum(['success', 'failed', 'invalid_json', 'rejected']);
export const llmModelRoleEnum = z.enum(['researcher', 'generator', 'verifier', 'translator']);

export const auctionCardIdParamSchema = z.object({
  id: z.string().uuid(),
});
export type AuctionCardIdParam = z.infer<typeof auctionCardIdParamSchema>;

export const listAuctionCardsQuerySchema = paginationQuerySchema.extend({
  status: auctionCardStatusEnum.optional(),
  position_group: auctionPositionGroupEnum.optional(),
  card_type: auctionCardTypeEnum.optional(),
  difficulty: auctionDifficultyEnum.optional(),
  fame_bucket: auctionFameBucketEnum.optional(),
  verification_status: auctionVerificationStatusEnum.optional(),
  search: z.string().trim().min(1).optional(),
});
export type ListAuctionCardsQuery = z.infer<typeof listAuctionCardsQuerySchema>;

export const auctionClueInputSchema = z.object({
  clue_order: z.number().int().min(1).max(3),
  clue_en: z.string().trim().min(1),
  clue_ka: z.string().trim().min(1),
  clue_kind: z.string().trim().min(1),
  supported_fact_ids: z.array(z.string().uuid()).optional().default([]),
});
export type AuctionClueInput = z.infer<typeof auctionClueInputSchema>;

export const auctionCluesUpdateSchema = z
  .array(auctionClueInputSchema)
  .length(3)
  .superRefine((clues, ctx) => {
    const orders = clues.map((clue) => clue.clue_order).sort((a, b) => a - b);
    const valid = orders[0] === 1 && orders[1] === 2 && orders[2] === 3;
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clue_order values must be exactly 1, 2, and 3',
      });
    }
  });

export const updateAuctionCardSchema = z
  .object({
    true_value_eur: z.number().int().positive().optional(),
    starting_price_eur: z.number().int().min(20_000_000).optional(),
    value_type: auctionValueTypeEnum.optional(),
    card_type: auctionCardTypeEnum.optional(),
    difficulty: auctionDifficultyEnum.optional(),
    verification_status: auctionVerificationStatusEnum.optional(),
    verification_notes: z.string().nullable().optional(),
    editor_notes: z.string().nullable().optional(),
    clues: auctionCluesUpdateSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  });
export type UpdateAuctionCardRequest = z.infer<typeof updateAuctionCardSchema>;

export const updateAuctionCardStatusSchema = z.object({
  status: auctionCardStatusEnum,
  force: z.boolean().optional().default(false),
});
export type UpdateAuctionCardStatusRequest = z.infer<typeof updateAuctionCardStatusSchema>;

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const auctionPlayerSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  display_name: jsonRecordSchema,
  nationality: z.string().nullable(),
  nationality_code: z.string().nullable(),
  position_group: auctionPositionGroupEnum.nullable(),
  current_club: z.string().nullable(),
  active_status: auctionPlayerActiveStatusEnum,
  image_url: z.string().nullable(),
  fame_score: z.number().nullable(),
  fame_bucket: auctionFameBucketEnum.nullable(),
  data_quality_status: auctionPlayerDataQualityStatusEnum,
});
export type AuctionPlayerSummary = z.infer<typeof auctionPlayerSummarySchema>;

export const auctionPlayerDetailSchema = auctionPlayerSummarySchema.extend({
  transfermarkt_id: z.string().nullable(),
  wikidata_id: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  current_value_eur: z.number().nullable(),
  peak_value_eur: z.number().nullable(),
  source_payload: jsonRecordSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type AuctionPlayerDetail = z.infer<typeof auctionPlayerDetailSchema>;

export const auctionCardSummarySchema = z.object({
  id: z.string().uuid(),
  player_id: z.string().uuid(),
  position_group: auctionPositionGroupEnum,
  true_value_eur: z.number(),
  starting_price_eur: z.number(),
  value_type: auctionValueTypeEnum,
  card_type: auctionCardTypeEnum,
  difficulty: auctionDifficultyEnum,
  status: auctionCardStatusEnum,
  generator_model: z.string().nullable(),
  verifier_model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  verification_status: auctionVerificationStatusEnum,
  published_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  player: auctionPlayerSummarySchema,
  clue_count: z.number().int().nonnegative(),
});
export type AuctionCardSummary = z.infer<typeof auctionCardSummarySchema>;

export const paginatedAuctionCardsResponseSchema = paginatedResponseSchema(auctionCardSummarySchema);
export type PaginatedAuctionCardsResponse = z.infer<typeof paginatedAuctionCardsResponseSchema>;

export const auctionCardClueSchema = z.object({
  id: z.string().uuid(),
  auction_card_id: z.string().uuid(),
  clue_order: z.number().int().min(1).max(3),
  clue_en: z.string(),
  clue_ka: z.string(),
  clue_kind: z.string(),
  supported_fact_ids: z.array(z.string().uuid()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type AuctionCardClue = z.infer<typeof auctionCardClueSchema>;

export const playerFactSchema = z.object({
  id: z.string().uuid(),
  player_id: z.string().uuid(),
  fact_type: z.string(),
  fact_text_en: z.string(),
  fact_text_ka: z.string().nullable(),
  source_name: z.string().nullable(),
  source_url: z.string().nullable(),
  evidence_quote: z.string().nullable(),
  confidence: z.number().nullable(),
  status: playerFactStatusEnum,
  discovered_by: playerFactDiscoveredByEnum,
  verified_by_model: z.string().nullable(),
  verifier_notes: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type PlayerFact = z.infer<typeof playerFactSchema>;

export const llmGenerationRunSummarySchema = z.object({
  id: z.string().uuid(),
  job_name: z.string(),
  model_name: z.string(),
  model_role: llmModelRoleEnum,
  prompt_version: z.string(),
  status: llmGenerationStatusEnum,
  error_message: z.string().nullable(),
  latency_ms: z.number().int().nullable(),
  token_usage: jsonRecordSchema,
  cost_estimate: z.number().nullable(),
  editor_rating: z.number().int().nullable(),
  editor_selected: z.boolean(),
  created_at: z.string().datetime(),
});
export type LlmGenerationRunSummary = z.infer<typeof llmGenerationRunSummarySchema>;

export const auctionCardDetailSchema = z.object({
  id: z.string().uuid(),
  player_id: z.string().uuid(),
  position_group: auctionPositionGroupEnum,
  true_value_eur: z.number(),
  starting_price_eur: z.number(),
  value_type: auctionValueTypeEnum,
  card_type: auctionCardTypeEnum,
  difficulty: auctionDifficultyEnum,
  status: auctionCardStatusEnum,
  generator_model: z.string().nullable(),
  verifier_model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  generation_run_id: z.string().uuid().nullable(),
  verification_status: auctionVerificationStatusEnum,
  verification_notes: z.string().nullable(),
  editor_notes: z.string().nullable(),
  published_at: z.string().datetime().nullable(),
  published_by: z.string().uuid().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  player: auctionPlayerDetailSchema,
  clues: z.array(auctionCardClueSchema),
  supported_facts: z.array(playerFactSchema),
  generation_run: llmGenerationRunSummarySchema.nullable(),
});
export type AuctionCardDetail = z.infer<typeof auctionCardDetailSchema>;
