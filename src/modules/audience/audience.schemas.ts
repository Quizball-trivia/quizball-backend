import { z } from 'zod';

export const audiencePeriodSchema = z.enum(['today', 'yesterday', '7d', '30d']);
export type AudiencePeriod = z.infer<typeof audiencePeriodSchema>;

export const audienceQuerySchema = z.object({ period: audiencePeriodSchema.default('yesterday') });
export type AudienceQuery = z.infer<typeof audienceQuerySchema>;

const int = z.number().int();
const range = z.object({ from: z.string(), to: z.string() });
const keyed = z.array(z.object({ key: z.string(), people: int }));

export const audienceSourcesSchema = z.union([
  z.object({ connected: z.literal(false) }),
  z.object({ connected: z.literal(true), error: z.string() }),
  z.object({ connected: z.literal(true), newVisitors: int, referrers: keyed, landingPages: keyed, utmSources: keyed }),
]);
export type AudienceSources = z.infer<typeof audienceSourcesSchema>;

export const audienceResponseSchema = z.object({
  period: audiencePeriodSchema,
  range,
  partial: z.boolean(),
  summary: z.object({
    active: int, registered: int, guests: int, plays: int,
    // null until every day since coverage.start is final: first-time players cannot be told apart before that.
    newPlayers: int.nullable(), newGuests: int.nullable(), returning: int.nullable(),
    newRegistered: int, newRegisteredPlayed: int,
    signupPlatforms: z.object({ web: int, android: int, ios: int }),
  }),
  previous: z.object({ range, active: int, registered: int, guests: int, newGuests: int.nullable(), newRegistered: int }).nullable(),
  countries: z.array(z.object({ country: z.string(), active: int, registered: int, guests: int, newRegistered: int })),
  games: z.array(z.object({ mode: z.string(), players: int, registered: int, guests: int, plays: int })),
  trend: z.array(z.object({ day: z.string(), active: int, registered: int, guests: int, counted: z.boolean() })),
  sources: audienceSourcesSchema,
  coverage: z.object({
    start: z.string(), firstCompleteDay: z.string().nullable(), incompleteDays: int, historyComplete: z.boolean(),
    refreshedAt: z.string().nullable(),
  }),
  generatedAt: z.string(),
  timezone: z.literal('Asia/Tbilisi'),
});
export type AudienceResponse = z.infer<typeof audienceResponseSchema>;
