import { z } from 'zod';

const matchId = z.string().uuid();
const commandId = z.string().uuid();
const expectedStateVersion = z.number().int().nonnegative();

export const footballGridSearchStartSchema = z
  .object({ locale: z.enum(['en', 'ka']).optional() })
  .optional()
  .transform((input) => ({ locale: input?.locale ?? 'en' as const }));

export const footballGridSearchCancelSchema = z.object({
  searchId: z.string().uuid(),
});

export const footballGridVersionedCommandSchema = z.object({
  matchId,
  commandId,
  expectedStateVersion,
});

export const footballGridSubmitAnswerSchema = footballGridVersionedCommandSchema.extend({
  cellIndex: z.number().int().min(0).max(8),
  text: z.string().trim().min(1).max(160),
  locale: z.enum(['en', 'ka']),
});

export const footballGridResyncSchema = z.object({ matchId });

export const footballGridCompletedAckSchema = z.object({
  matchId,
  terminalStateVersion: expectedStateVersion,
  ackToken: z.string().uuid(),
});

export const footballGridReportMissingAnswerSchema = z.object({
  attemptId: z.string().uuid(),
});

export const footballGridRematchAcceptSchema = z.object({
  matchId,
  commandId,
  expectedSeriesVersion: z.number().int().nonnegative(),
});

export const footballGridRematchDeclineSchema = z.object({
  matchId,
  expectedSeriesVersion: z.number().int().nonnegative(),
});

export type FootballGridSearchStartInput = z.infer<typeof footballGridSearchStartSchema>;
export type FootballGridVersionedCommandInput = z.infer<typeof footballGridVersionedCommandSchema>;
export type FootballGridSubmitAnswerInput = z.infer<typeof footballGridSubmitAnswerSchema>;
