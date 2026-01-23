import type { Request, Response } from 'express';
import { questionsService } from './questions.service.js';
import {
  toQuestionResponse,
  toPaginatedResponse,
  type CreateQuestionRequest,
  type UpdateQuestionRequest,
  type UpdateStatusRequest,
  type ListQuestionsQuery,
  type UuidParam,
} from './questions.schemas.js';
import type { Json } from '../../db/types.js';

/**
 * Questions controller.
 * Translates HTTP <-> Service calls. NO business logic.
 * Controllers read ONLY req.validated.* (never req.body directly).
 */
export const questionsController = {
  /**
   * GET /api/v1/questions
   * List questions with pagination and filters.
   */
  async list(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as ListQuestionsQuery;

    const { questions, total } = await questionsService.list(
      {
        categoryId: query.category_id,
        status: query.status,
        difficulty: query.difficulty,
        type: query.type,
        search: query.search,
      },
      query.page,
      query.limit
    );

    res.json(
      toPaginatedResponse(
        questions.map(toQuestionResponse),
        query.page,
        query.limit,
        total
      )
    );
  },

  /**
   * GET /api/v1/questions/:id
   * Get a single question by ID with payload.
   */
  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    const question = await questionsService.getById(id);

    res.json(toQuestionResponse(question));
  },

  /**
   * POST /api/v1/questions
   * Create a new question with optional payload.
   */
  async create(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as CreateQuestionRequest;

    const question = await questionsService.create({
      categoryId: data.category_id,
      type: data.type,
      difficulty: data.difficulty,
      status: data.status,
      prompt: data.prompt,
      explanation: data.explanation,
      payload: data.payload as Json,
    });

    res.status(201).json(toQuestionResponse(question));
  },

  /**
   * PUT /api/v1/questions/:id
   * Update a question with optional payload update.
   */
  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const data = req.validated.body as UpdateQuestionRequest;

    const question = await questionsService.update(id, {
      categoryId: data.category_id,
      type: data.type,
      difficulty: data.difficulty,
      status: data.status,
      prompt: data.prompt,
      explanation: data.explanation,
      payload: data.payload as Json,
    });

    res.json(toQuestionResponse(question));
  },

  /**
   * DELETE /api/v1/questions/:id
   * Delete a question.
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    await questionsService.delete(id);

    res.status(204).send();
  },

  /**
   * PATCH /api/v1/questions/:id/status
   * Update question status only.
   */
  async updateStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const { status } = req.validated.body as UpdateStatusRequest;

    const question = await questionsService.updateStatus(id, status);

    res.json(toQuestionResponse(question));
  },
};
