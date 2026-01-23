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
   * Validates category existence.
   */
  async create(data: CreateQuestionData & { payload?: Json }): Promise<QuestionWithPayload> {
    // Validate category exists
    const categoryExists = await categoriesRepo.exists(data.categoryId);
    if (!categoryExists) {
      throw new BadRequestError('Category not found');
    }

    // Create question
    const question = await questionsRepo.create(data);

    // Create payload if provided
    if (data.payload) {
      await questionsRepo.createPayload(question.id, data.payload);
    }

    logger.info(
      { questionId: question.id, categoryId: data.categoryId, type: data.type },
      'Created new question'
    );

    // Return with payload
    return questionsRepo.getById(question.id) as Promise<QuestionWithPayload>;
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

    // Update question
    const question = await questionsRepo.update(id, data);

    if (!question) {
      throw new NotFoundError('Question not found');
    }

    // Update payload if provided
    if (data.payload !== undefined) {
      await questionsRepo.updatePayload(id, data.payload);
    }

    logger.debug({ questionId: id }, 'Updated question');

    // Return with payload
    return questionsRepo.getById(id) as Promise<QuestionWithPayload>;
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
