import 'express-async-errors';
import { describe, it, expect, beforeAll, beforeEach, vi, Mock } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import {
  requestIdMiddleware,
  errorHandler,
} from '../../src/http/middleware/index.js';
import { featuredCategoriesRoutes } from '../../src/http/routes/featured-categories.routes.js';
import '../setup.js';

// Mock the featured categories repo
vi.mock('../../src/modules/featured-categories/featured-categories.repo.js', () => ({
  featuredCategoriesRepo: {
    list: vi.fn(),
    getById: vi.fn(),
    getByCategoryId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
    reorder: vi.fn(),
    count: vi.fn(),
  },
}));

// Mock the categories repo
vi.mock('../../src/modules/categories/categories.repo.js', () => ({
  categoriesRepo: {
    exists: vi.fn(),
  },
}));

// Mock the auth middleware to allow testing protected routes
vi.mock('../../src/http/middleware/auth.js', () => ({
  authMiddleware: vi.fn((req, _res, next) => {
    req.user = { id: 'test-user-id' };
    req.identity = { provider: 'test', subject: 'test-sub' };
    next();
  }),
}));

import { featuredCategoriesRepo } from '../../src/modules/featured-categories/featured-categories.repo.js';
import { categoriesRepo } from '../../src/modules/categories/categories.repo.js';

const mockCategory = {
  id: '123e4567-e89b-12d3-a456-426614174001',
  slug: 'test-category',
  parent_id: null,
  name: { en: 'Test Category', ka: 'ტესტ კατეგორია' },
  description: { en: 'Test description' },
  icon: 'test-icon',
  image_url: 'https://example.com/image.png',
  is_active: true,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
};

const mockFeaturedCategory = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  category_id: mockCategory.id,
  sort_order: 0,
  created_at: '2024-01-01T00:00:00.000Z',
};

const mockFeaturedWithCategory = {
  featured: mockFeaturedCategory,
  category: mockCategory,
};

