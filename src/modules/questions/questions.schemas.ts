import { z } from 'zod';
import type { QuestionWithPayload } from '../../db/types.js';
import {
  i18nFieldSchema,
  paginatedResponseSchema,
  type PaginatedResponse,
} from '../../http/schemas/shared.js';
import { logger } from '../../core/logger.js';
import { InternalError } from '../../core/errors.js';
import { createHash } from 'crypto';

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
  id: z.string().min(1),
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

function parseNestedJsonString(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 2; i += 1) {
    if (typeof current !== 'string') break;
    const trimmed = current.trim();
    if (trimmed.length === 0) break;
    try {
      current = JSON.parse(trimmed);
    } catch {
      break;
    }
  }
  return current;
}

function toI18nField(value: unknown): Record<string, string> | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return { en: text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([locale, text]) => typeof locale === 'string' && typeof text === 'string' && text.trim().length > 0)
    .map(([locale, text]) => [locale, (text as string).trim()] as const);

  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

function normalizeMcqOptions(payload: Record<string, unknown>): Record<string, unknown> {
  const rawOptions = Array.isArray(payload.options)
    ? payload.options
    : Array.isArray(payload.choices)
      ? payload.choices
      : Array.isArray(payload.answers)
        ? payload.answers
        : Array.isArray(payload.answer_options)
          ? payload.answer_options
          : null;

  if (!rawOptions) return payload;

  const normalized = rawOptions
    .map((option, index) => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const candidate = option as Record<string, unknown>;

      const rawId = candidate.id ?? candidate.option_id ?? String(index + 1);
      if (typeof rawId !== 'string' || rawId.trim().length === 0) return null;

      const text = toI18nField(candidate.text ?? candidate.label ?? candidate.answer ?? candidate.value);
      if (!text) return null;

      const isCorrect = toBoolean(candidate.is_correct ?? candidate.isCorrect ?? candidate.correct);
      if (isCorrect === null) return null;

      return {
        id: rawId.trim(),
        text,
        is_correct: isCorrect,
      };
    })
    .filter((option): option is { id: string; text: Record<string, string>; is_correct: boolean } => option !== null);

  if (normalized.length !== rawOptions.length) return payload;

  return {
    ...payload,
    options: normalized,
  };
}

export function normalizeQuestionPayloadCandidate(payload: unknown): unknown {
  const parsed = parseNestedJsonString(payload);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;

  const candidate = parsed as Record<string, unknown>;
  if (candidate.type === 'mcq_single') {
    return normalizeMcqOptions(candidate);
  }

  return candidate;
}

/**
 * Union of all payload types - discriminated by 'type' field
 * Additional validation (unique IDs, exactly 1 correct) applied via superRefine
 */
export const questionPayloadSchema = z
  .preprocess(normalizeQuestionPayloadCandidate, z.discriminatedUnion('type', [mcqPayloadBaseSchema, textInputPayloadBaseSchema]))
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

