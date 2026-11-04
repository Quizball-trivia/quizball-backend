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
    newPlayers: int, newGuests: int, returning: int,
    newRegistered: int, newRegisteredPlayed: int,
    signupPlatforms: z.object({ web: int, android: int, ios: int }),
  }),
  previous: z.object({ range, active: int, registered: int, guests: int, newGuests: int, newRegistered: int }).nullable(),
  countries: z.array(z.object({ country: z.string(), active: int, registered: int, guests: int, newRegistered: int })),
  games: z.array(z.object({ mode: z.string(), players: int, registered: int, guests: int, plays: int })),
  trend: z.array(z.object({ day: z.string(), active: int, registered: int, guests: int })),
  sources: audienceSourcesSchema,
  coverage: z.object({ firstDay: z.string().nullable(), lastDay: z.string().nullable(), refreshedAt: z.string().nullable() }),
  generatedAt: z.string(),
  timezone: z.literal('Asia/Tbilisi'),
});
export type AudienceResponse = z.infer<typeof audienceResponseSchema>;