describe('Featured Categories API', () => {
  let app: Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/featured-categories', featuredCategoriesRoutes);
    app.use(errorHandler);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/featured-categories', () => {
    it('should return empty array when no featured categories', async () => {
      (featuredCategoriesRepo.list as Mock).mockResolvedValue([]);

      const response = await request(app).get('/api/v1/featured-categories');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('should return all featured categories sorted by sort_order', async () => {
      (featuredCategoriesRepo.list as Mock).mockResolvedValue([mockFeaturedWithCategory]);

      const response = await request(app).get('/api/v1/featured-categories');

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(mockFeaturedCategory.id);
      expect(response.body[0].category_id).toBe(mockCategory.id);
      expect(response.body[0].category.slug).toBe('test-category');
    });

    it('should include joined category data', async () => {
      (featuredCategoriesRepo.list as Mock).mockResolvedValue([mockFeaturedWithCategory]);

      const response = await request(app).get('/api/v1/featured-categories');

      expect(response.status).toBe(200);
      expect(response.body[0].category).toBeDefined();
      expect(response.body[0].category.name).toEqual({ en: 'Test Category', ka: 'ტესტ კატეგორია' });
    });
  });

  describe('GET /api/v1/featured-categories/:id', () => {
    it('should return featured category by id', async () => {
      (featuredCategoriesRepo.getById as Mock).mockResolvedValue(mockFeaturedWithCategory);

      const response = await request(app).get(
        `/api/v1/featured-categories/${mockFeaturedCategory.id}`
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(mockFeaturedCategory.id);
      expect(response.body.category.slug).toBe('test-category');
    });

    it('should return 404 for non-existent featured category', async () => {
      (featuredCategoriesRepo.getById as Mock).mockResolvedValue(null);

      const response = await request(app).get(
        '/api/v1/featured-categories/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 422 for invalid uuid', async () => {
      const response = await request(app).get('/api/v1/featured-categories/invalid-uuid');

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/v1/featured-categories', () => {
    it('should create featured category with valid data', async () => {
      (categoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(null);
      (featuredCategoriesRepo.create as Mock).mockResolvedValue(mockFeaturedCategory);
      (featuredCategoriesRepo.getById as Mock).mockResolvedValue(mockFeaturedWithCategory);

      const response = await request(app)
        .post('/api/v1/featured-categories')
        .send({
          category_id: mockCategory.id,
        });

      expect(response.status).toBe(201);
      expect(response.body.category_id).toBe(mockCategory.id);
    });

    it('should create featured category with custom sort_order', async () => {
      (categoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(null);
      (featuredCategoriesRepo.create as Mock).mockResolvedValue({
        ...mockFeaturedCategory,
        sort_order: 5,
      });
      (featuredCategoriesRepo.getById as Mock).mockResolvedValue({
        featured: { ...mockFeaturedCategory, sort_order: 5 },
        category: mockCategory,
      });

      const response = await request(app)
        .post('/api/v1/featured-categories')
        .send({
          category_id: mockCategory.id,
          sort_order: 5,
        });

      expect(response.status).toBe(201);
      expect(response.body.sort_order).toBe(5);
    });

    it('should return 400 for invalid category_id (category not found)', async () => {
      (categoriesRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app)
        .post('/api/v1/featured-categories')
        .send({
          category_id: '123e4567-e89b-12d3-a456-426614174999',
        });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('BAD_REQUEST');
    });

    it('should return 409 for duplicate category_id (already featured)', async () => {
      (categoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.getByCategoryId as Mock).mockResolvedValue(mockFeaturedCategory);

      const response = await request(app)
        .post('/api/v1/featured-categories')
        .send({
          category_id: mockCategory.id,
        });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe('CONFLICT');
    });

    it('should return 422 for invalid uuid in category_id', async () => {
      const response = await request(app)
        .post('/api/v1/featured-categories')
        .send({
          category_id: 'invalid-uuid',
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT /api/v1/featured-categories/:id', () => {
    it('should update featured category sort_order', async () => {
      (featuredCategoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.update as Mock).mockResolvedValue({
        ...mockFeaturedCategory,
        sort_order: 10,
      });
      (featuredCategoriesRepo.getById as Mock).mockResolvedValue({
        featured: { ...mockFeaturedCategory, sort_order: 10 },
        category: mockCategory,
      });

      const response = await request(app)
        .put(`/api/v1/featured-categories/${mockFeaturedCategory.id}`)
        .send({ sort_order: 10 });

      expect(response.status).toBe(200);
      expect(response.body.sort_order).toBe(10);
    });

    it('should return 404 for non-existent featured category', async () => {
      (featuredCategoriesRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app)
        .put('/api/v1/featured-categories/123e4567-e89b-12d3-a456-426614174999')
        .send({ sort_order: 10 });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 422 for invalid uuid', async () => {
      const response = await request(app)
        .put('/api/v1/featured-categories/invalid-uuid')
        .send({ sort_order: 10 });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for negative sort_order', async () => {
      const response = await request(app)
        .put(`/api/v1/featured-categories/${mockFeaturedCategory.id}`)
        .send({ sort_order: -1 });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/v1/featured-categories/:id', () => {
    it('should delete featured category', async () => {
      (featuredCategoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.delete as Mock).mockResolvedValue(true);

      const response = await request(app).delete(
        `/api/v1/featured-categories/${mockFeaturedCategory.id}`
      );

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent featured category', async () => {
      (featuredCategoriesRepo.exists as Mock).mockResolvedValue(false);

      const response = await request(app).delete(
        '/api/v1/featured-categories/123e4567-e89b-12d3-a456-426614174999'
      );

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 422 for invalid uuid', async () => {
      const response = await request(app).delete(
        '/api/v1/featured-categories/invalid-uuid'
      );

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('PUT /api/v1/featured-categories/reorder', () => {
    it('should reorder featured categories', async () => {
      const reorderItems = [
        { id: mockFeaturedCategory.id, sort_order: 1 },
        { id: '123e4567-e89b-12d3-a456-426614174002', sort_order: 0 },
      ];

      (featuredCategoriesRepo.exists as Mock).mockResolvedValue(true);
      (featuredCategoriesRepo.reorder as Mock).mockResolvedValue(undefined);
      (featuredCategoriesRepo.list as Mock).mockResolvedValue([
        mockFeaturedWithCategory,
        {
          featured: {
            id: '123e4567-e89b-12d3-a456-426614174002',
            category_id: '123e4567-e89b-12d3-a456-426614174003',
            sort_order: 0,
            created_at: '2024-01-01T00:00:00.000Z',
          },
          category: { ...mockCategory, id: '123e4567-e89b-12d3-a456-426614174003', slug: 'another-category' },
        },
      ]);

      const response = await request(app)
        .put('/api/v1/featured-categories/reorder')
        .send({ items: reorderItems });

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);
      expect(featuredCategoriesRepo.reorder).toHaveBeenCalled();
    });

    it('should return 404 if any item id does not exist', async () => {
      (featuredCategoriesRepo.exists as Mock)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const response = await request(app)
        .put('/api/v1/featured-categories/reorder')
        .send({
          items: [
            { id: mockFeaturedCategory.id, sort_order: 1 },
            { id: '123e4567-e89b-12d3-a456-426614174999', sort_order: 0 },
          ],
        });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('should return 422 for empty items array', async () => {
      const response = await request(app)
        .put('/api/v1/featured-categories/reorder')
        .send({ items: [] });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return 422 for invalid item format', async () => {
      const response = await request(app)
        .put('/api/v1/featured-categories/reorder')
        .send({
          items: [
            { id: 'invalid-uuid', sort_order: 0 },
          ],
        });

      expect(response.status).toBe(422);
      expect(response.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
