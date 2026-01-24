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
import { logger } from '../../core/logger.js';

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
  async create(data: CreateQuestionData & { payload?: Json }): Promise<QuestionWithPayload> {
    // Validate category exists
    const categoryExists = await categoriesRepo.exists(data.categoryId);
    if (!categoryExists) {
      throw new BadRequestError('Category not found');
    }

    // Create question with payload atomically
    const question = await questionsRepo.createWithPayload(data, data.payload);

    logger.info(
      { questionId: question.id, categoryId: data.categoryId, type: data.type },
      'Created new question'
    );

    return question;
  },

  /**
   * Update a question with optional payload update.
   * Validates category existence if category_id is being changed.
   */
  async update(
    id: string,
    data: UpdateQuestionData & { payload?: Json }
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

    if (data.payload !== undefined) {
      const payloadType = (data.payload as { type?: string } | null)?.type;
      const expectedType = data.type ?? existing.type;
      if (payloadType && payloadType !== expectedType) {
        throw new BadRequestError('Payload type must match question type');
      }
    }

    let updatedQuestion: QuestionWithPayload | null;

    // Use atomic update when payload is provided
    if (data.payload !== undefined) {
      updatedQuestion = await questionsRepo.updateWithPayload(id, data, data.payload);
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

    logger.debug({ questionId: id }, 'Updated question');

    return updatedQuestion;
  },

  /**
   * Update question status only.
   */
  async updateStatus(id: string, status: string): Promise<QuestionWithPayload> {
    // Check question exists
    const existing = await questionsRepo.exists(id);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }

    await questionsRepo.updateStatus(id, status);

    logger.info({ questionId: id, status }, 'Updated question status');

    // Return with payload
    return questionsRepo.getById(id) as Promise<QuestionWithPayload>;
  },

  /**
   * Delete a question.
   * Payload will be deleted via CASCADE.
   */
  async delete(id: string): Promise<void> {
    // Check question exists
    const existing = await questionsRepo.exists(id);
    if (!existing) {
      throw new NotFoundError('Question not found');
    }

    await questionsRepo.delete(id);

    logger.info({ questionId: id }, 'Deleted question');
  },
};
