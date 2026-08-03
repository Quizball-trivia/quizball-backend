/**
 * Transactional email — minimal sender behind an env switch.
 *
 * RESEND_API_KEY set   → sends through the Resend HTTP API.
 * RESEND_API_KEY unset → disabled: callers get `false` and must NOT record
 *                        the send as done (so enabling the key later lets
 *                        still-relevant sends go out).
 *
 * EMAIL_FROM controls the sender identity (the domain must be verified with
 * the provider first, e.g. "Quizball <league@quizball.io>").
 */

import { config } from './config.js';
import { logger } from './logger.js';

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;
  const from = process.env.EMAIL_FROM ?? 'Quizball <league@quizball.io>';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, html: input.html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300), to: input.to }, 'Email send failed');
      return false;
    }
    return true;
  } catch (error) {
    logger.warn({ err: error, to: input.to }, 'Email send transport error');
    return false;
  }
}

// config import kept for future env plumbing consistency; avoids the module
// being env-read-order sensitive if EMAIL_* moves into validated config.
void config;
