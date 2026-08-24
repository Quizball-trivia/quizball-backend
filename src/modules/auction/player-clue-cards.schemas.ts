import { z } from 'zod';

export const clueCardLocaleEnum = z.enum(['en', 'ka']);
export type ClueCardLocale = z.infer<typeof clueCardLocaleEnum>;

export const clueCardDifficultyEnum = z.enum(['easy', 'medium', 'hard']);
export type ClueCardDifficulty = z.infer<typeof clueCardDifficultyEnum>;

export const clueCardImportStatusEnum = z.enum(['needs_review', 'approved']);
export type ClueCardImportStatus = z.infer<typeof clueCardImportStatusEnum>;

export const clueCardStatusTransitionEnum = z.enum(['needs_review', 'approved', 'published', 'rejected']);
export type ClueCardStatusTransition = z.infer<typeof clueCardStatusTransitionEnum>;

export const clueCardBulkStatusEnum = z.enum(['approved', 'published', 'rejected']);

export const clueCardIdParamSchema = z.object({
  id: z.string().uuid(),
});
export type ClueCardIdParam = z.infer<typeof clueCardIdParamSchema>;

export const importPreviewRequestSchema = z.object({
  text: z.string().min(1, 'Text is required'),
  locale: clueCardLocaleEnum,
  promptVersion: z.string().trim().min(1).optional().default('cms-import'),
  defaultDifficulty: clueCardDifficultyEnum.optional().default('medium'),
  style: z.string().trim().min(1).optional().default('editor_first_person'),
});
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

const playerCandidateSchema = z.object({
  footballPlayerId: z.string().uuid(),
  transfermarktId: z.number().int().nullable().optional(),
  name: z.string(),
  currentClub: z.string().nullable().optional(),
  nationality: z.string().nullable().optional(),
  positionGroup: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  currentValueEur: z.number().nullable().optional(),
});

export const previewRowSchema = z.object({
  rowIndex: z.number().int(),
  sourcePlayerNumber: z.number().int().nullable(),
  answerName: z.string(),
  difficulty: clueCardDifficultyEnum,
  clue1: z.string(),
  clue2: z.string(),
  clue3: z.string(),
  warnings: z.array(z.string()),
  validationErrors: z.array(z.string()),
  factRiskFlags: z.array(z.string()),
  originalText: z.string(),
  matchStatus: z.enum(['matched', 'ambiguous', 'unmatched']),
  matchedPlayer: playerCandidateSchema.nullable(),
  candidates: z.array(playerCandidateSchema),
  matchMethod: z.string().nullable().optional(),
  matchConfidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
});

export const importPreviewResponseSchema = z.object({
  rowsParsed: z.number().int(),
  matchedCount: z.number().int(),
  ambiguousCount: z.number().int(),
  unmatchedCount: z.number().int(),
  warningCount: z.number().int(),
  rows: z.array(previewRowSchema),
});

export const commitRowSchema = z.object({
  rowIndex: z.number().int(),
  answerName: z.string().min(1),
  difficulty: clueCardDifficultyEnum.nullable().optional(),
  clue1: z.string().min(1),
  clue2: z.string().min(1),
  clue3: z.string().min(1),
  footballPlayerId: z.string().uuid('A resolved footballPlayerId is required for commit'),
  originalText: z.string().optional().default(''),
  sourcePlayerNumber: z.number().int().nullable().optional(),
  manualMapping: z.boolean().optional().default(false),
  matchMethod: z.string().nullable().optional(),
  matchConfidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  factRiskFlags: z.array(z.string()).optional().default([]),
});

export const importCommitRequestSchema = z.object({
  locale: clueCardLocaleEnum,
  promptVersion: z.string().trim().min(1).optional().default('cms-import'),
  defaultDifficulty: clueCardDifficultyEnum.optional().default('medium'),
  status: clueCardImportStatusEnum.optional().default('needs_review'),
  force: z.boolean().optional().default(false),
  rows: z.array(commitRowSchema).min(1, 'At least one row is required'),
});
export type ImportCommitRequest = z.infer<typeof importCommitRequestSchema>;

export const commitResultRowSchema = z.object({
  rowIndex: z.number().int(),
  status: z.enum(['inserted', 'updated', 'skipped_existing', 'failed']),
  clueCardId: z.string().uuid().nullable(),
  error: z.string().nullable(),
});

export const importCommitResponseSchema = z.object({
  total: z.number().int(),
  inserted: z.number().int(),
  updated: z.number().int(),
  skippedExisting: z.number().int(),
  failed: z.number().int(),
  rows: z.array(commitResultRowSchema),
});

export const updateStatusRequestSchema = z.object({
  status: clueCardStatusTransitionEnum,
  reviewNotes: z.string().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
});
export type UpdateStatusRequest = z.infer<typeof updateStatusRequestSchema>;

export const bulkUpdateStatusRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  status: clueCardBulkStatusEnum,
  reviewNotes: z.string().nullable().optional(),
});
export type BulkUpdateStatusRequest = z.infer<typeof bulkUpdateStatusRequestSchema>;

export const playerClueCardDetailSchema = z.object({
  id: z.string().uuid(),
  football_player_id: z.string().uuid(),
  transfermarkt_id: z.number().int().nullable(),
  locale: z.string(),
  clue_1: z.string(),
  clue_2: z.string(),
  clue_3: z.string(),
  difficulty: z.string(),
  status: z.string(),
  source: z.string(),
  generation_provider: z.string().nullable(),
  generation_model: z.string().nullable(),
  prompt_version: z.string(),
  evidence: z.record(z.unknown()),
  source_payload: z.record(z.unknown()),
  review_notes: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  playerName: z.string(),
  playerImageUrl: z.string().nullable(),
  playerPositionGroup: z.string().nullable(),
  playerNationality: z.string().nullable(),
  playerCurrentClub: z.string().nullable(),
});
