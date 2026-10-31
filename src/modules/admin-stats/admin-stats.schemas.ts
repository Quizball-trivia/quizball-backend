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
