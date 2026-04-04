import type { QuestionWithPayload, Json } from '../../db/types.js';
import {
  questionsRepo,
  type CreateQuestionData,
  type UpdateQuestionData,
  type ListQuestionsFilter,
  type ListQuestionsResult,
} from './questions.repo.js';
import { categoriesRepo } from '../categories/categories.repo.js';
import { NotFoundError, BadRequestError } from '../../core/errors.js';
import { translationService } from './translation.service.js';
import { logger } from '../../core/logger.js';
import { invalidateCategoryCache } from '../lobbies/lobbies.service.js';
import type {
  BulkCreateResponse,
  CreateQuestionRequest,
  DuplicatesResponse,
  DuplicateGroup,
  DuplicateType,
  CategorySummary,
  Status,
  DeleteQuestionResult,
} from './questions.schemas.js';
import { normalizeQuestionPayloadCandidate, toQuestionResponse } from './questions.schemas.js';
import { createHash } from 'crypto';
import { getLocalizedString } from '../../lib/localization.js';
import { logAudit } from '../activity/audit.js';
import postgres from 'postgres';

const normalizePayload = (payload: Json | undefined, context: string): Json | undefined => {
  if (payload == null) return payload;
  const normalized = normalizeQuestionPayloadCandidate(payload);

  if (typeof normalized === 'string') {
    throw new BadRequestError(`Invalid payload JSON in ${context}`);
  }
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new BadRequestError(`Payload must be a JSON object in ${context}`);
  }

  return normalized as Json;
};

/**
 * Questions service.
 * Contains ALL business logic for question operations.
 * NO Express types (req/res). NO direct SQL calls.
 */
