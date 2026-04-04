import { z } from 'zod';

const ymdRegex = /^\d{4}-\d{2}-\d{2}$/;

function isValidDateString(value: string): boolean {
  if (!ymdRegex.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const activityQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format'),
  user_id: z.string().uuid('Invalid user ID'),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export const activityByCategoryQuerySchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
  from: z.string()
    .regex(ymdRegex, 'Must be YYYY-MM-DD format')
    .refine(isValidDateString, 'Must be a valid calendar date'),
  to: z.string()
    .regex(ymdRegex, 'Must be YYYY-MM-DD format')
    .refine(isValidDateString, 'Must be a valid calendar date'),
}).superRefine(({ from, to }, ctx) => {
  if (from > to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['from'],
      message: '"from" date must be on or before "to" date',
    });
  }
});

export type ActivityByCategoryQuery = z.infer<typeof activityByCategoryQuerySchema>;

export const recentActivityQuerySchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export type RecentActivityQuery = z.infer<typeof recentActivityQuerySchema>;
