import { config } from '../../core/config.js';
import { ExternalServiceError, InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export interface DailyReportEmailInput {
  /** Recipient address(es). */
  to: string | string[];
  /** Subject line — the agent encodes severity here (e.g. "🚨 ISSUES FOUND ..."). */
  subject: string;
  /** Rendered HTML body of the report. */
  html: string;
  /** Optional plain-text fallback. */
  text?: string;
}

/**
 * Send the morning ops/health report via Resend.
 *
 * Best-effort transactional send: the Resend key lives only in the backend so
 * the scheduled report agent never holds it — the agent authenticates to our
 * endpoint with OPS_REPORT_TOKEN and we relay to Resend here.
 */
export const opsService = {
  async sendDailyReportEmail(input: DailyReportEmailInput): Promise<{ id: string }> {
    if (!config.RESEND_API_KEY) {
      throw new InternalError('Email delivery is not configured (RESEND_API_KEY unset)');
    }

    let response: Response;
    try {
      response = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.RESEND_FROM_EMAIL,
          to: input.to,
          subject: input.subject,
          html: input.html,
          ...(input.text ? { text: input.text } : {}),
        }),
      });
    } catch (err) {
      logger.error({ err }, 'Resend request failed (network)');
      throw new ExternalServiceError('Failed to reach email provider');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error(
        { status: response.status, detail },
        'Resend returned a non-OK response for daily report email'
      );
      throw new ExternalServiceError('Email provider rejected the message');
    }

    const body = (await response.json().catch(() => ({}))) as { id?: string };
    logger.info({ emailId: body.id, to: input.to }, 'Daily ops report email sent');
    return { id: body.id ?? 'unknown' };
  },
};
