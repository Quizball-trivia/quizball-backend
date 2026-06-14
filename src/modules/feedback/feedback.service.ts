import { config } from '../../core/config.js';
import { ExternalServiceError, InternalError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { feedbackStorageService } from './feedback-storage.service.js';
import type { SubmitFeedbackBody } from './feedback.schemas.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const CATEGORY_LABEL: Record<SubmitFeedbackBody['category'], string> = {
  bug: '🐛 Bug report',
  feedback: '💬 Feedback',
  other: 'ℹ️ Info',
};

/** Extra context the route attaches about who submitted (when authenticated). */
export interface FeedbackSubmitter {
  userId?: string | null;
  username?: string | null;
  email?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const feedbackService = {
  /**
   * Email a player's contact/feedback submission to the support inbox via
   * Resend. Mirrors ops.service's transactional send — the Resend key lives
   * only in the backend.
   */
  async submit(input: SubmitFeedbackBody, submitter: FeedbackSubmitter): Promise<void> {
    if (!config.RESEND_API_KEY) {
      throw new InternalError('Email delivery is not configured (RESEND_API_KEY unset)');
    }

    // Upload any attachments first; the email carries links (not the bytes).
    let attachmentUrls: string[] = [];
    if (input.attachments && input.attachments.length > 0) {
      attachmentUrls = await feedbackStorageService.uploadAttachments(input.attachments);
    }

    const replyTo = input.email?.trim() || submitter.email?.trim() || undefined;
    const nickname = input.nickname?.trim() || submitter.username?.trim() || undefined;
    const subject = `[QuizBall] ${CATEGORY_LABEL[input.category]}`;

    const lines: string[] = [
      `<p><strong>Category:</strong> ${escapeHtml(CATEGORY_LABEL[input.category])}</p>`,
      `<p><strong>Message:</strong></p><p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`,
    ];
    if (nickname) lines.push(`<p><strong>Nickname:</strong> ${escapeHtml(nickname)}</p>`);
    if (replyTo) lines.push(`<p><strong>Reply-to:</strong> ${escapeHtml(replyTo)}</p>`);
    // Server-verified account, only when an authenticated request attached one.
    if (submitter.userId) {
      lines.push(
        `<p><strong>User:</strong> ${escapeHtml(submitter.username ?? '—')} (${escapeHtml(submitter.userId)})</p>`,
      );
    }
    if (input.context) lines.push(`<p><strong>Context:</strong> ${escapeHtml(input.context)}</p>`);
    if (attachmentUrls.length > 0) {
      const links = attachmentUrls
        .map((url, i) => `<a href="${escapeHtml(url)}">Attachment ${i + 1}</a>`)
        .join(' &middot; ');
      lines.push(`<p><strong>Attachments:</strong> ${links}</p>`);
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
          to: config.FEEDBACK_RECIPIENT_EMAIL,
          subject,
          html: lines.join('\n'),
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
    } catch (err) {
      logger.error({ err }, 'Resend request failed (network) for feedback');
      throw new ExternalServiceError('Failed to reach email provider');
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error({ status: response.status, detail }, 'Resend rejected feedback email');
      throw new ExternalServiceError('Email provider rejected the message');
    }

    logger.info(
      { category: input.category, userId: submitter.userId ?? null },
      'Feedback submission emailed',
    );
  },
};
