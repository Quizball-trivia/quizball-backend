import 'express-async-errors';
import { describe, it, expect, beforeAll, beforeEach, vi, Mock } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
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
    create: vi.fn(),
    createWithPayload: vi.fn(),
    createPayload: vi.fn(),
    update: vi.fn(),
    updatePayload: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  },
}));

// Mock the categories repo for validation
vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    exists: vi.fn(),
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
  requireRole: vi.fn(() => (req: any, _res: any, next: any) => {
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
      (categoriesRepo.exists as Mock).mockResolvedValue(true);
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

    it('should return 400 for invalid category_id', async () => {
      (categoriesRepo.exists as Mock).mockResolvedValue(false);

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
      (categoriesRepo.exists as Mock).mockResolvedValue(true);
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
      (questionsRepo.exists as Mock).mockResolvedValue(true);
      (questionsRepo.delete as Mock).mockResolvedValue(true);

      const response = await request(app).delete(
        `/api/v1/questions/${mockQuestion.id}`
      );

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent question', async () => {
      (questionsRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app).delete(
        '/api/v1/questions/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('PATCH /api/v1/questions/:id/status', () => {
    it('should update only status field', async () => {
      (questionsRepo.exists as Mock).mockResolvedValue(true);
      (questionsRepo.updateStatus as Mock).mockResolvedValue({
        ...mockQuestion,
        status: 'published',
      });
      (questionsRepo.getById as Mock).mockResolvedValue({
        ...mockQuestion,
        status: 'published',
      });

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
      (questionsRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app)
        .patch('/api/v1/questions/123e4567-e89b-12d3-a456-426614174999/status')
        .send({ status: 'published' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });
});
