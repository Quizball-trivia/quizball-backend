import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  paginationQuerySchema,
  paginatedResponseSchema,
} from '../../src/http/schemas/shared.js';
import '../setup.js';

describe('Shared Schemas', () => {
  describe('paginationQuerySchema', () => {
    it('should use default values when not provided', () => {
      const result = paginationQuerySchema.parse({});

      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('should coerce string values to numbers', () => {
      const result = paginationQuerySchema.parse({
        page: '3',
        limit: '25',
      });

      expect(result.page).toBe(3);
      expect(result.limit).toBe(25);
    });

    it('should accept valid page and limit', () => {
      const result = paginationQuerySchema.parse({
        page: 5,
        limit: 20,
      });

      expect(result.page).toBe(5);
      expect(result.limit).toBe(20);
    });

    it('should reject page less than 1', () => {
      const result = paginationQuerySchema.safeParse({
        page: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative page', () => {
      const result = paginationQuerySchema.safeParse({
        page: -1,
      });

      expect(result.success).toBe(false);
    });

    it('should reject limit less than 1', () => {
      const result = paginationQuerySchema.safeParse({
        limit: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject limit greater than 100', () => {
      const result = paginationQuerySchema.safeParse({
        limit: 101,
      });

      expect(result.success).toBe(false);
    });

    it('should accept limit at maximum (100)', () => {
      const result = paginationQuerySchema.parse({
        limit: 100,
      });

      expect(result.limit).toBe(100);
    });

    it('should reject non-integer page', () => {
      const result = paginationQuerySchema.safeParse({
        page: 1.5,
      });

      expect(result.success).toBe(false);
    });

    it('should reject non-integer limit', () => {
      const result = paginationQuerySchema.safeParse({
        limit: 10.5,
      });

      expect(result.success).toBe(false);
    });
  });

  describe('paginatedResponseSchema', () => {
    const itemSchema = z.object({
      id: z.string(),
      name: z.string(),
    });

    const responseSchema = paginatedResponseSchema(itemSchema);

    it('should validate correct paginated response', () => {
      const result = responseSchema.parse({
        data: [
          { id: '1', name: 'Item 1' },
          { id: '2', name: 'Item 2' },
        ],
        page: 1,
        limit: 20,
        total: 50,
        total_pages: 3,
      });

      expect(result.data).toHaveLength(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(50);
      expect(result.total_pages).toBe(3);
    });

    it('should accept empty data array', () => {
      const result = responseSchema.parse({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should reject invalid data items', () => {
      const result = responseSchema.safeParse({
        data: [{ id: '1' }], // missing name
        page: 1,
        limit: 20,
        total: 1,
        total_pages: 1,
      });

      expect(result.success).toBe(false);
    });

    it('should reject missing pagination fields', () => {
      const result = responseSchema.safeParse({
        data: [{ id: '1', name: 'Item 1' }],
        // missing page, limit, total, total_pages
      });

      expect(result.success).toBe(false);
    });

    it('should reject data that is not an array', () => {
      const result = responseSchema.safeParse({
        data: { id: '1', name: 'Item 1' },
        page: 1,
        limit: 20,
        total: 1,
        total_pages: 1,
      });

      expect(result.success).toBe(false);
    });

    it('should work with different data schemas', () => {
      const userSchema = z.object({
        id: z.string().uuid(),
        email: z.string().email(),
        role: z.enum(['admin', 'user']),
      });

      const userResponseSchema = paginatedResponseSchema(userSchema);

      const result = userResponseSchema.parse({
        data: [
          {
            id: '123e4567-e89b-12d3-a456-426614174000',
            email: 'test@example.com',
            role: 'admin',
          },
        ],
        page: 1,
        limit: 10,
        total: 1,
        total_pages: 1,
      });

      expect(result.data[0].role).toBe('admin');
    });

    it('should reject float values for page', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: 1.5,
        limit: 20,
        total: 0,
        total_pages: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject float values for limit', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: 1,
        limit: 20.5,
        total: 0,
        total_pages: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject float values for total', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: 1,
        limit: 20,
        total: 5.5,
        total_pages: 1,
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative page', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: -1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject zero page (must be positive)', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: 0,
        limit: 20,
        total: 0,
        total_pages: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative total', () => {
      const result = responseSchema.safeParse({
        data: [],
        page: 1,
        limit: 20,
        total: -1,
        total_pages: 0,
      });

      expect(result.success).toBe(false);
    });

    it('should allow zero for total and total_pages (nonnegative)', () => {
      const result = responseSchema.parse({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        total_pages: 0,
      });

      expect(result.total).toBe(0);
      expect(result.total_pages).toBe(0);
    });
  });

  describe('Schema integration with query strings', () => {
    it('should handle typical HTTP query string format', () => {
      // Simulating how Express parses query strings
      const queryParams = {
        page: '2',
        limit: '15',
      };

      const result = paginationQuerySchema.parse(queryParams);

      expect(result.page).toBe(2);
      expect(result.limit).toBe(15);
    });

    it('should handle missing query params with defaults', () => {
      // When query params are not present in URL
      const queryParams = {};

      const result = paginationQuerySchema.parse(queryParams);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });
  });
});