// Re-export shared pagination types for module consumers
export { paginatedResponseSchema, type PaginatedResponse };

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
export const createQuestionBaseSchema = z.object({
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
  // Parse JSON strings to objects (postgres.js may return JSON as strings)
  const parseJsonField = (field: any, fieldName: string, isRequired: boolean): any => {
    // Only treat null/undefined as null (not empty strings or other falsy values)
    if (field == null) {
      if (isRequired) {
        throw new InternalError(
          `Data integrity error: missing ${fieldName} field for question ${question.id}`
        );
      }
      return null;
    }
    if (typeof field === 'string') {
      try {
        return JSON.parse(field);
      } catch (error) {
        const fieldLength = field.length;
        const fieldPreview = field.replace(/\s+/g, '').slice(0, 3) || null;
        const fieldHash = createHash('sha256').update(field).digest('hex');
        logger.error(
          {
            questionId: question.id,
            fieldName,
            fieldLength,
            fieldPreview,
            fieldHash,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to parse JSON field'
        );

        if (isRequired) {
          // Critical field - data corruption detected
          throw new InternalError(
            `Data integrity error: corrupted ${fieldName} field for question ${question.id}`
          );
        }

        // Optional field - return null to maintain API contract
        return null;
      }
    }
    return field;
  };

  // Validate enum values from database (catch data integrity issues)
  const typeResult = questionTypeEnum.safeParse(question.type);
  const difficultyResult = difficultyEnum.safeParse(question.difficulty);
  const statusResult = statusEnum.safeParse(question.status);

  if (!typeResult.success) {
    logger.error(
      { questionId: question.id, type: question.type, error: typeResult.error },
      'Invalid question type in database'
    );
    throw new InternalError('Data integrity error: invalid question type');
  }

  if (!difficultyResult.success) {
    logger.error(
      { questionId: question.id, difficulty: question.difficulty },
      'Invalid difficulty in database'
    );
    throw new InternalError('Data integrity error: invalid difficulty');
  }

  if (!statusResult.success) {
    logger.error(
      { questionId: question.id, status: question.status },
      'Invalid status in database'
    );
    throw new InternalError('Data integrity error: invalid status');
  }

  const prompt = parseJsonField(question.prompt, 'prompt', true);
  const explanation = parseJsonField(question.explanation, 'explanation', false);
  const payload = parseJsonField(question.payload, 'payload', false);

  if (prompt == null) {
    throw new InternalError(
      `Data integrity error: missing prompt field for question ${question.id}`
    );
  }

  return {
    id: question.id,
    category_id: question.category_id,
    type: typeResult.data,
    difficulty: difficultyResult.data,
    status: statusResult.data,
    prompt,
    explanation,
    payload,
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

// =============================================================================
// Bulk Create Schemas
// =============================================================================

/**
 * Bulk create questions request schema.
 * - category_id: Required, all questions will be assigned to this category
 * - questions: Array of 1-100 questions to create (without category_id)
 */
export const bulkCreateQuestionsSchema = z.object({
  category_id: z.string().uuid(),
  questions: z
    .array(
      createQuestionBaseSchema.omit({ category_id: true }).refine(
        (data) => data.payload.type === data.type,
        { message: 'Payload type must match question type', path: ['payload', 'type'] }
      )
    )
    .min(1, 'At least one question required')
    .max(100, 'Maximum 100 questions per upload'),
});

export type BulkCreateQuestionsRequest = z.infer<typeof bulkCreateQuestionsSchema>;

/**
 * Error detail for a single failed question in bulk upload.
 */
export const bulkCreateErrorSchema = z.object({
  index: z.number(),
  question: z.unknown(),
  error: z.string(),
});

export type BulkCreateError = z.infer<typeof bulkCreateErrorSchema>;

/**
 * Bulk create response schema.
 * - total: Total number of questions attempted
 * - successful: Number of questions created successfully
 * - failed: Number of questions that failed to create
 * - created: Array of successfully created questions
 * - errors: Array of error details for failed questions
 */
export const bulkCreateResponseSchema = z.object({
  total: z.number(),
  successful: z.number(),
  failed: z.number(),
  created: z.array(questionResponseSchema),
  errors: z.array(bulkCreateErrorSchema),
});

export type BulkCreateResponse = z.infer<typeof bulkCreateResponseSchema>;

// =============================================================================
// Duplicate Detection Schemas
// =============================================================================

/**
 * Duplicate type enum - identifies whether duplicates are in same or different categories
 */
export const duplicateTypeEnum = z.enum(['cross_category', 'same_category']);
export type DuplicateType = z.infer<typeof duplicateTypeEnum>;

/**
 * Category summary for duplicate groups
 */
export const categorySummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export type CategorySummary = z.infer<typeof categorySummarySchema>;

/**
 * Duplicate group schema - represents a group of questions with identical prompts
 */
export const duplicateGroupSchema = z.object({
  id: z.string(),
  type: duplicateTypeEnum,
  prompt: z.string(),
  count: z.number(),
  questions: z.array(questionResponseSchema),
  categories: z.array(categorySummarySchema),
});

export type DuplicateGroup = z.infer<typeof duplicateGroupSchema>;

/**
 * Find duplicates query params schema
 */
export const findDuplicatesQuerySchema = z.object({
  type: duplicateTypeEnum.or(z.literal('all')).optional().default('all'),
  category_id: z.string().uuid().optional(),
  include_drafts: z
    .string()
    .transform((val) => val === 'true')
    .pipe(z.boolean())
    .optional()
    .default('true'),
});

export type FindDuplicatesQuery = z.infer<typeof findDuplicatesQuerySchema>;

/**
 * Duplicates response schema
 */
export const duplicatesResponseSchema = z.object({
  total_groups: z.number(),
  groups: z.array(duplicateGroupSchema),
});

export type DuplicatesResponse = z.infer<typeof duplicatesResponseSchema>;

// =============================================================================
// Check Duplicates Schemas (for bulk upload preview)
// =============================================================================

/**
 * Check duplicates request schema - used to check if prompts already exist before upload
 */
export const checkDuplicatesSchema = z.object({
  locale: z
    .string()
    .regex(/^[a-z]{2,5}$/i, 'Locale must be 2-5 letters')
    .default('en'),
  prompts: z.array(i18nFieldSchema).min(1).max(100),
});

export type CheckDuplicatesRequest = z.infer<typeof checkDuplicatesSchema>;

/**
 * Existing question info for duplicate check
 */
export const duplicateQuestionInfoSchema = z.object({
  id: z.string().uuid(),
  category_id: z.string().uuid(),
  category_name: i18nFieldSchema,
  created_at: z.string().datetime(),
});

export type DuplicateQuestionInfo = z.infer<typeof duplicateQuestionInfoSchema>;

/**
 * Check duplicates response schema
 */
export const checkDuplicatesResponseSchema = z.object({
  duplicates: z.array(
    z.object({
      index: z.number(),
      prompt: i18nFieldSchema,
      existingQuestions: z.array(duplicateQuestionInfoSchema),
    })
  ),
});

export type CheckDuplicatesResponse = z.infer<typeof checkDuplicatesResponseSchema>;
