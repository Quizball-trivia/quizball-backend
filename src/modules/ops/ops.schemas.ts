import { z } from 'zod';

/**
 * Body for POST /api/v1/internal/ops/daily-report.
 * The scheduled report agent renders the morning digest and posts it here;
 * the backend relays it to Resend.
 */
export const dailyReportEmailSchema = z.object({
  to: z.union([
    z.string().email(),
    z.array(z.string().email()).min(1).max(10),
  ]),
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(500_000),
  text: z.string().max(500_000).optional(),
});

export type DailyReportEmailBody = z.infer<typeof dailyReportEmailSchema>;

/**
 * Query for GET /api/v1/internal/ops/clue-guesses.
 * Read surface over `clue_guess_evaluations` for the clue-rejection
 * root-cause session. At least one of questionId/userId/matchId is required so
 * the endpoint cannot be used to bulk-dump every guess players have typed.
 */
export const clueGuessQuerySchema = z.object({
  questionId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  matchId: z.string().uuid().optional(),
  rejectsOnly: z.enum(['true', 'false']).optional(),
  includeAi: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).refine(
  (value) => Boolean(value.questionId || value.userId || value.matchId),
  { message: 'One of questionId, userId or matchId is required' }
);

export type ClueGuessQuery = z.infer<typeof clueGuessQuerySchema>;
