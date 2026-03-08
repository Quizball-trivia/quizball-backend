import { z } from 'zod';

export const activityQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  user_id: z.string().uuid('Invalid user ID'),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const activityByCategoryQuerySchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
});

export type ActivityByCategoryQuery = z.infer<typeof activityByCategoryQuerySchema>;

export const recentActivityQuerySchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export type RecentActivityQuery = z.infer<typeof recentActivityQuerySchema>;
