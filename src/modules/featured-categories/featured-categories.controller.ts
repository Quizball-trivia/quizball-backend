import type { Request, Response } from 'express';
import { featuredCategoriesService } from './featured-categories.service.js';
import {
  toFeaturedCategoryResponse,
  type CreateFeaturedCategoryRequest,
  type UpdateFeaturedCategoryRequest,
  type ReorderFeaturedCategoriesRequest,
  type UuidParam,
} from './featured-categories.schemas.js';

/**
 * Featured categories controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const featuredCategoriesController = {
  /**
   * GET /api/v1/featured-categories
   * List all featured categories with joined category data.
   */
  async list(_req: Request, res: Response): Promise<void> {
    const results = await featuredCategoriesService.list();

    res.json(
      results.map((r) => toFeaturedCategoryResponse(r.featured, r.category))
    );
  },

  /**
   * GET /api/v1/featured-categories/:id
   * Get a single featured category by ID.
   */
  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    const result = await featuredCategoriesService.getById(id);

    res.json(toFeaturedCategoryResponse(result.featured, result.category));
  },

  /**
   * POST /api/v1/featured-categories
   * Add a category to featured.
   */
  async create(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as CreateFeaturedCategoryRequest;

    const result = await featuredCategoriesService.create({
      categoryId: data.category_id,
      sortOrder: data.sort_order,
    });

    res.status(201).json(toFeaturedCategoryResponse(result.featured, result.category));
  },

  /**
   * PUT /api/v1/featured-categories/:id
   * Update a featured category's sort_order.
   */
  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const data = req.validated.body as UpdateFeaturedCategoryRequest;

    const result = await featuredCategoriesService.update(id, {
      sortOrder: data.sort_order,
    });

    res.json(toFeaturedCategoryResponse(result.featured, result.category));
  },

  /**
   * DELETE /api/v1/featured-categories/:id
   * Remove a category from featured.
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    await featuredCategoriesService.delete(id);

    res.status(204).send();
  },

  /**
   * PUT /api/v1/featured-categories/reorder
   * Bulk reorder featured categories.
   */
  async reorder(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as ReorderFeaturedCategoriesRequest;

    const results = await featuredCategoriesService.reorder(
      data.items.map((item) => ({
        id: item.id,
        sortOrder: item.sort_order,
      }))
    );

    res.json(
      results.map((r) => toFeaturedCategoryResponse(r.featured, r.category))
    );
  },
};
