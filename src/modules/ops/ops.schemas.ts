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
