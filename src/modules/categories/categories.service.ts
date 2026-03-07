import type { Category, I18nField } from '../../db/types.js';
import {
  categoriesRepo,
  type CreateCategoryData,
  type UpdateCategoryData,
  type ListCategoriesFilter,
  type ListCategoriesResult,
} from './categories.repo.js';
import { questionsRepo } from '../questions/questions.repo.js';
import { featuredCategoriesRepo } from '../featured-categories/featured-categories.repo.js';
import { NotFoundError, ConflictError, BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { getLocalizedString } from '../../lib/localization.js';
import { logAudit } from '../activity/audit.js';

export interface CategoryDependencies {
  children: { id: string; name: I18nField; slug: string }[];
  questions: { id: string; prompt: I18nField; type: string; difficulty: string }[];
  featured: boolean;
}

/**
 * Categories service.
 * Contains ALL business logic for category operations.
 * NO Express types (req/res). NO direct SQL calls.
 */
export const categoriesService = {
  /**
   * List categories with pagination and optional filters.
   */
  async list(
    filter?: ListCategoriesFilter,
    page = 1,
    limit = 50,
    locale?: string
  ): Promise<ListCategoriesResult> {
    return categoriesRepo.list(filter, page, limit, locale);
  },

  /**
   * Get category by ID.
   * Throws NotFoundError if category doesn't exist.
   */
  async getById(id: string): Promise<Category> {
    const category = await categoriesRepo.getById(id);

    if (!category) {
      throw new NotFoundError('Category not found');
    }

    return category;
  },

  /**
   * Create a new category.
   * Validates slug uniqueness and parent existence.
   */
  async create(data: CreateCategoryData & { createdBy?: string }): Promise<Category> {
    // Check slug uniqueness
    const existingSlug = await categoriesRepo.getBySlug(data.slug);
    if (existingSlug) {
      throw new ConflictError('Category with this slug already exists');
    }

    // Validate parent exists if provided
    if (data.parentId) {
      const parentExists = await categoriesRepo.exists(data.parentId);
      if (!parentExists) {
        throw new BadRequestError('Parent category not found');
      }
    }

    const category = await categoriesRepo.create(data);

    logger.info({ categoryId: category.id, slug: data.slug }, 'Created new category');

    if (data.createdBy) {
      logAudit({
        userId: data.createdBy,
        action: 'create',
        entityType: 'category',
        entityId: category.id,
        metadata: {
          name: getLocalizedString(category.name),
          slug: data.slug,
        },
      });
    }

    return category;
  },

  /**
   * Update a category.
   * Validates slug uniqueness, parent existence, and prevents self-referencing.
   */
  async update(id: string, data: UpdateCategoryData, userId?: string): Promise<Category> {
    // Check category exists
    const existing = await categoriesRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Category not found');
    }

    // Check slug uniqueness if being changed
    if (data.slug && data.slug !== existing.slug) {
      const existingSlug = await categoriesRepo.getBySlug(data.slug);
      if (existingSlug) {
        throw new ConflictError('Category with this slug already exists');
      }
    }

    // Debug: log what we received
    logger.debug({ categoryId: id, updateData: data }, 'Updating category');

    // Prevent self-referencing parent
    if (data.parentId === id) {
      throw new BadRequestError('Category cannot be its own parent');
    }

    // Validate parent exists if provided
    if (data.parentId) {
      const parentExists = await categoriesRepo.exists(data.parentId);
      if (!parentExists) {
        throw new BadRequestError('Parent category not found');
      }
    }

    const category = await categoriesRepo.update(id, data);

    if (!category) {
      throw new NotFoundError('Category not found');
    }

    logger.info({ categoryId: id, newParentId: category.parent_id }, 'Updated category');

    if (userId) {
      const changedFields: string[] = [];
      if (data.slug && data.slug !== existing.slug) changedFields.push('slug');
      if (data.name) changedFields.push('name');
      if (data.description) changedFields.push('description');
      if (data.icon) changedFields.push('icon');
      if (data.imageUrl) changedFields.push('image_url');
      if (data.parentId !== undefined) changedFields.push('parent_id');
      if (data.isActive !== undefined && data.isActive !== existing.is_active) changedFields.push('is_active');

      logAudit({
        userId,
        action: 'update',
        entityType: 'category',
        entityId: id,
        metadata: {
          changed_fields: changedFields,
          name: getLocalizedString(category.name),
        },
      });
    }

    return category;
  },

  /**
   * Get dependencies for a category.
   * Returns children, questions, and featured status.
   */
  async getDependencies(id: string): Promise<CategoryDependencies> {
    const category = await categoriesRepo.getById(id);
    if (!category) {
      throw new NotFoundError('Category not found');
    }

    const [children, questions, featuredEntry] = await Promise.all([
      categoriesRepo.getChildren(id),
      questionsRepo.getByCategoryId(id),
      featuredCategoriesRepo.getByCategoryId(id),
    ]);

    return {
      children: children.map((c) => ({
        id: c.id,
        name: c.name as I18nField,
        slug: c.slug,
      })),
      questions: questions.map((q) => ({
        id: q.id,
        prompt: q.prompt as I18nField,
        type: q.type,
        difficulty: q.difficulty,
      })),
      featured: featuredEntry !== null,
    };
  },

  /**
   * Delete a category.
   * Prevents deletion if category has children or questions (unless cascade is true).
   */
  async delete(id: string, options?: { cascade?: boolean; userId?: string }): Promise<void> {
    // Check category exists
    const existing = await categoriesRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Category not found');
    }

    // Check for children - always blocked, even with cascade
    const hasChildren = await categoriesRepo.hasChildren(id);
    if (hasChildren) {
      throw new ConflictError('Cannot delete category with child categories');
    }

    // Handle cascade delete of questions
    let deletedQuestionCount = 0;
    if (options?.cascade) {
      deletedQuestionCount = await questionsRepo.deleteByCategoryId(id);
      if (deletedQuestionCount > 0) {
        logger.info({ categoryId: id, questionsDeleted: deletedQuestionCount }, 'Cascade deleted questions');
      }
    } else {
      // Check for questions only when not cascading
      const hasQuestions = await categoriesRepo.hasQuestions(id);
      if (hasQuestions) {
        throw new ConflictError('Cannot delete category with questions');
      }
    }

    await categoriesRepo.delete(id);

    logger.info({ categoryId: id, cascade: options?.cascade ?? false }, 'Deleted category');

    if (options?.userId) {
      logAudit({
        userId: options.userId,
        action: 'delete',
        entityType: 'category',
        entityId: id,
        metadata: {
          name: getLocalizedString(existing.name),
          cascade: options.cascade ?? false,
          deleted_questions: deletedQuestionCount,
        },
      });
    }
  },
};
