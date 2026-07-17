import '../../http/openapi/zod-init.js';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorResponseSchema, i18nFieldSchema } from '../../http/openapi/common-schemas.js';
import { registerEndpoint } from '../../http/openapi/register-endpoint.js';
import { deleteQuestionResultSchema, questionTypeEnum } from './questions.schemas.js';

const mcqOptionOpenApiSchema = z.object({
  id: z.string().min(1),
  text: i18nFieldSchema,
  is_correct: z.boolean(),
});

const mcqPayloadOpenApiSchema = z.object({
  type: z.literal('mcq_single'),
  options: z.array(mcqOptionOpenApiSchema).length(4),
});

const trueFalsePayloadOpenApiSchema = z.object({
  type: z.literal('true_false'),
  options: z.tuple([
    mcqOptionOpenApiSchema.extend({ id: z.literal('true') }),
    mcqOptionOpenApiSchema.extend({ id: z.literal('false') }),
  ]),
});

const imposterMultiSelectPayloadOpenApiSchema = z.object({
  type: z.literal('imposter_multi_select'),
  options: z.array(mcqOptionOpenApiSchema).min(4).max(12),
});

const textInputPayloadOpenApiSchema = z.object({
  type: z.literal('input_text'),
  accepted_answers: z.array(i18nFieldSchema).min(1),
  case_sensitive: z.boolean(),
});

const countdownPayloadOpenApiSchema = z.object({
  type: z.literal('countdown_list'),
  prompt: i18nFieldSchema,
  answer_groups: z.array(
    z.object({
      id: z.string().min(1),
      display: i18nFieldSchema,
      accepted_answers: z.array(z.string().min(1)).min(1),
    })
  ).min(1),
});

const clueChainPayloadOpenApiSchema = z.object({
  type: z.literal('clue_chain'),
  display_answer: i18nFieldSchema,
  accepted_answers: z.array(z.string().min(1)).min(1),
  clues: z.array(
    z.object({
      type: z.enum(['text', 'emoji']),
      content: i18nFieldSchema,
    })
  ).min(1),
});

const putInOrderPayloadOpenApiSchema = z.object({
  type: z.literal('put_in_order'),
  prompt: i18nFieldSchema,
  direction: z.enum(['asc', 'desc']),
  items: z.array(
    z.object({
      id: z.string().min(1),
      label: i18nFieldSchema,
      details: i18nFieldSchema.nullable().optional(),
      emoji: z.string().nullable().optional(),
      sort_value: z.number(),
    })
  ).min(3),
});

const careerPathPayloadOpenApiSchema = z.object({
  type: z.literal('career_path'),
  clubs: z.array(i18nFieldSchema).min(2),
  display_answer: i18nFieldSchema,
  accepted_answers: z.array(z.string().min(1)).min(1),
});

const highLowPayloadOpenApiSchema = z.object({
  type: z.literal('high_low'),
  stat_label: i18nFieldSchema,
  matchups: z.array(
    z.object({
      id: z.string().min(1),
      left_name: i18nFieldSchema,
      left_value: z.number(),
      right_name: i18nFieldSchema,
      right_value: z.number(),
    })
  ).min(1),
});

const footballLogicPayloadOpenApiSchema = z.object({
  type: z.literal('football_logic'),
  image_a_url: z.string().url(),
  image_b_url: z.string().url(),
  display_answer: i18nFieldSchema,
  accepted_answers: z.array(z.string().min(1)).min(1),
  prompt: i18nFieldSchema.optional(),
  explanation: i18nFieldSchema.nullable().optional(),
});

const questionPayloadOpenApiSchema = z.discriminatedUnion('type', [
  mcqPayloadOpenApiSchema,
  trueFalsePayloadOpenApiSchema,
  imposterMultiSelectPayloadOpenApiSchema,
  textInputPayloadOpenApiSchema,
  countdownPayloadOpenApiSchema,
  clueChainPayloadOpenApiSchema,
  putInOrderPayloadOpenApiSchema,
  careerPathPayloadOpenApiSchema,
  highLowPayloadOpenApiSchema,
  footballLogicPayloadOpenApiSchema,
]).openapi('QuestionPayload');

const questionResponseSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    type: questionTypeEnum,
    difficulty: z.enum(['easy', 'medium', 'hard']),
    status: z.enum(['draft', 'published', 'archived']),
    prompt: i18nFieldSchema,
    explanation: i18nFieldSchema.nullable(),
    payload: z.union([questionPayloadOpenApiSchema, z.null()]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('QuestionResponse');

const paginatedQuestionsResponseSchema = z
  .object({
    data: z.array(questionResponseSchema),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    total_pages: z.number().int().nonnegative(),
  })
  .openapi('PaginatedQuestionsResponse');

const bulkCreateResponseSchema = z
  .object({
    total: z.number().int(),
    successful: z.number().int(),
    failed: z.number().int(),
    created: z.array(questionResponseSchema),
    errors: z.array(
      z.object({
        index: z.number().int(),
        question: z.unknown(),
        error: z.string(),
      })
    ),
  })
  .openapi('BulkCreateResponse');

// Duplicate Detection schemas
const categorySummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
  })
  .openapi('CategorySummary');

const duplicateGroupSchema = z
  .object({
    id: z.string(),
    type: z.enum(['cross_category', 'same_category']),
    prompt: z.string(),
    count: z.number().int(),
    questions: z.array(questionResponseSchema),
    categories: z.array(categorySummarySchema),
  })
  .openapi('DuplicateGroup');

const duplicatesResponseSchema = z
  .object({
    total_groups: z.number().int(),
    groups: z.array(duplicateGroupSchema),
  })
  .openapi('DuplicatesResponse');

const duplicateQuestionInfoSchema = z
  .object({
    id: z.string().uuid(),
    category_id: z.string().uuid(),
    category_name: i18nFieldSchema,
    created_at: z.string().datetime(),
  })
  .openapi('DuplicateQuestionInfo');

const checkDuplicatesResponseSchema = z
  .object({
    duplicates: z.array(
      z.object({
        index: z.number().int(),
        prompt: i18nFieldSchema,
        existingQuestions: z.array(duplicateQuestionInfoSchema),
      })
    ),
  })
  .openapi('CheckDuplicatesResponse');

const questionIdParamSchema = z.object({ id: z.string().uuid() });

