import {
  featuredCategoriesRepo,
  type CreateFeaturedCategoryData,
  type UpdateFeaturedCategoryData,
  type ReorderItem,
  type FeaturedCategoryWithCategory,
} from './featured-categories.repo.js';
import { categoriesRepo } from '../categories/categories.repo.js';
import { NotFoundError, ConflictError, BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

/**
 * Featured categories service.
 * Contains ALL business logic for featured category operations.
 * NO Express types (req/res). NO direct SQL calls.
 */
export const featuredCategoriesService = {
  /**
   * List all featured categories with joined category data.
   */
  async list(): Promise<FeaturedCategoryWithCategory[]> {
    return featuredCategoriesRepo.list();
  },

  /**
   * Get featured category by ID.
   * Throws NotFoundError if featured category doesn't exist.
   */
  async getById(id: string): Promise<FeaturedCategoryWithCategory> {
    const result = await featuredCategoriesRepo.getById(id);

    if (!result) {
      throw new NotFoundError('Featured category not found');
    }

    return result;
  },

  /**
   * Add a category to featured.
   * Validates category exists and isn't already featured.
   */
  async create(data: CreateFeaturedCategoryData): Promise<FeaturedCategoryWithCategory> {
    // Check category exists
    const categoryExists = await categoriesRepo.exists(data.categoryId);
    if (!categoryExists) {
      throw new BadRequestError('Category not found');
    }

    // Check category isn't already featured
    const existing = await featuredCategoriesRepo.getByCategoryId(data.categoryId);
    if (existing) {
      throw new ConflictError('Category is already featured');
    }

    const featured = await featuredCategoriesRepo.create(data);

    logger.info(
      { featuredId: featured.id, categoryId: data.categoryId },
      'Added category to featured'
    );

    // Fetch the full result with category data
    const result = await featuredCategoriesRepo.getById(featured.id);
    if (!result) {
      throw new NotFoundError('Featured category not found after creation');
    }

    return result;
  },

  /**
   * Update a featured category's sort_order.
   */
  async update(id: string, data: UpdateFeaturedCategoryData): Promise<FeaturedCategoryWithCategory> {
    // Check featured category exists
    const existing = await featuredCategoriesRepo.exists(id);
    if (!existing) {
      throw new NotFoundError('Featured category not found');
    }

    await featuredCategoriesRepo.update(id, data);

    logger.debug({ featuredId: id, sortOrder: data.sortOrder }, 'Updated featured category');

    // Fetch the full result with category data
    const result = await featuredCategoriesRepo.getById(id);
    if (!result) {
      throw new NotFoundError('Featured category not found after update');
    }

    return result;
  },

  /**
   * Remove a category from featured.
   */
  async delete(id: string): Promise<void> {
    // Check featured category exists
    const existing = await featuredCategoriesRepo.exists(id);
    if (!existing) {
      throw new NotFoundError('Featured category not found');
    }

    await featuredCategoriesRepo.delete(id);

    logger.info({ featuredId: id }, 'Removed category from featured');
  },

  /**
   * Bulk reorder featured categories.
   * Validates all IDs exist before updating.
   */
  async reorder(items: ReorderItem[]): Promise<FeaturedCategoryWithCategory[]> {
    if (items.length === 0) {
      throw new BadRequestError('Items array cannot be empty');
    }

    if (items.length > 100) {
      throw new BadRequestError('Cannot reorder more than 100 items at once');
    }

    // Validate all featured category IDs exist (single batched query)
    const ids = items.map((item) => item.id);
    const missingIds = await featuredCategoriesRepo.findMissingIds(ids);

    if (missingIds.length > 0) {
      throw new NotFoundError(`Featured categories not found: ${missingIds.join(', ')}`);
    }

    await featuredCategoriesRepo.reorder(items);

    logger.info({ itemCount: items.length }, 'Reordered featured categories');

    // Return updated list
    return featuredCategoriesRepo.list();
  },
};