export const questionsService = {
  /**
   * List questions with pagination and filters.
   */
  async list(
    filter?: ListQuestionsFilter,
    page = 1,
    limit = 20
  ): Promise<ListQuestionsResult> {
    return questionsRepo.list(filter, page, limit);
  },

  /**
   * Get question by ID with payload.
   * Throws NotFoundError if question doesn't exist.
   */
  async getById(id: string): Promise<QuestionWithPayload> {
    const question = await questionsRepo.getById(id);

    if (!question) {
      throw new NotFoundError('Question not found');
    }

    return question;
  },

  /**
   * Create a new question with optional payload.
   * Uses transaction to ensure atomicity.
   * Validates category existence.
   */
  async create(data: CreateQuestionData & { payload?: Json; createdBy?: string }): Promise<QuestionWithPayload> {
    // Validate category exists
    const category = await categoriesRepo.getById(data.categoryId);
    if (!category) {
      throw new BadRequestError('Category not found');
    }

    const normalizedPayload = normalizePayload(data.payload, 'create');

    // Create question with payload atomically
    const question = await questionsRepo.createWithPayload(data, normalizedPayload);

    invalidateCategoryCache();
    logger.info(
      { questionId: question.id, categoryId: data.categoryId, type: data.type },
      'Created new question'
    );

    if (data.createdBy) {
      logAudit({
        userId: data.createdBy,
        action: 'create',
        entityType: 'question',
        entityId: question.id,
        metadata: {
          category_id: data.categoryId,
          category_name: getLocalizedString(category.name),
          type: data.type,
          difficulty: data.difficulty,
          status: data.status ?? 'draft',
          title: getLocalizedString(question.prompt),
        },
      });
    }

    return question;
  },

  /**
   * Update a question with optional payload update.
   * Validates category existence if category_id is being changed.
   */
  async update(
    id: string,
    data: UpdateQuestionData & { payload?: Json },
    userId?: string
  ): Promise<QuestionWithPayload> {
    // Check question exists
    const existing = await questionsRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }

    // Validate category if being changed
    if (data.categoryId && data.categoryId !== existing.category_id) {
      const categoryExists = await categoriesRepo.exists(data.categoryId);
      if (!categoryExists) {
        throw new BadRequestError('Category not found');
      }
    }

    // If type is being changed without updating payload, validate compatibility
    if (data.type && data.type !== existing.type && data.payload === undefined) {
      const existingPayloadType = (existing.payload as { type?: string } | null)?.type;

      if (existingPayloadType && existingPayloadType !== data.type) {
        throw new BadRequestError(
          `Cannot change question type from ${existing.type} to ${data.type} without updating payload. ` +
          `Existing payload is type ${existingPayloadType}.`
        );
      }
    }

    const normalizedPayload = data.payload !== undefined
      ? normalizePayload(data.payload, 'update')
      : undefined;

    // Validate new payload matches type
    if (normalizedPayload !== undefined) {
      const payloadType = (normalizedPayload as { type?: string } | null)?.type;
      const expectedType = data.type ?? existing.type;
      if (payloadType && payloadType !== expectedType) {
        throw new BadRequestError('Payload type must match question type');
      }
    }

    let updatedQuestion: QuestionWithPayload | null;

    // Use atomic update when payload is provided
    if (normalizedPayload !== undefined) {
      updatedQuestion = await questionsRepo.updateWithPayload(id, data, normalizedPayload);
    } else {
      // No payload update - just update question fields
      const question = await questionsRepo.update(id, data);
      if (!question) {
        throw new NotFoundError('Question not found');
      }
      // Fetch with payload for consistent return type
      updatedQuestion = await questionsRepo.getById(id);
    }

    if (!updatedQuestion) {
      throw new NotFoundError('Question not found');
    }

    invalidateCategoryCache();
    logger.debug({ questionId: id }, 'Updated question');

    if (userId) {
      const changedFields: string[] = [];
      if (data.categoryId && data.categoryId !== existing.category_id) changedFields.push('category');
      if (data.type && data.type !== existing.type) changedFields.push('type');
      if (data.difficulty && data.difficulty !== existing.difficulty) changedFields.push('difficulty');
      if (data.status && data.status !== existing.status) changedFields.push('status');
      if (data.prompt) changedFields.push('prompt');
      if (data.explanation) changedFields.push('explanation');
      if (data.payload !== undefined) changedFields.push('payload');

      logAudit({
        userId,
        action: 'update',
        entityType: 'question',
        entityId: id,
        metadata: {
          changed_fields: changedFields,
          title: getLocalizedString(updatedQuestion.prompt),
        },
      });
    }

    return updatedQuestion;
  },

  /**
   * Update question status only.
   */
  async updateStatus(id: string, status: Status, userId?: string): Promise<QuestionWithPayload> {
    // Check question exists + get old status for audit
    const existing = await questionsRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }
    const category = userId ? await categoriesRepo.getById(existing.category_id) : null;

    await questionsRepo.updateStatus(id, status);
    invalidateCategoryCache();

    logger.info({ questionId: id, status }, 'Updated question status');

    // Return with payload
    const updated = await questionsRepo.getById(id);
    if (!updated) {
      logger.error({ questionId: id }, 'Question not found after status update - possible race condition');
      throw new NotFoundError('Question not found after status update');
    }

    if (userId) {
      logAudit({
        userId,
        action: 'status_change',
        entityType: 'question',
        entityId: id,
        metadata: {
          old_status: existing.status,
          new_status: status,
          title: getLocalizedString(updated.prompt),
          type: updated.type,
          category_id: updated.category_id,
          category_name: category ? getLocalizedString(category.name) : null,
        },
      });
    }

    return updated;
  },

  /**
   * Delete a question.
   * Payload will be deleted via CASCADE.
   */
  async delete(id: string, userId?: string): Promise<DeleteQuestionResult> {
    // Fetch question details for audit before deleting
    const existing = await questionsRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }

    // Look up category name for audit before deleting
    const category = await categoriesRepo.getById(existing.category_id);

    logger.info(
      {
        questionId: id,
        userId: userId ?? null,
        categoryId: existing.category_id,
        categoryName: category ? getLocalizedString(category.name) : null,
        questionType: existing.type,
        questionStatus: existing.status,
      },
      'Attempting to delete question'
    );

    try {
      await questionsRepo.delete(id);
      invalidateCategoryCache();

      logger.info({ questionId: id }, 'Deleted question');

      if (userId) {
        logAudit({
          userId,
          action: 'delete',
          entityType: 'question',
          entityId: id,
          metadata: {
            title: getLocalizedString(existing.prompt),
            category_name: category ? getLocalizedString(category.name) : null,
          },
        });
      }

      return {
        action: 'deleted',
        entity_type: 'question',
        entity_id: id,
        message: 'Question deleted',
      };
    } catch (error) {
      if (error instanceof postgres.PostgresError && error.code === '23503') {
        logger.warn(
          {
            deleteTarget: 'question',
            dbCode: error.code,
            constraint: error.constraint_name ?? null,
            table: error.table_name ?? null,
            detail: error.detail ?? null,
            schema: error.schema_name ?? null,
          },
          'Question delete blocked by foreign key reference'
        );

        const archived = await questionsRepo.updateStatus(id, 'archived');
        if (!archived) {
          throw new NotFoundError('Question not found');
        }

        invalidateCategoryCache();

        logger.info(
          {
            questionId: id,
            previousStatus: existing.status,
            newStatus: 'archived',
          },
          'Archived question because delete was blocked by historical references'
        );

        if (userId) {
          logAudit({
            userId,
            action: 'status_change',
            entityType: 'question',
            entityId: id,
            metadata: {
              old_status: existing.status,
              new_status: 'archived',
              title: getLocalizedString(existing.prompt),
              type: existing.type,
              category_id: existing.category_id,
              category_name: category ? getLocalizedString(category.name) : null,
              reason: 'delete_blocked_by_history',
            },
          });
        }

        return {
          action: 'archived',
          entity_type: 'question',
          entity_id: id,
          message: 'Question was used in game history and has been archived instead of deleted',
        };
      }

      throw error;
    }
  },

  /**
   * Bulk create multiple questions in a single category.
   * Validates category once, then creates each question sequentially.
   * Handles partial failures - continues processing even if some questions fail.
   * Returns detailed results with success/failure counts and error details.
   *
   * Note: Processes questions sequentially (not batched) for:
   * - Better error reporting (per-question failures)
   * - Simpler transaction handling
   * - Acceptable performance for max 100 questions (~5-10s)
   * For higher throughput, consider batched SQL INSERT (see fixes-v3.md Issue #4).
   */
  async bulkCreate(
    categoryId: string,
    questions: Omit<CreateQuestionRequest, 'category_id'>[],
    createdBy?: string
  ): Promise<BulkCreateResponse> {
    // Validate category exists once
    const category = await categoriesRepo.getById(categoryId);
    if (!category) {
      throw new BadRequestError('Category not found');
    }

    const results: BulkCreateResponse = {
      total: questions.length,
      successful: 0,
      failed: 0,
      created: [],
      errors: [],
    };

    // Process each question sequentially
    for (let i = 0; i < questions.length; i++) {
      try {
        const normalizedPayload = normalizePayload(
          questions[i].payload as Json | undefined,
          `bulkCreate index ${i}`
        );
        const questionData: CreateQuestionData = {
          categoryId,
          type: questions[i].type,
          difficulty: questions[i].difficulty,
          status: questions[i].status || 'draft',
          prompt: questions[i].prompt,
          explanation: questions[i].explanation,
          createdBy,
        };

        const question = await questionsRepo.createWithPayload(
          questionData,
          normalizedPayload
        );

        results.created.push(toQuestionResponse(question));
        results.successful++;

        logger.debug(
          {
            questionId: question.id,
            categoryId,
            index: i,
          },
          'Question created in bulk upload'
        );
      } catch (error) {
        results.failed++;
        results.errors.push({
          index: i,
          question: questions[i],
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        logger.error(
          {
            error,
            index: i,
            categoryId,
          },
          'Failed to create question in bulk upload'
        );
      }
    }

    if (results.successful > 0) {
      invalidateCategoryCache();
    }

    logger.info(
      {
        total: results.total,
        successful: results.successful,
        failed: results.failed,
        categoryId,
      },
      'Bulk question upload completed'
    );

    if (createdBy) {
      logAudit({
        userId: createdBy,
        action: 'bulk_create',
        entityType: 'question',
        metadata: {
          category_name: getLocalizedString(category.name),
          category_id: categoryId,
          count: results.total,
          successful: results.successful,
          failed: results.failed,
        },
      });

      // Emit per-question create audits so the activity backfill query
      // (NOT EXISTS on entity_id) doesn't double-count bulk-created questions
      for (const created of results.created) {
        logAudit({
          userId: createdBy,
          action: 'create',
          entityType: 'question',
          entityId: created.id,
          metadata: {
            title: created.prompt?.en || created.prompt?.ka || created.type,
            type: created.type,
            category_name: getLocalizedString(category.name),
            category_id: categoryId,
            bulk_import: true,
          },
        });
      }
    }

    // Fire-and-forget: auto-translate newly created questions to Georgian
    if (results.successful > 0) {
      const createdIds = results.created.map((q) => q.id);
      translationService
        .translateInBackground(createdIds, categoryId)
        .catch((err) => logger.error({ error: err }, 'Background translation trigger failed'));
    }

    return results;
  },

  /**
   * Find duplicate questions based on identical prompts.
   * Uses SQL GROUP BY for efficient duplicate detection (scales to 100k+ questions).
   * Groups questions by normalized prompt text (case-insensitive, trimmed).
   * Returns groups of duplicates categorized by type:
   * - same_category: Same prompt in same category (likely copy/paste errors)
   * - cross_category: Same prompt across different categories
   */
  async findDuplicates(filters?: {
    type?: 'cross_category' | 'same_category' | 'all';
    categoryId?: string;
    includeDrafts?: boolean;
  }): Promise<DuplicatesResponse> {
    // Use SQL GROUP BY aggregation (efficient for large datasets)
    const listFilter: ListQuestionsFilter = {
      categoryId: filters?.categoryId,
      status: filters?.includeDrafts === false ? 'published' : undefined,
    };

    const duplicateGroups = await questionsRepo.findDuplicateGroups(listFilter);

    // Fetch full question details only for duplicates (not all questions)
    const allQuestionIds = duplicateGroups.flatMap(g => g.question_ids);

    // Batch fetch all duplicate questions in a single query (avoids N+1)
    // Returns Map for O(1) lookup by ID
    const questionMap = await questionsRepo.getByIds(allQuestionIds);

    // Build duplicate groups with full question data
    const groups: DuplicateGroup[] = [];

    for (const group of duplicateGroups) {
      const duplicateQuestions = group.question_ids
        .map(id => questionMap.get(id))
        .filter((q): q is QuestionWithPayload => q != null); // != null checks both null and undefined

      if (duplicateQuestions.length <= 1) continue;

      const categoryIds = [...new Set(group.category_ids)];
      const type: DuplicateType =
        categoryIds.length > 1 ? 'cross_category' : 'same_category';

      // Apply type filter
      if (filters?.type && filters.type !== 'all' && filters.type !== type) {
        continue;
      }

      // Generate unique ID for this duplicate group (hash of normalized prompt)
      const groupId = createHash('md5').update(group.normalized_prompt).digest('hex');

      // Use original prompt from first question for UI display (not the normalized lowercase version)
      const firstPromptObj = duplicateQuestions[0]?.prompt as { en?: string; [key: string]: string | undefined };
      const displayPrompt = firstPromptObj?.en || group.normalized_prompt;

      groups.push({
        id: groupId,
        type,
        prompt: displayPrompt,
        count: duplicateQuestions.length,
        questions: duplicateQuestions.map((q) => toQuestionResponse(q)),
        categories: [], // Will be enriched next
      });
    }

    // Enrich with category names
    const allCategoryIds = [...new Set(groups.flatMap((g) => g.questions.map((q) => q.category_id)))];
    const categories = await categoriesRepo.listByIds(allCategoryIds);
    const categoryMap = new Map(
      categories.map((c) => [c.id, c])
    );

    for (const group of groups) {
      const uniqueCategoryIds = [...new Set(group.questions.map((q) => q.category_id))];
      const categoryNames: CategorySummary[] = uniqueCategoryIds
        .map((id) => {
          const category = categoryMap.get(id);
          return category
            ? {
                id: category.id,
                name: getLocalizedString(category.name),
              }
            : null;
        })
        .filter((c): c is CategorySummary => c !== null);

      group.categories = categoryNames;
    }

    // Sort by priority: same_category first (highest priority), then by count
    groups.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'same_category' ? -1 : 1;
      }
      return b.count - a.count;
    });

    logger.info(
      {
        total_groups: groups.length,
        filters,
      },
      'Found duplicate questions'
    );

    return {
      total_groups: groups.length,
      groups,
    };
  },

  /**
   * Check if prompts already exist in the database (for bulk upload preview).
   * Used to detect duplicates before uploading questions.
   * Returns which prompts already exist, along with existing question details.
   */
  async checkDuplicates(
    prompts: Json[],
    locale = 'en'
  ): Promise<{
    duplicates: Array<{
      index: number;
      prompt: Json;
      existingQuestions: Array<{
        id: string;
        category_id: string;
        category_name: Json;
        created_at: string;
      }>;
    }>;
  }> {
    const hashText = (value: string): string =>
      createHash('sha256').update(value).digest('hex').slice(0, 12);

    logger.debug({ promptCount: prompts.length }, 'Checking duplicates for prompts');

    const getPromptValue = (promptObj: { [key: string]: string | undefined }) => {
      const preferred = promptObj[locale];
      if (preferred && preferred.trim()) return preferred;
      const fallback = Object.values(promptObj).find((value) => value && value.trim());
      return fallback ?? '';
    };

    // Log first few prompts for debugging (no raw content)
    const samplePrompts = prompts.slice(0, 3).map((p, i) => {
      const promptObj = p as { [key: string]: string | undefined };
      const normalized = getPromptValue(promptObj).toLowerCase().trim();
      return {
        index: i,
        promptLength: normalized.length,
        promptHash: normalized ? hashText(normalized) : null,
      };
    });
    logger.debug({ samplePrompts }, 'Sample prompts to check');

    const existingQuestions = await questionsRepo.findByPrompts(prompts, locale);

    logger.debug({
      existingQuestionsCount: existingQuestions.length,
      sampleExisting: existingQuestions.slice(0, 3).map(q => {
        const promptObj = q.prompt as { [key: string]: string | undefined };
        const normalized = getPromptValue(promptObj).toLowerCase().trim();
        return {
          id: q.id,
          promptLength: normalized.length,
          promptHash: normalized ? hashText(normalized) : null,
        };
      }),
    }, 'Found existing questions from database');

    // Group by normalized prompt
    const duplicateMap = new Map<string, typeof existingQuestions>();

    existingQuestions.forEach(q => {
      const promptObj = q.prompt as { [key: string]: string | undefined };
      const raw = getPromptValue(promptObj);
      const normalized = raw.toLowerCase().trim();
      if (!normalized) return;
      if (!duplicateMap.has(normalized)) {
        duplicateMap.set(normalized, []);
      }
      duplicateMap.get(normalized)!.push(q);
    });

    logger.debug({ duplicateMapSize: duplicateMap.size }, 'Built duplicate map');

    // Build response
    const duplicates = prompts
      .map((prompt, index) => {
        const promptObj = prompt as { [key: string]: string | undefined };
        const normalized = getPromptValue(promptObj).toLowerCase().trim();
        if (!normalized) return null;
        const existing = duplicateMap.get(normalized) || [];

        if (existing.length === 0) return null;

        return {
          index,
          prompt,
          existingQuestions: existing.map(q => ({
            id: q.id,
            category_id: q.category_id,
            // Intentionally return raw i18n JSON for CMS-side localization handling.
            category_name: q.category_name,
            created_at: q.created_at,
          })),
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    logger.debug({ duplicatesFound: duplicates.length }, 'Returning duplicate results');

    return { duplicates };
  },
};
