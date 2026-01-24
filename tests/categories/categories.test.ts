import 'express-async-errors';
import { describe, it, expect, beforeAll, beforeEach, vi, Mock } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import { categoriesRoutes } from '../../src/http/routes/categories.routes.js';
import '../setup.js';

// Mock the categories repo
vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    list: vi.fn(),
    getById: vi.fn(),
    getBySlug: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    hasChildren: vi.fn(),
    hasQuestions: vi.fn(),
    exists: vi.fn(),
    getChildren: vi.fn(),
  },
}));

// Mock the questions repo
vi.mock('../../src/modules/questions/questions.repo.js', () => ({
  questionsRepo: {
    getByCategoryId: vi.fn(),
    deleteByCategoryId: vi.fn(),
  },
}));

// Mock the featured categories repo
vi.mock('../../src/modules/featured-categories/featured-categories.repo.js', () => ({
  featuredCategoriesRepo: {
    getByCategoryId: vi.fn(),
  },
}));

// Mock the auth middleware to allow testing protected routes
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

import { categoriesRepo } from '../../src/modules/categories/categories.repo.js';
import { questionsRepo } from '../../src/modules/questions/questions.repo.js';
import { featuredCategoriesRepo } from '../../src/modules/featured-categories/featured-categories.repo.js';

const mockCategory = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  slug: 'test-category',
  parent_id: null,
  name: { en: 'Test Category', ka: 'ტესტ კატეგორია' },
  description: { en: 'Test description' },
  icon: 'test-icon',
  image_url: 'https://example.com/image.png',
  is_active: true,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

