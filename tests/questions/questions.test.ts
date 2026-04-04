import 'express-async-errors';
import { describe, it, expect, beforeAll, beforeEach, vi, Mock } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import postgres from 'postgres';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import { questionsRoutes } from '../../src/http/routes/questions.routes.js';
import '../setup.js';

// Mock the questions repo
vi.mock('../../src/modules/questions/questions.repo.js', () => ({
  questionsRepo: {
    list: vi.fn(),
    getById: vi.fn(),
    getByIds: vi.fn(),
    create: vi.fn(),
    createWithPayload: vi.fn(),
    createPayload: vi.fn(),
    update: vi.fn(),
    updateWithPayload: vi.fn(),
    updatePayload: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    findByPrompts: vi.fn(),
    findDuplicateGroups: vi.fn(),
  },
}));

// Mock the categories repo for validation
vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    getById: vi.fn(),
    exists: vi.fn(),
    listByIds: vi.fn(),
  },
}));

// Mock the auth middleware
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'test-user-id', role: 'admin' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

// Mock the requireRole middleware (passes through since we set admin role above)
vi.mock('../../src/http/middleware/require-role.js', () => ({
  requireRole: vi.fn(() => (_req: any, _res: any, next: any) => {
    // In tests, we assume the user has admin role
    next();
  }),
}));

import { questionsRepo } from '../../src/modules/questions/questions.repo.js';
import { categoriesRepo } from '../../src/modules/categories/categories.repo.js';

const mockMcqPayload = {
  type: 'mcq_single' as const,
  options: [
    { id: '11111111-1111-1111-1111-111111111111', text: { en: '2' }, is_correct: false },
    { id: '22222222-2222-2222-2222-222222222222', text: { en: '3' }, is_correct: false },
    { id: '33333333-3333-3333-3333-333333333333', text: { en: '4' }, is_correct: true },
    { id: '44444444-4444-4444-4444-444444444444', text: { en: '5' }, is_correct: false },
  ],
};

const mockTrueFalsePayload = {
  type: 'true_false' as const,
  options: [
    { id: 'true', text: { en: 'True' }, is_correct: true },
    { id: 'false', text: { en: 'False' }, is_correct: false },
  ],
};

const mockQuestion = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  category_id: '123e4567-e89b-12d3-a456-426614174001',
  type: 'mcq_single',
  difficulty: 'medium',
  status: 'draft',
  prompt: { en: 'What is 2+2?', ka: 'რა არის 2+2?' },
  explanation: { en: 'Basic math' },
  payload: mockMcqPayload,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

const mockCategory = {
  id: mockQuestion.category_id,
  name: { en: 'General Knowledge' },
};

