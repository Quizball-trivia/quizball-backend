import type { Request, Response } from 'express';
import { categoriesService } from './categories.service.js';
import {
  toCategoryResponse,
  toDependenciesResponse,
  type CreateCategoryRequest,
  type UpdateCategoryRequest,
  type ListCategoriesQuery,
  type UuidParam,
  type DeleteCategoryQuery,
} from './categories.schemas.js';

/**
 * Categories controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const categoriesController = {
  /**
   * GET /api/v1/categories
   * List categories with pagination and optional filters.
   */
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListCategoriesQuery;

    const result = await categoriesService.list(
      {
        parentId: query.parent_id,
        isActive: query.is_active,
        minQuestions: query.min_questions,
      },
      query.page,
      query.limit
    );

    res.json({
      data: result.categories.map(toCategoryResponse),
      page: query.page,
      limit: query.limit,
      total: result.total,
      total_pages: Math.ceil(result.total / query.limit),
    });
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
      isActive: data.is_active,
      createdBy: req.user?.id,
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
      isActive: data.is_active,
    }, req.user?.id);

    res.json(toCategoryResponse(category));
  },

  /**
   * GET /api/v1/categories/:id/dependencies
   * Get category dependencies (children, questions, featured status).
   */
  async getDependencies(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    const dependencies = await categoriesService.getDependencies(id);

    res.json(toDependenciesResponse(dependencies));
  },

  /**
   * DELETE /api/v1/categories/:id
   * Delete a category.
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const query = req.validated.query as DeleteCategoryQuery | undefined;

    const result = await categoriesService.delete(id, { cascade: query?.cascade, userId: req.user?.id });

    res.status(200).json(result);
  },
};
