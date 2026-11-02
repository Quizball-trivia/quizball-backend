import { z } from 'zod';

const dayCountSchema = z.object({ day: z.string(), count: z.number().int() });

export const analyticsOverviewResponseSchema = z.object({
  totals: z.object({
    registered: z.number().int(),
    playingGuests: z.number().int(),
    totalUsers: z.number().int(),
    guestConversionPct30d: z.number(),
  }),
  actives: z.object({
    dau: z.number().int(),
    wau: z.number().int(),
    mau: z.number().int(),
  }),
  dauSeries: z.array(dayCountSchema),
  signupsPerDay: z.array(dayCountSchema),
  gamesPerDay: z.array(z.object({ day: z.string(), mode: z.string(), games: z.number().int() })),
  countries: z.array(z.object({
    country: z.string(),
    registered: z.number().int(),
    guests: z.number().int(),
    total: z.number().int(),
  })),
  generatedAt: z.string(),
  timezone: z.literal('Asia/Tbilisi'),
});

export type AnalyticsOverviewResponse = z.infer<typeof analyticsOverviewResponseSchema>;

export const personsQuerySchema = z.object({
  kind: z.enum(['registered', 'guest']).default('registered'),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type PersonsQuery = z.infer<typeof personsQuerySchema>;

export const personParamsSchema = z.object({
  kind: z.enum(['registered', 'guest']),
  id: z.string().uuid(),
});
export type PersonParams = z.infer<typeof personParamsSchema>;

export const personsResponseSchema = z.object({
  persons: z.array(z.object({
    id: z.string(),
    kind: z.enum(['registered', 'guest']),
    nickname: z.string().nullable(),
    email: z.string().nullable(),
    country: z.string().nullable(),
    createdAt: z.string(),
    coins: z.number().nullable(),
    converted: z.boolean(),
  })),
});
export type PersonsResponse = z.infer<typeof personsResponseSchema>;

export const personActivityResponseSchema = z.object({
  activity: z.array(z.object({
    at: z.string(),
    type: z.string(),
    meta: z.record(z.string(), z.unknown()),
  })),
});
export type PersonActivityResponse = z.infer<typeof personActivityResponseSchema>;
