import type { Request, Response } from 'express';
import { categoriesService } from './categories.service.js';
import {
  toCategoryResponse,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
  type ListCategoriesQuery,
  type UuidParam,
} from './categories.schemas.js';

/**
 * Categories controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const categoriesController = {
  /**
   * GET /api/v1/categories
   * List all categories with optional filters.
   */
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListCategoriesQuery;

    const categories = await categoriesService.list({
      parentId: query.parent_id,
      isActive: query.is_active,
    });

    res.json(categories.map(toCategoryResponse));
  },

  /**
   * GET /api/v1/categories/:id
   * Get a single category by ID.
   */
  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    const category = await categoriesService.getById(id);

    res.json(toCategoryResponse(category));
  },

  /**
   * POST /api/v1/categories
   * Create a new category.
   */
  async create(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as CreateCategoryRequest;

    const category = await categoriesService.create({
      slug: data.slug,
      parentId: data.parent_id,
      name: data.name,
      description: data.description,
      icon: data.icon,
      imageUrl: data.image_url,
      backgroundImgUrl: data.background_img_url,
      isActive: data.is_active,
    });

    res.status(201).json(toCategoryResponse(category));
  },

  /**
   * PUT /api/v1/categories/:id
   * Update a category.
   */
  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const data = req.validated.body as UpdateCategoryRequest;

    const category = await categoriesService.update(id, {
      slug: data.slug,
      parentId: data.parent_id,
      name: data.name,
      description: data.description,
      icon: data.icon,
      imageUrl: data.image_url,
      backgroundImgUrl: data.background_img_url,
      isActive: data.is_active,
    });

    res.json(toCategoryResponse(category));
  },

  /**
   * DELETE /api/v1/categories/:id
   * Delete a category.
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    await categoriesService.delete(id);

    res.status(204).send();
  },
};
