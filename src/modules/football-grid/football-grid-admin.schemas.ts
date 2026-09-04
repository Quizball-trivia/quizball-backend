import { z } from 'zod';

export const footballGridAdminMatchParamsSchema = z.object({ matchId: z.string().uuid() });
export const footballGridAdminCoinParamsSchema = z.object({ eventId: z.string().uuid() });
export const footballGridAdminReportParamsSchema = z.object({ reportId: z.string().uuid() });
export const footballGridAdminReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const footballGridAdminReportsQuerySchema = z.object({
  status: z.enum(['open', 'accepted', 'rejected', 'duplicate', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
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
