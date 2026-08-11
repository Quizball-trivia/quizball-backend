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

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

const PUBLIC_API_FALLBACK = 'https://quizball-backend-production.up.railway.app';

/** First configured secret strong enough to sign with (≥32 chars — a weak
 *  secret would let one recipient brute-force it offline from their own
 *  (userId, token) pair and forge opt-outs). */
function unsubSecret(): string | null {
  return [process.env.EMAIL_UNSUB_SECRET, config.SUPABASE_JWT_SECRET]
    .find((s) => s != null && s.length >= 32) ?? null;
}

export function emailUnsubToken(userId: string): string | null {
  const secret = unsubSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`email-unsub:${userId}`).digest('hex');
}

export function verifyEmailUnsubToken(userId: string, token: string): boolean {
  const expectedToken = emailUnsubToken(userId);
  if (!expectedToken) return false;
  const expected = Buffer.from(expectedToken, 'utf8');
  const given = Buffer.from(token, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(userId: string): string | null {
  const token = emailUnsubToken(userId);
  if (!token) return null;
  const base = config.API_BASE_URL ?? PUBLIC_API_FALLBACK;
  return `${base}/api/v1/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${token}`;
}

/** RFC 8058 one-click headers for marketing sends. */
export function marketingEmailHeaders(userId: string): Record<string, string> {
  const url = unsubscribeUrl(userId);
  if (!url) return {};
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  /** Stable per-logical-send key: the provider dedupes retries of the same
      send (crash between accept and our log write, timeout after accept). */
  idempotencyKey?: string;
  headers?: Record<string, string>;
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
        ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
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
