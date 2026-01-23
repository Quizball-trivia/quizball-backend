import type { Category } from '../../db/types.js';
import {
  categoriesRepo,
  type CreateCategoryData,
  type UpdateCategoryData,
  type ListCategoriesFilter,
} from './categories.repo.js';
import { NotFoundError, ConflictError, BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * Categories service.
 * Contains ALL business logic for category operations.
 * NO Express types (req/res). NO direct SQL calls.
 */
export const categoriesService = {
  /**
   * List all categories with optional filters.
   */
  async list(filter?: ListCategoriesFilter): Promise<Category[]> {
    return categoriesRepo.list(filter);
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
  async create(data: CreateCategoryData): Promise<Category> {
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

    return category;
  },

  /**
   * Update a category.
   * Validates slug uniqueness, parent existence, and prevents self-referencing.
   */
  async update(id: string, data: UpdateCategoryData): Promise<Category> {
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

    logger.debug({ categoryId: id }, 'Updated category');

    return category;
  },

  /**
   * Delete a category.
   * Prevents deletion if category has children or questions.
   */
  async delete(id: string): Promise<void> {
    // Check category exists
    const existing = await categoriesRepo.getById(id);
    if (!existing) {
      throw new NotFoundError('Category not found');
    }

    // Check for children
    const hasChildren = await categoriesRepo.hasChildren(id);
    if (hasChildren) {
      throw new ConflictError('Cannot delete category with child categories');
    }

    // Check for questions
    const hasQuestions = await categoriesRepo.hasQuestions(id);
    if (hasQuestions) {
      throw new ConflictError('Cannot delete category with questions');
    }

    await categoriesRepo.delete(id);

    logger.info({ categoryId: id }, 'Deleted category');
  },
};