describe('Questions API', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/questions', questionsRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/questions', () => {
    it('should return paginated results', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [mockQuestion],
        total: 1,
      });

      const response = await request(app).get('/api/v1/questions');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(20);
      expect(response.body.total).toBe(1);
      expect(response.body.total_pages).toBe(1);
    });

    it('should filter by category_id', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [mockQuestion],
        total: 1,
      });

      const categoryId = mockQuestion.category_id;
      const response = await request(app)
        .get('/api/v1/questions')
        .query({ category_id: categoryId });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId }),
        1,
        20
      );
    });

    it('should filter by status', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [],
        total: 0,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ status: 'published' });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'published' }),
        1,
        20
      );
    });

    it('should filter by difficulty', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [],
        total: 0,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ difficulty: 'hard' });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ difficulty: 'hard' }),
        1,
        20
      );
    });

    it('should filter by type', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [],
        total: 0,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ type: 'input_text' });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'input_text' }),
        1,
        20
      );
    });

    it('should search in prompt text', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [mockQuestion],
        total: 1,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ search: '2+2' });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: '2+2' }),
        1,
        20
      );
    });

    it('should respect page and limit params', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [],
        total: 100,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ page: '3', limit: '10' });

      expect(response.status).toBe(200);
      expect(questionsRepo.list).toHaveBeenCalledWith(
        expect.any(Object),
        3,
        10
      );
      expect(response.body.page).toBe(3);
      expect(response.body.limit).toBe(10);
    });

    it('should return correct total_pages calculation', async () => {
      (questionsRepo.list as Mock).mockResolvedValue({
        questions: [],
        total: 25,
      });

      const response = await request(app)
        .get('/api/v1/questions')
        .query({ limit: '10' });

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(25);
      expect(response.body.total_pages).toBe(3); // ceil(25/10)
    });
  });

  describe('GET /api/v1/questions/:id', () => {
    it('should return question with payload', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(mockQuestion);

      const response = await request(app).get(
        `/api/v1/questions/${mockQuestion.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(mockQuestion.id);
      expect(response.body.payload).toEqual(mockQuestion.payload);
    });

    it('should return 404 for non-existent question', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        '/api/v1/questions/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/questions', () => {
    it('should create question with payload', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock).mockResolvedValue(mockQuestion);

      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: mockQuestion.category_id,
          type: 'mcq_single',
          difficulty: 'medium',
          prompt: { en: 'Test question' },
          payload: mockMcqPayload,
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('mcq_single');
    });

    it('should create true_false question with payload', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock).mockResolvedValue({
        ...mockQuestion,
        type: 'true_false',
        payload: mockTrueFalsePayload,
      });

      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: mockQuestion.category_id,
          type: 'true_false',
          difficulty: 'easy',
          prompt: { en: 'Real Madrid has won more Champions League titles than any other club.' },
          payload: mockTrueFalsePayload,
        });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe('true_false');
      expect(response.body.payload.type).toBe('true_false');
    });

    it('should return 400 for invalid category_id', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: '123e4567-e89b-12d3-a456-426614174999',
          type: 'mcq_single',
          difficulty: 'easy',
          prompt: { en: 'Test' },
          payload: mockMcqPayload,
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should validate difficulty enum', async () => {
      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: mockQuestion.category_id,
          type: 'mcq_single',
          difficulty: 'invalid',
          prompt: { en: 'Test' },
          payload: mockMcqPayload,
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate type enum', async () => {
      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: mockQuestion.category_id,
          type: 'invalid_type',
          difficulty: 'easy',
          prompt: { en: 'Test' },
          payload: mockMcqPayload,
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should default status to draft', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock).mockResolvedValue({
        ...mockQuestion,
        status: 'draft',
      });

      const response = await request(app)
        .post('/api/v1/questions')
        .send({
          category_id: mockQuestion.category_id,
          type: 'mcq_single',
          difficulty: 'easy',
          prompt: { en: 'Test' },
          payload: mockMcqPayload,
        });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe('draft');
    });
  });

  describe('PUT /api/v1/questions/:id', () => {
    it('should update question and payload', async () => {
      (questionsRepo.getById as Mock)
        .mockResolvedValueOnce(mockQuestion) // exists check
        .mockResolvedValueOnce({ ...mockQuestion, difficulty: 'hard' }); // return updated
      (questionsRepo.update as Mock).mockResolvedValue({
        ...mockQuestion,
        difficulty: 'hard',
      });

      const response = await request(app)
        .put(`/api/v1/questions/${mockQuestion.id}`)
        .send({ difficulty: 'hard' });

      expect(response.status).toBe(200);
      expect(response.body.difficulty).toBe('hard');
    });

    it('should allow partial updates', async () => {
      (questionsRepo.getById as Mock)
        .mockResolvedValueOnce(mockQuestion)
        .mockResolvedValueOnce({ ...mockQuestion, status: 'published' });
      (questionsRepo.update as Mock).mockResolvedValue({
        ...mockQuestion,
        status: 'published',
      });

      const response = await request(app)
        .put(`/api/v1/questions/${mockQuestion.id}`)
        .send({ status: 'published' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('published');
    });

    it('should return 404 for non-existent question', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app)
        .put('/api/v1/questions/123e4567-e89b-12d3-a456-426614174999')
        .send({ difficulty: 'hard' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('DELETE /api/v1/questions/:id', () => {
    it('should delete question and cascade payload', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(mockQuestion);
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.delete as Mock).mockResolvedValue(undefined);

      const response = await request(app).delete(
        `/api/v1/questions/${mockQuestion.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        action: 'deleted',
        entity_type: 'question',
        entity_id: mockQuestion.id,
        message: 'Question deleted',
      });
    });

    it('should return 404 for non-existent question', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).delete(
        '/api/v1/questions/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should archive question when delete is blocked by history references', async () => {
      const foreignKeyError = Object.create(postgres.PostgresError.prototype) as postgres.PostgresError;
      foreignKeyError.code = '23503';
      foreignKeyError.message = 'violates foreign key constraint';

      (questionsRepo.getById as Mock).mockResolvedValue(mockQuestion);
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.delete as Mock).mockRejectedValue(foreignKeyError);
      (questionsRepo.updateStatus as Mock).mockResolvedValue({
        ...mockQuestion,
        status: 'archived',
      });

      const response = await request(app).delete(
        `/api/v1/questions/${mockQuestion.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        action: 'archived',
        entity_type: 'question',
        entity_id: mockQuestion.id,
        message: 'Question was used in game history and has been archived instead of deleted',
      });
      expect(questionsRepo.updateStatus).toHaveBeenCalledWith(mockQuestion.id, 'archived');
    });
  });

  describe('PATCH /api/v1/questions/:id/status', () => {
    it('should update only status field', async () => {
      (questionsRepo.getById as Mock)
        .mockResolvedValueOnce(mockQuestion)
        .mockResolvedValueOnce({
          ...mockQuestion,
          status: 'published',
        });
      (questionsRepo.updateStatus as Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .patch(`/api/v1/questions/${mockQuestion.id}/status`)
        .send({ status: 'published' });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('published');
      expect(questionsRepo.updateStatus).toHaveBeenCalledWith(
        mockQuestion.id,
        'published'
      );
    });

    it('should validate status enum', async () => {
      const response = await request(app)
        .patch(`/api/v1/questions/${mockQuestion.id}/status`)
        .send({ status: 'invalid_status' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for non-existent question', async () => {
      (questionsRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app)
        .patch('/api/v1/questions/123e4567-e89b-12d3-a456-426614174999/status')
        .send({ status: 'published' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/questions/bulk', () => {
    const bulkQuestions = [
      {
        type: 'mcq_single' as const,
        difficulty: 'easy' as const,
        prompt: { en: 'Question 1' },
        payload: mockMcqPayload,
      },
      {
        type: 'mcq_single' as const,
        difficulty: 'medium' as const,
        prompt: { en: 'Question 2' },
        payload: mockMcqPayload,
      },
    ];

    it('should create multiple questions successfully', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock)
        .mockResolvedValueOnce({
          ...mockQuestion,
          id: '11111111-1111-1111-1111-111111111111',
        })
        .mockResolvedValueOnce({
          ...mockQuestion,
          id: '22222222-2222-2222-2222-222222222222',
        });

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: bulkQuestions,
        });

      expect(response.status).toBe(201);
      expect(response.body.total).toBe(2);
      expect(response.body.successful).toBe(2);
      expect(response.body.failed).toBe(0);
      expect(response.body.created).toHaveLength(2);
      expect(response.body.errors).toHaveLength(0);
    });

    it('should handle partial failures', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock)
        .mockResolvedValueOnce({
          ...mockQuestion,
          id: '11111111-1111-1111-1111-111111111111',
        })
        .mockRejectedValueOnce(new Error('Database error'));

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: bulkQuestions,
        });

      expect(response.status).toBe(207);
      expect(response.body.total).toBe(2);
      expect(response.body.successful).toBe(1);
      expect(response.body.failed).toBe(1);
      expect(response.body.created).toHaveLength(1);
      expect(response.body.errors).toHaveLength(1);
      expect(response.body.errors[0].index).toBe(1);
      expect(response.body.errors[0].error).toBe('Database error');
    });

    it('should handle complete failure', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (questionsRepo.createWithPayload as Mock)
        .mockRejectedValueOnce(new Error('Database error'))
        .mockRejectedValueOnce(new Error('Database error'));

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: bulkQuestions,
        });

      expect(response.status).toBe(207);
      expect(response.body.successful).toBe(0);
      expect(response.body.failed).toBe(bulkQuestions.length);
      expect(response.body.created).toHaveLength(0);
      expect(response.body.errors).toHaveLength(bulkQuestions.length);
    });

    it('should return 400 for invalid category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: '123e4567-e89b-12d3-a456-426614174999',
          questions: bulkQuestions,
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should validate minimum 1 question', async () => {
      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: [],
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate maximum 100 questions', async () => {
      const tooManyQuestions = Array(101).fill(bulkQuestions[0]);

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: tooManyQuestions,
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate payload matches type', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);

      const response = await request(app)
        .post('/api/v1/questions/bulk')
        .send({
          category_id: mockQuestion.category_id,
          questions: [
            {
              type: 'input_text',
              difficulty: 'easy',
              prompt: { en: 'Test' },
              payload: mockMcqPayload, // Wrong type!
            },
          ],
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /api/v1/questions/duplicates', () => {
    const mockDuplicateGroups = [
      {
        normalized_prompt: 'what is paris?',
        question_ids: [
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          '33333333-3333-3333-3333-333333333333',
        ],
        category_ids: [
          '99999999-9999-9999-9999-999999999999',
          '88888888-8888-8888-8888-888888888888',
        ],
        count: 3,
      },
    ];

    const mockCategory = {
      id: '99999999-9999-9999-9999-999999999999',
      name: { en: 'Geography' },
    };

    it('should return duplicate groups', async () => {
      (questionsRepo.findDuplicateGroups as Mock).mockResolvedValue(mockDuplicateGroups);
      (questionsRepo.getByIds as Mock).mockResolvedValue(
        new Map([
          [
            '11111111-1111-1111-1111-111111111111',
            {
              ...mockQuestion,
              id: '11111111-1111-1111-1111-111111111111',
              category_id: '99999999-9999-9999-9999-999999999999',
            },
          ],
          [
            '22222222-2222-2222-2222-222222222222',
            {
              ...mockQuestion,
              id: '22222222-2222-2222-2222-222222222222',
              category_id: '88888888-8888-8888-8888-888888888888',
            },
          ],
          [
            '33333333-3333-3333-3333-333333333333',
            {
              ...mockQuestion,
              id: '33333333-3333-3333-3333-333333333333',
              category_id: '99999999-9999-9999-9999-999999999999',
            },
          ],
        ])
      );
      (categoriesRepo.listByIds as Mock).mockResolvedValue([mockCategory]);

      const response = await request(app).get('/api/v1/questions/duplicates');

      expect(response.status).toBe(200);
      expect(response.body.total_groups).toBe(1);
      expect(response.body.groups).toBeDefined();
      expect(Array.isArray(response.body.groups)).toBe(true);
    });

    it('should filter by type', async () => {
      // Mock returns both same-category and cross-category groups
      const mixedGroups = [
        {
          normalized_prompt: 'same category question',
          question_ids: [
            '11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
          ],
          category_ids: [
            '99999999-9999-9999-9999-999999999999',
            '99999999-9999-9999-9999-999999999999',
          ], // Same category
          count: 2,
        },
        {
          normalized_prompt: 'cross category question',
          question_ids: [
            '33333333-3333-3333-3333-333333333333',
            '44444444-4444-4444-4444-444444444444',
          ],
          category_ids: [
            '99999999-9999-9999-9999-999999999999',
            '88888888-8888-8888-8888-888888888888',
          ], // Different categories
          count: 2,
        },
      ];

      (questionsRepo.findDuplicateGroups as Mock).mockResolvedValue(mixedGroups);
      (questionsRepo.getByIds as Mock).mockResolvedValue(
        new Map([
          [
            '11111111-1111-1111-1111-111111111111',
            {
              ...mockQuestion,
              id: '11111111-1111-1111-1111-111111111111',
              category_id: '99999999-9999-9999-9999-999999999999',
            },
          ],
          [
            '22222222-2222-2222-2222-222222222222',
            {
              ...mockQuestion,
              id: '22222222-2222-2222-2222-222222222222',
              category_id: '99999999-9999-9999-9999-999999999999',
            },
          ],
          [
            '33333333-3333-3333-3333-333333333333',
            {
              ...mockQuestion,
              id: '33333333-3333-3333-3333-333333333333',
              category_id: '99999999-9999-9999-9999-999999999999',
            },
          ],
          [
            '44444444-4444-4444-4444-444444444444',
            {
              ...mockQuestion,
              id: '44444444-4444-4444-4444-444444444444',
              category_id: '88888888-8888-8888-8888-888888888888',
            },
          ],
        ])
      );
      (categoriesRepo.listByIds as Mock).mockResolvedValue([mockCategory]);

      const response = await request(app)
        .get('/api/v1/questions/duplicates')
        .query({ type: 'same_category' });

      expect(response.status).toBe(200);
      expect(questionsRepo.findDuplicateGroups).toHaveBeenCalled();

      // Assert only same_category groups in response
      expect(response.body.groups.every((g: any) => g.type === 'same_category')).toBe(true);
      expect(response.body.groups.some((g: any) => g.type === 'cross_category')).toBe(false);
    });

    it('should filter by category_id', async () => {
      (questionsRepo.findDuplicateGroups as Mock).mockResolvedValue([]);
      (questionsRepo.getByIds as Mock).mockResolvedValue(new Map());
      (categoriesRepo.listByIds as Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/v1/questions/duplicates')
        .query({ category_id: mockQuestion.category_id });

      expect(response.status).toBe(200);
      expect(questionsRepo.findDuplicateGroups).toHaveBeenCalledWith(
        expect.objectContaining({ categoryId: mockQuestion.category_id })
      );
    });

    it('should include/exclude drafts', async () => {
      (questionsRepo.findDuplicateGroups as Mock).mockResolvedValue([]);
      (questionsRepo.getByIds as Mock).mockResolvedValue(new Map());
      (categoriesRepo.listByIds as Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/v1/questions/duplicates')
        .query({ include_drafts: 'false' });

      expect(response.status).toBe(200);
      expect(questionsRepo.findDuplicateGroups).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'published' })
      );
    });

    it('should handle empty duplicate groups', async () => {
      (questionsRepo.findDuplicateGroups as Mock).mockResolvedValue([]);
      (questionsRepo.getByIds as Mock).mockResolvedValue(new Map());
      (categoriesRepo.listByIds as Mock).mockResolvedValue([]);

      const response = await request(app).get('/api/v1/questions/duplicates');

      expect(response.status).toBe(200);
      expect(response.body.total_groups).toBe(0);
      expect(response.body.groups).toHaveLength(0);
    });

    it('should validate type enum', async () => {
      const response = await request(app)
        .get('/api/v1/questions/duplicates')
        .query({ type: 'invalid_type' });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/questions/check-duplicates', () => {
    const mockPrompts = [
      { en: 'What is Paris?' },
      { en: 'What is London?' },
      { en: 'What is Rome?' },
    ];

    it('should check for duplicate prompts', async () => {
      const mockExistingQuestions = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          prompt: { en: 'What is Paris?' },
          category_id: '99999999-9999-9999-9999-999999999999',
          category_name: { en: 'Geography' },
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ];

      (questionsRepo.findByPrompts as Mock).mockResolvedValue(mockExistingQuestions);

      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: mockPrompts });

      expect(response.status).toBe(200);
      expect(response.body.duplicates).toBeDefined();
      expect(Array.isArray(response.body.duplicates)).toBe(true);
    });

    it('should return empty array when no duplicates', async () => {
      (questionsRepo.findByPrompts as Mock).mockResolvedValue([]);

      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: mockPrompts });

      expect(response.status).toBe(200);
      expect(response.body.duplicates).toHaveLength(0);
    });

    it('should include existing question details', async () => {
      const mockExistingQuestions = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          prompt: { en: 'What is Paris?' },
          category_id: '99999999-9999-9999-9999-999999999999',
          category_name: { en: 'Geography' },
          created_at: '2024-01-01T00:00:00.000Z',
        },
      ];

      (questionsRepo.findByPrompts as Mock).mockResolvedValue(mockExistingQuestions);

      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: mockPrompts });

      expect(response.status).toBe(200);
      expect(response.body.duplicates).toHaveLength(1);
      const duplicate = response.body.duplicates[0];
      expect(duplicate).toHaveProperty('index');
      expect(duplicate).toHaveProperty('prompt');
      expect(duplicate).toHaveProperty('existingQuestions');
      expect(duplicate.existingQuestions).toHaveLength(1);
      expect(duplicate.existingQuestions[0]).toHaveProperty('id');
      expect(duplicate.existingQuestions[0]).toHaveProperty('category_id');
      expect(duplicate.existingQuestions[0]).toHaveProperty('category_name');
      expect(duplicate.existingQuestions[0]).toHaveProperty('created_at');
    });

    it('should validate minimum 1 prompt', async () => {
      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: [] });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate maximum 100 prompts', async () => {
      const tooManyPrompts = Array(101).fill({ en: 'Test' });

      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: tooManyPrompts });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should validate prompt structure', async () => {
      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: ['invalid', 'structure'] });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should handle multiple duplicates for same prompt', async () => {
      const mockExistingQuestions = [
        {
          id: '11111111-1111-1111-1111-111111111111',
          prompt: { en: 'What is Paris?' },
          category_id: '99999999-9999-9999-9999-999999999999',
          category_name: { en: 'Geography' },
          created_at: '2024-01-01T00:00:00.000Z',
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          prompt: { en: 'What is Paris?' },
          category_id: '88888888-8888-8888-8888-888888888888',
          category_name: { en: 'History' },
          created_at: '2024-01-02T00:00:00.000Z',
        },
      ];

      (questionsRepo.findByPrompts as Mock).mockResolvedValue(mockExistingQuestions);

      const response = await request(app)
        .post('/api/v1/questions/check-duplicates')
        .send({ locale: 'en', prompts: [{ en: 'What is Paris?' }] });

      expect(response.status).toBe(200);
      expect(response.body.duplicates).toHaveLength(1);
      expect(response.body.duplicates[0].existingQuestions).toHaveLength(2);
    });
  });
});