export function registerQuestionsOpenApi(registry: OpenAPIRegistry): void {
  registry.register('QuestionPayload', questionPayloadOpenApiSchema);
  registry.register('QuestionResponse', questionResponseSchema);
  registry.register('DeleteQuestionResult', deleteQuestionResultSchema);
  registry.register('PaginatedQuestionsResponse', paginatedQuestionsResponseSchema);
  registry.register('BulkCreateResponse', bulkCreateResponseSchema);
  registry.register('CategorySummary', categorySummarySchema);
  registry.register('DuplicateGroup', duplicateGroupSchema);
  registry.register('DuplicatesResponse', duplicatesResponseSchema);
  registry.register('DuplicateQuestionInfo', duplicateQuestionInfoSchema);
  registry.register('CheckDuplicatesResponse', checkDuplicatesResponseSchema);

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/questions',
    summary: 'List questions with pagination and filters',
    description: 'Requires authentication. Players are restricted to published questions; full filters and search require admin role. Search terms shorter than 3 characters are ignored.',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    query: z.object({
      category_id: z.string().uuid().optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      type: questionTypeEnum.optional(),
      search: z.string().min(3).max(200).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    responses: {
      200: { description: 'Paginated list of questions', schema: paginatedQuestionsResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/questions/{id}',
    summary: 'Get question by ID with payload',
    description: 'Requires authentication. Players can retrieve published questions only; admins can retrieve any status.',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    pathParams: questionIdParamSchema,
    responses: {
      200: { description: 'Question found', schema: questionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      404: { description: 'Question not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/questions',
    summary: 'Create a new question with payload',
    description: 'Requires admin role',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      category_id: z.string().uuid(),
      type: questionTypeEnum,
      difficulty: z.enum(['easy', 'medium', 'hard']),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      prompt: i18nFieldSchema,
      explanation: i18nFieldSchema.nullable().optional(),
      payload: questionPayloadOpenApiSchema,
    }),
    responses: {
      201: { description: 'Question created', schema: questionResponseSchema },
      400: { description: 'Invalid category', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/questions/bulk',
    summary: 'Bulk create questions',
    description: 'Create multiple questions in a single request. Maximum 100 questions per upload. Requires admin role.',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      category_id: z.string().uuid(),
      questions: z
        .array(
          z.object({
            type: questionTypeEnum,
            difficulty: z.enum(['easy', 'medium', 'hard']),
            status: z.enum(['draft', 'published', 'archived']).optional(),
            prompt: i18nFieldSchema,
            explanation: i18nFieldSchema.nullable().optional(),
            payload: questionPayloadOpenApiSchema,
          })
        )
        .min(1)
        .max(100),
    }),
    responses: {
      207: { description: 'Questions created (may include partial failures)', schema: bulkCreateResponseSchema },
      400: { description: 'Invalid request or category not found', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'put',
    path: '/api/v1/questions/{id}',
    summary: 'Update a question with payload',
    description: 'Requires admin role',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    pathParams: questionIdParamSchema,
    body: z.object({
      category_id: z.string().uuid().optional(),
      type: questionTypeEnum.optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      status: z.enum(['draft', 'published', 'archived']).optional(),
      prompt: i18nFieldSchema.optional(),
      explanation: i18nFieldSchema.nullable().optional(),
      payload: questionPayloadOpenApiSchema.optional(),
    }),
    responses: {
      200: { description: 'Question updated', schema: questionResponseSchema },
      400: { description: 'Invalid category', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Question not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'delete',
    path: '/api/v1/questions/{id}',
    summary: 'Delete a question',
    description: 'Requires admin role',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    pathParams: questionIdParamSchema,
    responses: {
      200: { description: 'Question deleted or archived', schema: deleteQuestionResultSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Question not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'patch',
    path: '/api/v1/questions/{id}/status',
    summary: 'Update question status',
    description: 'Requires admin role',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    pathParams: questionIdParamSchema,
    body: z.object({
      status: z.enum(['draft', 'published', 'archived']),
    }),
    responses: {
      200: { description: 'Status updated', schema: questionResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
      404: { description: 'Question not found', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'get',
    path: '/api/v1/questions/duplicates',
    summary: 'Find duplicate questions',
    description: 'Detect questions with identical prompt text. Returns groups of questions with the same prompt, either within the same category or across different categories. Requires admin role.',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    query: z.object({
      type: z.enum(['cross_category', 'same_category', 'all']).optional().openapi({
        description: 'Filter by duplicate type',
        example: 'all',
      }),
      category_id: z.string().uuid().optional().openapi({
        description: 'Limit search to specific category',
      }),
      include_drafts: z.string().optional().openapi({
        description: 'Include draft questions in search (default: true)',
        example: 'true',
      }),
    }),
    responses: {
      200: { description: 'Duplicate groups found successfully', schema: duplicatesResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
    },
  });

  registerEndpoint(registry, {
    method: 'post',
    path: '/api/v1/questions/check-duplicates',
    summary: 'Check for duplicate prompts before bulk upload',
    description: 'Check if question prompts already exist in the database. Used during bulk upload preview to show users which questions are duplicates. Requires admin role.',
    tags: ['Questions'],
    security: [{ bearerAuth: [] }],
    body: z.object({
      prompts: z.array(i18nFieldSchema).min(1).max(100).openapi({
        description: 'Array of question prompts to check',
        example: [
          { en: 'What is the capital of France?' },
          { en: 'What is 2+2?' },
        ],
      }),
    }),
    responses: {
      200: { description: 'Duplicate check completed successfully', schema: checkDuplicatesResponseSchema },
      400: { description: 'Invalid request (e.g., too many prompts)', schema: errorResponseSchema },
      401: { description: 'Not authenticated', schema: errorResponseSchema },
      403: { description: 'Insufficient permissions (admin role required)', schema: errorResponseSchema },
    },
  });
}
