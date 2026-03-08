import type { Request, Response } from 'express';
import { questionsService } from './questions.service.js';
import { translationService } from './translation.service.js';
import {
  toQuestionResponse,
  toPaginatedResponse,
  type CreateQuestionRequest,
  type UpdateQuestionRequest,
  type UpdateStatusRequest,
  type ListQuestionsQuery,
  type UuidParam,
  type BulkCreateQuestionsRequest,
  type FindDuplicatesQuery,
  type CheckDuplicatesRequest,
} from './questions.schemas.js';
import type { Json } from '../../db/types.js';
import { logger } from '../../core/logger.js';

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

    const payloadSummary =
      typeof question.payload === 'string'
        ? `string:${question.payload.length}`
        : question.payload === null || question.payload === undefined
          ? 'null'
          : `json:${JSON.stringify(question.payload).length}`;

    logger.debug({
      msg: `GET /questions/${id}`,
      payloadType: typeof question.payload,
      payloadIsString: typeof question.payload === 'string',
      payloadSummary,
    });

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
      createdBy: req.user?.id,
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
    }, req.user?.id);

    res.json(toQuestionResponse(question));
  },

  /**
   * DELETE /api/v1/questions/:id
   * Delete a question.
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;

    await questionsService.delete(id, req.user?.id);

    res.status(204).send();
  },

  /**
   * PATCH /api/v1/questions/:id/status
   * Update question status only.
   */
  async updateStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.validated.params as UuidParam;
    const { status } = req.validated.body as UpdateStatusRequest;

    const question = await questionsService.updateStatus(id, status, req.user?.id);

    res.json(toQuestionResponse(question));
  },

  /**
   * POST /api/v1/questions/bulk
   * Bulk create multiple questions in a single category.
   */
  async bulkCreate(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as BulkCreateQuestionsRequest;

    const result = await questionsService.bulkCreate(
      data.category_id,
      data.questions,
      req.user?.id
    );

    // Return 207 for partial failures, 201 for full success
    const status = result.failed > 0 ? 207 : 201;
    res.status(status).json(result);
  },

  /**
   * GET /api/v1/questions/duplicates
   * Find duplicate questions based on identical prompts.
   */
  async findDuplicates(req: Request, res: Response): Promise<void> {
    const query = req.validated.query as FindDuplicatesQuery;

    const result = await questionsService.findDuplicates({
      type: query.type === 'all' ? undefined : query.type,
      categoryId: query.category_id,
      includeDrafts: query.include_drafts,
    });

    res.json(result);
  },

  /**
   * POST /api/v1/questions/check-duplicates
   * Check if prompts already exist in database (for bulk upload preview).
   */
  async checkDuplicates(req: Request, res: Response): Promise<void> {
    const { prompts, locale } = req.validated.body as CheckDuplicatesRequest;

    const result = await questionsService.checkDuplicates(prompts, locale);

    res.status(200).json(result);
  },

  /**
   * POST /api/v1/questions/translate/backfill
   * Translate all existing questions that have English but no Georgian.
   * Returns immediately with counts, translation runs in background.
   */
  async translateBackfill(_req: Request, res: Response): Promise<void> {
    const counts = await translationService.getBackfillCounts();

    if (counts.questions === 0 && counts.categories === 0) {
      res.json({ status: 'done', total: 0, remaining: 0, categories: 0 });
      return;
    }

    // Fire-and-forget — respond immediately, translate in background
    translationService
      .backfillAll()
      .then((result) => {
        logger.info(result, 'Backfill translation completed');
      })
      .catch((err) => {
        logger.error({ error: err }, 'Backfill translation failed');
      });

    res.json({
      status: 'started',
      total: counts.questions,
      remaining: counts.questions,
      categories: counts.categories,
    });
  },

  /**
   * GET /api/v1/questions/translate/status
   * Check translation progress.
   */
  async translateStatus(_req: Request, res: Response): Promise<void> {
    const counts = await translationService.getBackfillCounts();
    res.json(counts);
  },
};
