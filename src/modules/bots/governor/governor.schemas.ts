import { z } from 'zod';

/** Query for GET /api/v1/internal/bots/governor/telemetry. */
export const governorTelemetryQuerySchema = z.object({
  /** How many Georgia days of bot-vs-human history to return. */
  days: z.coerce.number().int().min(1).max(90).default(14),
});

export type GovernorTelemetryQuery = z.infer<typeof governorTelemetryQuerySchema>;