describe('Categories API', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/categories', categoriesRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/categories', () => {
    it('should return empty array when no categories', async () => {
      (categoriesRepo.list as Mock).mockResolvedValue({ categories: [], total: 0 });

      const response = await request(app).get('/api/v1/categories');

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual([]);
      expect(response.body.total).toBe(0);
    });

    it('should return all categories with pagination', async () => {
      (categoriesRepo.list as Mock).mockResolvedValue({ categories: [mockCategory], total: 1 });

      const response = await request(app).get('/api/v1/categories');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].slug).toBe('test-category');
      expect(response.body.page).toBe(1);
      expect(response.body.limit).toBe(50);
      expect(response.body.total).toBe(1);
      expect(response.body.total_pages).toBe(1);
    });

    it('should filter by parent_id', async () => {
      const parentId = '123e4567-e89b-12d3-a456-426614174001';
      (categoriesRepo.list as Mock).mockResolvedValue({ categories: [mockCategory], total: 1 });

      const response = await request(app)
        .get('/api/v1/categories')
        .query({ parent_id: parentId });

      expect(response.status).toBe(200);
      expect(categoriesRepo.list).toHaveBeenCalledWith(
        {
          parentId: parentId,
          isActive: undefined,
        },
        1,
        50,
        undefined
      );
    });

    it('should filter by is_active', async () => {
      (categoriesRepo.list as Mock).mockResolvedValue({ categories: [mockCategory], total: 1 });

      const response = await request(app)
        .get('/api/v1/categories')
        .query({ is_active: 'true' });

      expect(response.status).toBe(200);
      expect(categoriesRepo.list).toHaveBeenCalledWith(
        {
          parentId: undefined,
          isActive: true,
        },
        1,
        50,
        undefined
      );
    });

    it('should support custom page and limit', async () => {
      (categoriesRepo.list as Mock).mockResolvedValue({ categories: [mockCategory], total: 100 });

      const response = await request(app)
        .get('/api/v1/categories')
        .query({ page: 2, limit: 10 });

      expect(response.status).toBe(200);
      expect(categoriesRepo.list).toHaveBeenCalledWith(
        {
          parentId: undefined,
          isActive: undefined,
        },
        2,
        10,
        undefined
      );
      expect(response.body.page).toBe(2);
      expect(response.body.limit).toBe(10);
      expect(response.body.total_pages).toBe(10);
    });
  });

  describe('GET /api/v1/categories/:id', () => {
    it('should return category by id', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);

      const response = await request(app).get(
        `/api/v1/categories/${mockCategory.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(mockCategory.id);
      expect(response.body.slug).toBe('test-category');
    });

    it('should return 404 for non-existent category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        '/api/v1/categories/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 422 for invalid uuid', async () => {
      const response = await request(app).get('/api/v1/categories/invalid-uuid');

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/categories', () => {
    it('should create category with valid data', async () => {
      (categoriesRepo.getBySlug as Mock).mockResolvedValue(null);
      (categoriesRepo.create as Mock).mockResolvedValue(mockCategory);

      const response = await request(app)
        .post('/api/v1/categories')
        .send({
          slug: 'new-category',
          name: { en: 'New Category' },
        });

      expect(response.status).toBe(201);
      expect(response.body.slug).toBe('test-category');
    });

    it('should return 422 for invalid slug format', async () => {
      const response = await request(app)
        .post('/api/v1/categories')
        .send({
          slug: 'Invalid Slug With Spaces',
          name: { en: 'Test' },
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 409 for duplicate slug', async () => {
      (categoriesRepo.getBySlug as Mock).mockResolvedValue(mockCategory);

      const response = await request(app)
        .post('/api/v1/categories')
        .send({
          slug: 'test-category',
          name: { en: 'Test' },
        });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('should return 400 for invalid parent_id', async () => {
      (categoriesRepo.getBySlug as Mock).mockResolvedValue(null);
      (categoriesRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app)
        .post('/api/v1/categories')
        .send({
          slug: 'new-category',
          name: { en: 'Test' },
          parent_id: '123e4567-e89b-12d3-a456-426614174999',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should handle i18n name field correctly', async () => {
      (categoriesRepo.getBySlug as Mock).mockResolvedValue(null);
      (categoriesRepo.create as Mock).mockResolvedValue({
        ...mockCategory,
        name: { en: 'English', ka: 'Georgian' },
      });

      const response = await request(app)
        .post('/api/v1/categories')
        .send({
          slug: 'i18n-test',
          name: { en: 'English', ka: 'Georgian' },
        });

      expect(response.status).toBe(201);
      expect(response.body.name).toEqual({ en: 'English', ka: 'Georgian' });
    });
  });

  describe('PUT /api/v1/categories/:id', () => {
    it('should update category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.update as Mock).mockResolvedValue({
        ...mockCategory,
        slug: 'updated-slug',
      });

      const response = await request(app)
        .put(`/api/v1/categories/${mockCategory.id}`)
        .send({ slug: 'updated-slug' });

      expect(response.status).toBe(200);
      expect(response.body.slug).toBe('updated-slug');
    });

    it('should return 404 for non-existent category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app)
        .put('/api/v1/categories/123e4567-e89b-12d3-a456-426614174999')
        .send({ slug: 'updated-slug' });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 409 for duplicate slug', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.getBySlug as Mock).mockResolvedValue({
        ...mockCategory,
        id: 'different-id',
      });

      const response = await request(app)
        .put(`/api/v1/categories/${mockCategory.id}`)
        .send({ slug: 'existing-slug' });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('should return 400 when setting self as parent', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);

      const response = await request(app)
        .put(`/api/v1/categories/${mockCategory.id}`)
        .send({ parent_id: mockCategory.id });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should allow partial updates', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.update as Mock).mockResolvedValue({
        ...mockCategory,
        is_active: false,
      });

      const response = await request(app)
        .put(`/api/v1/categories/${mockCategory.id}`)
        .send({ is_active: false });

      expect(response.status).toBe(200);
      expect(response.body.is_active).toBe(false);
    });
  });

  describe('DELETE /api/v1/categories/:id', () => {
    it('should delete category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.hasChildren as Mock).mockResolvedValue(false);
      (categoriesRepo.hasQuestions as Mock).mockResolvedValue(false);
      (categoriesRepo.delete as Mock).mockResolvedValue(true);

      const response = await request(app).delete(
        `/api/v1/categories/${mockCategory.id}`
      );

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent category', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).delete(
        '/api/v1/categories/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 409 when category has children', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.hasChildren as Mock).mockResolvedValue(true);

      const response = await request(app).delete(
        `/api/v1/categories/${mockCategory.id}`
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('should return 409 when category has questions', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.hasChildren as Mock).mockResolvedValue(false);
      (categoriesRepo.hasQuestions as Mock).mockResolvedValue(true);

      const response = await request(app).delete(
        `/api/v1/categories/${mockCategory.id}`
      );

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('should delete questions and category when cascade=true', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.hasChildren as Mock).mockResolvedValue(false);
      (questionsRepo.deleteByCategoryId as Mock).mockResolvedValue(3);
      (categoriesRepo.delete as Mock).mockResolvedValue(true);

      const response = await request(app)
        .delete(`/api/v1/categories/${mockCategory.id}?cascade=true`);

      expect(response.status).toBe(204);
      expect(questionsRepo.deleteByCategoryId).toHaveBeenCalledWith(mockCategory.id);
      expect(categoriesRepo.delete).toHaveBeenCalledWith(mockCategory.id);
    });

    it('should still block deletion with children even with cascade=true', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.hasChildren as Mock).mockResolvedValue(true);

      const response = await request(app)
        .delete(`/api/v1/categories/${mockCategory.id}?cascade=true`);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
      expect(response.body.message).toContain('child categories');
    });
  });

  describe('GET /api/v1/categories/:id/dependencies', () => {
    it('should return empty arrays when category has no dependencies', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.getChildren as Mock).mockResolvedValue([]);
      (questionsRepo.getByCategoryId as Mock).mockResolvedValue([]);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        `/api/v1/categories/${mockCategory.id}/dependencies`
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        children: [],
        questions: [],
        featured: false,
      });
    });

    it('should return children when category has child categories', async () => {
      const mockChildren = [
        { id: 'child-1', name: { en: 'Child 1' }, slug: 'child-1' },
        { id: 'child-2', name: { en: 'Child 2' }, slug: 'child-2' },
      ];
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.getChildren as Mock).mockResolvedValue(mockChildren);
      (questionsRepo.getByCategoryId as Mock).mockResolvedValue([]);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        `/api/v1/categories/${mockCategory.id}/dependencies`
      );

      expect(response.status).toBe(200);
      expect(response.body.children).toHaveLength(2);
      expect(response.body.children[0].slug).toBe('child-1');
    });

    it('should return questions when category has questions', async () => {
      const mockQuestions = [
        { id: 'q-1', prompt: { en: 'Question 1' }, type: 'mcq_single', difficulty: 'easy' },
        { id: 'q-2', prompt: { en: 'Question 2' }, type: 'input_text', difficulty: 'hard' },
      ];
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.getChildren as Mock).mockResolvedValue([]);
      (questionsRepo.getByCategoryId as Mock).mockResolvedValue(mockQuestions);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        `/api/v1/categories/${mockCategory.id}/dependencies`
      );

      expect(response.status).toBe(200);
      expect(response.body.questions).toHaveLength(2);
      expect(response.body.questions[0].type).toBe('mcq_single');
    });

    it('should return featured: true when category is featured', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(mockCategory);
      (categoriesRepo.getChildren as Mock).mockResolvedValue([]);
      (questionsRepo.getByCategoryId as Mock).mockResolvedValue([]);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue({
        id: 'fc-1',
        category_id: mockCategory.id,
        sort_order: 0,
        created_at: '2024-01-01T00:00:00.000Z',
      });

      const response = await request(app).get(
        `/api/v1/categories/${mockCategory.id}/dependencies`
      );

      expect(response.status).toBe(200);
      expect(response.body.featured).toBe(true);
    });

    it('should return 404 when category does not exist', async () => {
      (categoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        '/api/v1/categories/123e4567-e89b-12d3-a456-426614174999/dependencies'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });
  });
});
