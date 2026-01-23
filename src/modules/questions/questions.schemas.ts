import { z } from 'zod';
import type { QuestionWithPayload, I18nField } from '../../db/types.js';

/**
 * i18n field schema - object with language codes as keys
 */
export const i18nFieldSchema = z.record(z.string(), z.string());

/**
 * Question type enum
 */
export const questionTypeEnum = z.enum(['mcq_single', 'input_text']);
export type QuestionType = z.infer<typeof questionTypeEnum>;

/**
 * Question difficulty enum
 */
export const difficultyEnum = z.enum(['easy', 'medium', 'hard']);
export type Difficulty = z.infer<typeof difficultyEnum>;

/**
 * Question status enum
 */
export const statusEnum = z.enum(['draft', 'published', 'archived']);
export type Status = z.infer<typeof statusEnum>;

/**
 * Question response schema.
 */
export const questionResponseSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid(),
  type: questionTypeEnum,
  difficulty: difficultyEnum,
  status: statusEnum,
  prompt: i18nFieldSchema,
  explanation: i18nFieldSchema.nullable(),
  payload: z.unknown().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type QuestionResponse = z.infer<typeof questionResponseSchema>;

/**
 * Paginated response schema.
 */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  });

export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

/**
 * List questions query params schema.
 */
export const listQuestionsQuerySchema = z.object({
  category_id: z.string().uuid().optional(),
  status: statusEnum.optional(),
  difficulty: difficultyEnum.optional(),
  type: questionTypeEnum.optional(),
  search: z.string().optional(),
  page: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default('1'),
  limit: z
    .string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .default('20'),
});

export type ListQuestionsQuery = z.infer<typeof listQuestionsQuerySchema>;

/**
 * Create question request schema.
 */
export const createQuestionSchema = z.object({
  category_id: z.string().uuid(),
  type: questionTypeEnum,
  difficulty: difficultyEnum,
  status: statusEnum.optional().default('draft'),
  prompt: i18nFieldSchema,
  explanation: i18nFieldSchema.nullable().optional(),
  payload: z.unknown().optional(),
});

export type CreateQuestionRequest = z.infer<typeof createQuestionSchema>;

/**
 * Update question request schema.
 */
export const updateQuestionSchema = z.object({
  category_id: z.string().uuid().optional(),
  type: questionTypeEnum.optional(),
  difficulty: difficultyEnum.optional(),
  status: statusEnum.optional(),
  prompt: i18nFieldSchema.optional(),
  explanation: i18nFieldSchema.nullable().optional(),
  payload: z.unknown().optional(),
});

export type UpdateQuestionRequest = z.infer<typeof updateQuestionSchema>;

/**
 * Update status request schema.
 */
export const updateStatusSchema = z.object({
  status: statusEnum,
});

export type UpdateStatusRequest = z.infer<typeof updateStatusSchema>;

/**
 * UUID param schema.
 */
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

export type UuidParam = z.infer<typeof uuidParamSchema>;

/**
 * Convert database Question with payload to API response format.
 */
export function toQuestionResponse(question: QuestionWithPayload): QuestionResponse {
  return {
    id: question.id,
    category_id: question.category_id,
    type: question.type as QuestionType,
    difficulty: question.difficulty as Difficulty,
    status: question.status as Status,
    prompt: (question.prompt as I18nField) ?? {},
    explanation: (question.explanation as I18nField | null) ?? null,
    payload: question.payload,
    created_at: question.created_at,
    updated_at: question.updated_at,
  };
}

/**
 * Convert to paginated response format.
 */
export function toPaginatedResponse<T>(
  data: T[],
  page: number,
  limit: number,
  total: number
): PaginatedResponse<T> {
  return {
    data,
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}
