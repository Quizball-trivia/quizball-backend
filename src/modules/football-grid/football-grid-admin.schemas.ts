import { z } from 'zod';

export const footballGridAdminMatchParamsSchema = z.object({ matchId: z.string().uuid() });
export const footballGridAdminCoinParamsSchema = z.object({ eventId: z.string().uuid() });
export const footballGridAdminReportParamsSchema = z.object({ reportId: z.string().uuid() });
export const footballGridAdminReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const footballGridAdminReportsQuerySchema = z.object({
  status: z.enum(['open', 'accepted', 'rejected', 'duplicate', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const footballGridAdminPlayerSearchSchema = z.object({
  q: z.string().trim().min(2).max(80),
});
export const footballGridAdminProposalCheckQuerySchema = z.object({
  playerId: z.string().uuid(),
});
const proposedNamesSchema = z.object({
  en: z.string().trim().min(2).max(160),
  ka: z.string().trim().min(2).max(160),
  es: z.string().trim().min(2).max(160),
  tr: z.string().trim().min(2).max(160),
});
export const footballGridAdminReportProposalSchema = z.object({
  playerId: z.string().uuid(),
  names: proposedNamesSchema,
  aliases: z.array(z.object({
    locale: z.enum(['en', 'ka', 'es', 'tr']),
    value: z.string().trim().min(2).max(160),
    acceptancePolicy: z.enum(['exact', 'unique_only', 'safe_typo']),
  })).min(4).max(40),
  evidenceUrl: z.string().url().max(1000).optional(),
  evidenceNote: z.string().trim().max(2000).optional(),
  reviewerNote: z.string().trim().max(2000).optional(),
}).superRefine((proposal, context) => {
  for (const locale of ['en', 'ka', 'es', 'tr']) {
    if (!proposal.aliases.some((alias) => alias.locale === locale)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aliases'],
        message: `Add at least one reviewed ${locale} spelling`,
      });
    }
  }
});
export type FootballGridAdminReportProposal = z.infer<typeof footballGridAdminReportProposalSchema>;
export const footballGridAdminReportDecisionSchema = z.object({
  status: z.enum(['accepted', 'rejected', 'duplicate', 'closed']),
  notes: z.string().trim().min(1).max(2_000),
  decisionReleaseId: z.string().uuid().nullable().optional(),
});

export const footballGridAdminQuarantineSchema = z.object({
  releaseId: z.string().uuid(),
  boardId: z.string().uuid().nullable().optional(),
  action: z.enum(['disable', 'enable']),
  reason: z.string().trim().min(3).max(500),
  expiresAt: z.string().datetime().nullable().optional(),
}).superRefine((value, context) => {
  if (value.action === 'enable' && value.expiresAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expiresAt'],
      message: 'Enable events cannot expire',
    });
  }
});

export const footballGridAdminQuarantinesQuerySchema = z.object({
  releaseId: z.string().uuid().optional(),
  boardId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const footballGridAdminPlayerParamsSchema = z.object({ playerId: z.string().uuid() });
export const footballGridAdminRenamePlayerSchema = z.object({
  nameEn: z.string().trim().min(1).max(120).optional(),
  nameKa: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().min(3).max(500),
}).refine((body) => body.nameEn !== undefined || body.nameKa !== undefined, {
  message: 'Provide nameEn and/or nameKa',
});
