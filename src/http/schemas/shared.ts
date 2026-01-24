import { z } from 'zod';

/**
 * Shared pagination query schema.
 * Use with .merge() in module-specific schemas.
 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Factory for paginated response schemas.
 */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: z.array(dataSchema),
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    total_pages: z.number(),
  });

/**
 * Generic paginated response type.
 */
export interface PaginatedResponse<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}
