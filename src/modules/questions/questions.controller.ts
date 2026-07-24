import type { Request, Response } from 'express';
import { questionsService } from './questions.service.js';
import { imageMcqService } from './image-mcq.service.js';
import { translationService } from './translation.service.js';
import { stagingSyncService } from './staging-sync.service.js';
import { AppError, ExternalServiceError, NotFoundError } from '../../core/errors.js';
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
  type SyncQuestionsToStagingRequest,
} from './questions.schemas.js';
import type {
  ImageMcqGeneratePreviewRequest,
  ImageMcqSaveDraftsRequest,
} from './image-mcq.schemas.js';
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
    const isAdmin = req.user?.role === 'admin';

    const { questions, total } = await questionsService.list(
      {
        categoryId: query.category_id,
        // The player clients need published payloads for the existing solo
        // game, but must never use this CMS route to enumerate drafts or run
        // the expensive admin-only search/image filters.
        status: isAdmin ? query.status : 'published',
        rankedEligible: isAdmin ? undefined : true,
        difficulty: query.difficulty,
        type: query.type,
        mcqImage: isAdmin ? query.mcq_image : undefined,
        search: isAdmin ? query.search : undefined,
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

    // Return 404 rather than revealing that a draft/archived question exists.
    if (
      req.user?.role !== 'admin'
      && (question.status !== 'published' || question.ranked_eligible === false)
    ) {
      throw new NotFoundError('Question not found');
    }

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

    const result = await questionsService.delete(id, req.user?.id);

    res.status(200).json(result);
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
   * POST /api/v1/questions/sync-staging
   * Copy selected prod questions and payloads into staging.
   */
  async syncQuestionsToStaging(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as SyncQuestionsToStagingRequest;
    const result = await stagingSyncService.syncQuestions(data.question_ids);
    res.status(200).json(result);
  },

  /**
   * POST /api/v1/questions/image-mcq/generate-preview
   * Generate image-backed MCQ review cards without creating questions.
   */
  async generateImageMcqPreview(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as ImageMcqGeneratePreviewRequest;
    const result = await imageMcqService.generatePreview(data);
    res.status(200).json(result);
  },

  /**
   * POST /api/v1/questions/image-mcq/generate-preview-stream
   * Generate image-backed MCQ review cards and stream progress as NDJSON.
   */
  async generateImageMcqPreviewStream(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as ImageMcqGeneratePreviewRequest;

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const writeEvent = (event: unknown) => {
      if (!res.writableEnded) {
        res.write(`${JSON.stringify(event)}\n`);
      }
    };

    try {
      const result = await imageMcqService.generatePreview(data, (event) => {
        writeEvent({ type: 'progress', ...event });
      });
      writeEvent({ type: 'done', data: result });
      res.end();
    } catch (error) {
      logger.error({ error }, 'Image MCQ streamed preview failed');
      writeEvent({
        type: 'error',
        error: {
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Image question generation failed',
          details: error instanceof AppError ? error.details : null,
          request_id: null,
        },
      });
      res.end();
    }
  },

  /**
   * POST /api/v1/questions/image-mcq/save-drafts
   * Upload accepted generated images and save accepted cards as draft questions.
   */
  async saveImageMcqDrafts(req: Request, res: Response): Promise<void> {
    const data = req.validated.body as ImageMcqSaveDraftsRequest;
    const result = await imageMcqService.saveDrafts(data.cards, req.user?.id, {
      translateToKa: data.translate_to_ka,
    });
    res.status(result.failed > 0 ? 207 : 201).json(result);
  },

  /**
   * POST /api/v1/questions/translate/backfill
   * Translate all existing questions that have English but no Georgian.
   * Returns immediately with counts, translation runs in background.
   */
  async translateBackfill(req: Request, res: Response): Promise<void> {
    const scope = (req.body as { scope?: string } | undefined)?.scope === 'agents' ? 'agents' : 'all';
    if (scope === 'agents') {
      if (!translationService.isConfigured()) {
        throw new ExternalServiceError('Translation is not configured. Set OPENROUTER_API_KEY.', {
          missing: ['OPENROUTER_API_KEY'],
        });
      }
      const ids = await translationService.agentUntranslatedIds();
      if (ids.length === 0) {
        res.json({ status: 'done', total: 0, remaining: 0, categories: 0 });
        return;
      }
      translationService
        .translateQuestions(ids)
        .then((result) => logger.info(result, 'Agent-scoped translation completed'))
        .catch((err) => logger.error({ error: err }, 'Agent-scoped translation failed'));
      res.json({ status: 'started', total: ids.length, remaining: ids.length, categories: 0 });
      return;
    }
    if (!translationService.isConfigured()) {
      logger.warn('Translation backfill rejected: OpenRouter API key not configured');
      throw new ExternalServiceError('Translation is not configured. Set OPENROUTER_API_KEY in Railway and redeploy before using Translate All.', {
        missing: ['OPENROUTER_API_KEY'],
      });
    }

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
   * POST /api/v1/questions/translate/redo-drafts
   * Wipe Georgian on DRAFT questions, then re-translate them from scratch.
   * Overwrites existing draft translations; live questions are untouched.
   */
  async translateRedoDrafts(_req: Request, res: Response): Promise<void> {
    if (!translationService.isConfigured()) {
      throw new ExternalServiceError('Translation is not configured. Set OPENROUTER_API_KEY.', {
        missing: ['OPENROUTER_API_KEY'],
      });
    }
    // Respond IMMEDIATELY — the wipe walks thousands of rows and used to run in
    // the request path, timing out the client while the server kept going.
    const counts = await translationService.getAgentBackfillCounts();
    if (counts.agentTotal === 0) {
      res.json({ status: 'done', total: 0, remaining: 0, categories: 0 });
      return;
    }
    translationService
      .clearDraftGeorgian()
      .then((ids) => translationService.translateQuestions(ids))
      .then((result) => logger.info(result, 'Agent re-translation completed'))
      .catch((err) => logger.error({ error: err }, 'Agent re-translation failed'));
    res.json({ status: 'started', total: counts.agentTotal, remaining: counts.agentTotal, categories: 0 });
  },

  /**
   * GET /api/v1/questions/translate/status
   * Check translation progress.
   */
  async translateStatus(req: Request, res: Response): Promise<void> {
    const counts =
      req.query.scope === 'agents'
        ? await translationService.getAgentBackfillCounts()
        : await translationService.getBackfillCounts();
    res.json(counts);
  },
};
