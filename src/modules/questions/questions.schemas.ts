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

// =============================================================================
// Payload Schemas
// =============================================================================

/**
 * MCQ Option schema - single answer option with i18n text
 */
export const mcqOptionSchema = z.object({
  id: z.string().uuid(),
  text: i18nFieldSchema,
  is_correct: z.boolean(),
});

export type McqOption = z.infer<typeof mcqOptionSchema>;

/**
 * MCQ Payload base schema - multiple choice with single correct answer
 */
const mcqPayloadBaseSchema = z.object({
  type: z.literal('mcq_single'),
  options: z.array(mcqOptionSchema).length(4),
});

/**
 * Text Input Payload schema - user types answer
 */
const textInputPayloadBaseSchema = z.object({
  type: z.literal('input_text'),
  accepted_answers: z.array(i18nFieldSchema).min(1),
  case_sensitive: z.boolean(),
});

/**
 * Union of all payload types - discriminated by 'type' field
 * Additional validation (unique IDs, exactly 1 correct) applied via superRefine
 */
export const questionPayloadSchema = z
  .discriminatedUnion('type', [mcqPayloadBaseSchema, textInputPayloadBaseSchema])
  .superRefine((data, ctx) => {
    if (data.type === 'mcq_single') {
      // Check exactly one correct answer
      const correctCount = data.options.filter((o) => o.is_correct).length;
      if (correctCount !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Exactly one option must be marked as correct',
          path: ['options'],
        });
      }

      // Check unique IDs
      const ids = data.options.map((o) => o.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Option IDs must be unique',
          path: ['options'],
        });
      }
    }
  });

export type McqPayload = z.infer<typeof mcqPayloadBaseSchema>;
export type TextInputPayload = z.infer<typeof textInputPayloadBaseSchema>;
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

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
 * Base create question schema (before payload type validation)
 */
const createQuestionBaseSchema = z.object({
  category_id: z.string().uuid(),
  type: questionTypeEnum,
  difficulty: difficultyEnum,
  status: statusEnum.optional().default('draft'),
  prompt: i18nFieldSchema,
  explanation: i18nFieldSchema.nullable().optional(),
  payload: questionPayloadSchema,
});

/**
 * Create question request schema.
 * - Payload is required
 * - Payload type must match question type
 */
export const createQuestionSchema = createQuestionBaseSchema.refine(
  (data) => data.payload.type === data.type,
  { message: 'Payload type must match question type', path: ['payload', 'type'] }
);

export type CreateQuestionRequest = z.infer<typeof createQuestionSchema>;

/**
 * Update question request schema.
 * - All fields optional
 * - If both type and payload provided, they must match
 */
export const updateQuestionSchema = z
  .object({
    category_id: z.string().uuid().optional(),
    type: questionTypeEnum.optional(),
    difficulty: difficultyEnum.optional(),
    status: statusEnum.optional(),
    prompt: i18nFieldSchema.optional(),
    explanation: i18nFieldSchema.nullable().optional(),
    payload: questionPayloadSchema.optional(),
  })
  .refine(
    (data) => {
      // If both type and payload are provided, they must match
      if (data.type && data.payload) {
        return data.payload.type === data.type;
      }
      return true;
    },
    { message: 'Payload type must match question type', path: ['payload', 'type'] }
  );

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
