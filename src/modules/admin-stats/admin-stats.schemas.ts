import { z } from 'zod';

export const dailyTrendPointSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  signups: z.number().int().nonnegative(),
  dau: z.number().int().nonnegative(),
  matches: z.number().int().nonnegative(),
});

export const statsOverviewResponseSchema = z.object({
  totalUsers: z.number().int().nonnegative(),
  totalUsersExclPending: z.number().int().nonnegative(),
  onboardedUsers: z.number().int().nonnegative(),
  signupsToday: z.number().int().nonnegative(),
  signupsYesterday: z.number().int().nonnegative(),
  dauToday: z.number().int().nonnegative(),
  dauYesterday: z.number().int().nonnegative(),
  matchesToday: z.number().int().nonnegative(),
  matchesYesterday: z.number().int().nonnegative(),
  trend: z.array(dailyTrendPointSchema),
});

export type StatsOverviewResponse = z.infer<typeof statsOverviewResponseSchema>;
